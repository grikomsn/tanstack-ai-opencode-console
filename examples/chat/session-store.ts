/** Values are opaque: encryption and session validation belong to the caller. */
export interface SessionStore {
  read(sessionId: string, signal?: AbortSignal): Promise<string | undefined>;
  write(
    sessionId: string,
    value: string,
    ttlSeconds: number,
    signal?: AbortSignal,
  ): Promise<void>;
  delete(sessionId: string, signal?: AbortSignal): Promise<void>;
  /** Cancellation controls acquisition; an acquired operation finishes independently. */
  withLock<T>(
    sessionId: string,
    signal: AbortSignal | undefined,
    operation: (leaseSignal: AbortSignal) => Promise<T>,
  ): Promise<T>;
}

export class SessionStoreError extends Error {
  constructor(
    readonly code:
      "configuration" | "unavailable" | "lock_timeout" | "lease_lost",
    message: string,
  ) {
    super(message);
    this.name = "SessionStoreError";
  }
}

export interface RedisSessionStoreOptions {
  url: string;
  token: string;
  /** Use separate prefixes for Production and each Preview environment. */
  prefix: string;
  fetch?: typeof globalThis.fetch;
  lockWaitMs?: number;
  /** Must outlast the independent 90-second metadata-operation deadline. */
  lockLeaseSeconds?: number;
  requestTimeoutMs?: number;
}

const MAX_SESSION_TTL_SECONDS = 12 * 60 * 60;
const OPERATION_TIMEOUT_MS = 90_000;
const LOCK_RETRY_MS = 100;
// Intentionally use write-capable EVAL, not replica GET/EVAL_RO, for refresh state.
const READ_SESSION = 'return redis.call("GET", KEYS[1])';
const RELEASE_LOCK =
  'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end';

function configuredInteger(
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new SessionStoreError(
      "configuration",
      "Invalid session-store timing configuration.",
    );
  }
  return value;
}

function restRoot(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    ) {
      throw new Error();
    }
    return url.origin;
  } catch {
    throw new SessionStoreError(
      "configuration",
      "Session store requires an HTTPS REST root without credentials, path, query, or fragment.",
    );
  }
}

function sessionKey(
  prefix: string,
  kind: "session" | "lock",
  id: string,
): string {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new SessionStoreError(
      "configuration",
      "Invalid session-store identifier.",
    );
  }
  return `${prefix}:${kind}:${id}`;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Direct Upstash REST commands; the implementation has no process-local state. */
export function createRedisSessionStore(
  options: RedisSessionStoreOptions,
): SessionStore {
  const url = restRoot(options.url);
  const prefix = options.prefix;
  if (
    typeof prefix !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(prefix)
  ) {
    throw new SessionStoreError(
      "configuration",
      "Configure a separate session-store namespace.",
    );
  }
  let headers: Headers;
  try {
    if (typeof options.token !== "string" || !options.token.trim())
      throw new Error();
    headers = new Headers({
      Authorization: `Bearer ${options.token.trim()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    });
  } catch {
    // Native header errors can include the rejected token; never expose them.
    throw new SessionStoreError(
      "configuration",
      "Configure a valid session-store REST token.",
    );
  }
  const fetcher = options.fetch ?? globalThis.fetch;
  const lockWaitMs = configuredInteger(options.lockWaitMs ?? 10_000, 1, 60_000);
  const lockLeaseSeconds = configuredInteger(
    options.lockLeaseSeconds ?? 300,
    300,
    3600,
  );
  const requestTimeoutMs = configuredInteger(
    options.requestTimeoutMs ?? 10_000,
    1,
    30_000,
  );

  async function command(
    args: Array<string | number>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetcher(url, {
        method: "POST",
        headers: new Headers(headers),
        body: JSON.stringify(args),
        signal: requestSignal,
        redirect: "error",
        cache: "no-store",
      });
      requestSignal.throwIfAborted();
      if (!response.ok)
        throw new SessionStoreError(
          "unavailable",
          "Session store is unavailable.",
        );
      const payload: unknown = await response.json();
      requestSignal.throwIfAborted();
      if (
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        "error" in payload ||
        !("result" in payload)
      ) {
        throw new SessionStoreError(
          "unavailable",
          "Session store returned an invalid response.",
        );
      }
      return payload.result;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof SessionStoreError) throw error;
      // Do not expose upstream bodies or exceptions that can echo the REST token.
      throw new SessionStoreError(
        "unavailable",
        "Session store request failed.",
      );
    }
  }

  return {
    async read(id, signal) {
      const result = await command(
        ["EVAL", READ_SESSION, 1, sessionKey(prefix, "session", id)],
        signal,
      );
      if (result === null) return undefined;
      if (typeof result !== "string") {
        throw new SessionStoreError(
          "unavailable",
          "Session store returned an invalid value.",
        );
      }
      return result;
    },
    async write(id, value, ttlSeconds, signal) {
      if (typeof value !== "string") {
        throw new SessionStoreError(
          "configuration",
          "Session-store values must be opaque strings.",
        );
      }
      const ttl = configuredInteger(ttlSeconds, 1, MAX_SESSION_TTL_SECONDS);
      const result = await command(
        ["SET", sessionKey(prefix, "session", id), value, "EX", ttl],
        signal,
      );
      if (result !== "OK")
        throw new SessionStoreError(
          "unavailable",
          "Session store write failed.",
        );
    },
    async delete(id, signal) {
      const result = await command(
        ["DEL", sessionKey(prefix, "session", id)],
        signal,
      );
      if (result !== 0 && result !== 1) {
        throw new SessionStoreError(
          "unavailable",
          "Session store deletion failed.",
        );
      }
    },
    async withLock<T>(
      id: string,
      signal: AbortSignal | undefined,
      operation: (leaseSignal: AbortSignal) => Promise<T>,
    ) {
      signal?.throwIfAborted();
      const key = sessionKey(prefix, "lock", id);
      const owner = crypto.randomUUID();
      const deadline = AbortSignal.timeout(lockWaitMs);
      const acquisitionSignal = signal
        ? AbortSignal.any([signal, deadline])
        : deadline;
      let acquired = false;
      let ambiguousAcquisition = false;
      let succeeded = false;
      try {
        try {
          while (!acquired) {
            acquisitionSignal.throwIfAborted();
            ambiguousAcquisition = true;
            const result = await command(
              ["SET", key, owner, "NX", "EX", lockLeaseSeconds],
              acquisitionSignal,
            );
            ambiguousAcquisition = false;
            if (result === "OK") acquired = true;
            else if (result === null)
              await delay(LOCK_RETRY_MS, acquisitionSignal);
            else
              throw new SessionStoreError(
                "unavailable",
                "Session store lock acquisition failed.",
              );
          }
        } catch (error) {
          signal?.throwIfAborted();
          if (deadline.aborted) {
            throw new SessionStoreError(
              "lock_timeout",
              "Session is busy; try again shortly.",
            );
          }
          throw error;
        }
        // Browser disconnects must not interrupt refresh-token rotation/persistence.
        const leaseSignal = AbortSignal.timeout(OPERATION_TIMEOUT_MS);
        const value = await operation(leaseSignal);
        leaseSignal.throwIfAborted();
        succeeded = true;
        return value;
      } finally {
        if (acquired || ambiguousAcquisition) {
          try {
            // Cleanup must work even when the incoming request has been cancelled.
            const released = await command([
              "EVAL",
              RELEASE_LOCK,
              1,
              key,
              owner,
            ]);
            if (released !== 0 && released !== 1) {
              throw new SessionStoreError(
                "unavailable",
                "Session store lock release failed.",
              );
            }
            if (released === 0 && succeeded) {
              throw new SessionStoreError(
                "lease_lost",
                "Session lock expired; try again.",
              );
            }
          } catch (error) {
            // Preserve operation/acquisition errors; abandoned locks expire automatically.
            if (succeeded) throw error;
          }
        }
      }
    },
  };
}

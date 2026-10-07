import type { OpenCodeConsoleConfig } from "./types.js";
import { normalizeBaseURL } from "./routing.js";

/** Non-secret SDK placeholder: always removed before making a network call. */
export const SDK_PLACEHOLDER_KEY = "opencode-console-sdk-placeholder";

/** Native header errors may include their rejected value, including credentials. */
export function safeHeaders(input?: HeadersInit): Headers {
  try {
    return new Headers(input);
  } catch {
    throw new Error("OpenCode HTTP headers contain an invalid name or value.");
  }
}

function setSafeHeader(headers: Headers, name: string, value: string): void {
  try {
    headers.set(name, value);
  } catch {
    throw new Error("OpenCode HTTP headers contain an invalid name or value.");
  }
}

export function validateTransportConfig(
  config: Pick<
    OpenCodeConsoleConfig,
    "timeout" | "maxRetries" | "apiKey" | "session"
  >,
): void {
  if (config.apiKey !== undefined && config.session !== undefined) {
    throw new Error("Choose either apiKey or session authentication.");
  }
  if (
    config.timeout !== undefined &&
    (!Number.isInteger(config.timeout) ||
      config.timeout <= 0 ||
      config.timeout > 2_147_483_647)
  ) {
    throw new Error(
      "timeout must be an integer between 1 and 2147483647 milliseconds.",
    );
  }
  if (
    config.maxRetries !== undefined &&
    (!Number.isInteger(config.maxRetries) || config.maxRetries < 0)
  ) {
    throw new Error("maxRetries must be a non-negative integer.");
  }
}

async function resolveApiKey(
  config: Pick<OpenCodeConsoleConfig, "apiKey">,
): Promise<string | undefined> {
  const configured = config.apiKey;
  const key =
    typeof configured === "function"
      ? await configured()
      : (configured ??
        (typeof process !== "undefined"
          ? process.env.OPENCODE_API_KEY
          : undefined));
  if (key !== undefined && typeof key !== "string") {
    throw new Error(
      "The OpenCode API key supplier must return a string or undefined.",
    );
  }
  return key?.trim() || undefined;
}

/** All v2 protocols use Bearer auth, even when their native SDK uses a key header. */
export function createConsoleFetch(
  config: Pick<
    OpenCodeConsoleConfig,
    "apiKey" | "session" | "fetch" | "defaultHeaders" | "timeout" | "baseURL"
  >,
): typeof fetch {
  validateTransportConfig(config);
  config = {
    ...config,
    defaultHeaders: safeHeaders(config.defaultHeaders),
    session:
      typeof config.session === "object" && config.session !== null
        ? { ...config.session }
        : config.session,
  };
  const fetcher = config.fetch ?? globalThis.fetch;
  const root = new URL(`${normalizeBaseURL(config.baseURL)}/`);
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (
      url.origin !== root.origin ||
      !url.pathname.startsWith(root.pathname) ||
      url.username ||
      url.password
    ) {
      throw new Error(
        "OpenCode transport refused a request outside the configured inference root.",
      );
    }
    const originalSignal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const timeoutSignal = AbortSignal.timeout(config.timeout ?? 600_000);
    const signal = originalSignal
      ? AbortSignal.any([originalSignal, timeoutSignal])
      : timeoutSignal;
    signal.throwIfAborted();
    const headers = safeHeaders(
      input instanceof Request ? input.headers : undefined,
    );
    safeHeaders(init?.headers).forEach((value, key) =>
      setSafeHeader(headers, key, value),
    );
    safeHeaders(config.defaultHeaders).forEach((value, key) =>
      setSafeHeader(headers, key, value),
    );
    headers.delete("authorization");
    headers.delete("x-api-key");
    headers.delete("x-goog-api-key");
    const credential = await new Promise<{ token?: string; orgId?: string }>(
      (resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        const pending = (async () => {
          if (config.session !== undefined) {
            const session =
              typeof config.session === "function"
                ? await config.session(signal)
                : config.session;
            if (
              !session ||
              typeof session.accessToken !== "string" ||
              !session.accessToken.trim() ||
              typeof session.orgId !== "string" ||
              !session.orgId.trim()
            ) {
              throw new Error(
                "Session authentication requires an access token and organization ID.",
              );
            }
            return {
              token: session.accessToken.trim(),
              orgId: session.orgId.trim(),
            };
          }
          return { token: await resolveApiKey(config) };
        })();
        pending.then(
          (value) => {
            signal.removeEventListener("abort", onAbort);
            resolve(value);
          },
          (error: unknown) => {
            signal.removeEventListener("abort", onAbort);
            reject(error);
          },
        );
      },
    );
    if (credential.token)
      setSafeHeader(headers, "Authorization", `Bearer ${credential.token}`);
    if (config.session !== undefined) {
      headers.delete("x-org-id");
      headers.delete("x-opencode-org-id");
      setSafeHeader(headers, "x-org-id", credential.orgId!);
      setSafeHeader(headers, "x-opencode-org-id", credential.orgId!);
    }
    headers.set("x-opencode-client", "tanstack-ai-opencode-console");
    signal.throwIfAborted();
    return fetcher(input, { ...init, headers, signal, redirect: "error" });
  };
}

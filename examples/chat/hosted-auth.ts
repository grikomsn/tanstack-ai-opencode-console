import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  completeOpenCodeConsoleDeviceSignIn,
  createOpenCodeConsoleSessionAuth,
  refreshOpenCodeConsoleSession,
  requestOpenCodeConsoleDeviceCode,
} from "tanstack-ai-opencode-console/auth";
import type {
  OpenCodeConsoleDeviceCode,
  OpenCodeConsoleSession,
} from "tanstack-ai-opencode-console/auth";
import { publicAuthError, type ExampleAuthState } from "./auth.js";
import { HttpError } from "./chat-core.js";
import type { SessionStore } from "./session-store.js";

export const SESSION_COOKIE = "__Host-opencode-console";
const SESSION_SECONDS = 12 * 60 * 60;
interface StoredSession {
  version: 1;
  expiresAt: number;
  connectionRevision: string;
  phase: "signed-out" | "pending" | "error";
  device?: OpenCodeConsoleDeviceCode;
  nextPollAt?: number;
  session?: OpenCodeConsoleSession;
  error?: string;
}
interface HostedAuthOptions {
  store: SessionStore;
  secret: string;
  fetch?: typeof globalThis.fetch;
  authServer?: string;
}
class NextPoll extends Error {
  constructor(readonly milliseconds: number) {
    super("Wait for the next device poll.");
  }
}

export function sessionCookie(id: string, maxAge = SESSION_SECONDS): string {
  return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}
export function sessionId(request: Request): string | undefined {
  const matches = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((item) => item.trim())
    .filter((item) => item.startsWith(`${SESSION_COOKIE}=`));
  if (matches.length !== 1) return;
  const id = matches[0]!.slice(SESSION_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(id) ? id : undefined;
}

/** Shared storage holds authenticated ciphertext, bound to the opaque browser ID. */
export function createHostedAuth(options: HostedAuthOptions) {
  if (!/^[a-fA-F0-9]{64}$/.test(options.secret))
    throw new Error(
      "Configure a 32-byte hexadecimal session encryption secret.",
    );
  const key = Buffer.from(options.secret, "hex");
  function seal(id: string, value: StoredSession): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(id));
    const data = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
  }
  async function read(
    id: string,
    signal?: AbortSignal,
  ): Promise<StoredSession | undefined> {
    const encrypted = await options.store.read(id, signal);
    if (!encrypted) return;
    try {
      const data = Buffer.from(encrypted, "base64url");
      const cipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
      cipher.setAAD(Buffer.from(id));
      cipher.setAuthTag(data.subarray(12, 28));
      const value = JSON.parse(
        Buffer.concat([
          cipher.update(data.subarray(28)),
          cipher.final(),
        ]).toString("utf8"),
      ) as StoredSession;
      if (
        value.version !== 1 ||
        typeof value.connectionRevision !== "string" ||
        !Number.isFinite(value.expiresAt) ||
        value.expiresAt <= Date.now()
      )
        return;
      return value;
    } catch {
      return;
    }
  }
  async function write(id: string, value: StoredSession, signal: AbortSignal) {
    const ttl = Math.ceil((value.expiresAt - Date.now()) / 1000);
    if (ttl <= 0)
      throw new HttpError(
        401,
        "Your demo session expired. Reload and sign in again.",
      );
    await options.store.write(id, seal(id, value), ttl, signal);
  }
  function state(value?: StoredSession): ExampleAuthState {
    return {
      availableModes: ["session"],
      mode: "session",
      keyConfigured: false,
      connectionRevision: value?.connectionRevision ?? "signed-out",
      canChat: Boolean(value?.session?.orgId),
      statusPollIntervalMs: value?.device ? 1000 : 15_000,
      phase: value?.session
        ? value.session.orgId
          ? "signed-in"
          : "organization-required"
        : (value?.phase ?? "signed-out"),
      ...(value?.device
        ? {
            pending: {
              userCode: value.device.userCode,
              verificationUrl: value.device.verificationUrl,
              expiresAt: value.device.expiresAt,
            },
          }
        : {}),
      ...(value?.session
        ? {
            session: {
              account: { ...value.session.account },
              organizations: value.session.organizations.map((org) => ({
                ...org,
              })),
              ...(value.session.orgId ? { orgId: value.session.orgId } : {}),
              organizationLocked: Boolean(value.session.scopedOrgId),
            },
          }
        : {}),
      ...(value?.error ? { error: value.error } : {}),
    };
  }
  async function locked<T>(
    id: string,
    signal: AbortSignal,
    operation: (value: StoredSession, lease: AbortSignal) => Promise<T>,
  ) {
    return options.store.withLock(id, signal, async (lease) => {
      const value = await read(id, lease);
      if (!value)
        throw new HttpError(
          401,
          "Your demo session expired. Reload and sign in again.",
        );
      return operation(value, lease);
    });
  }
  return {
    async status(id: string | undefined, signal: AbortSignal) {
      if (!id || !(await read(id, signal))) {
        const nextId = randomBytes(32).toString("base64url");
        const value: StoredSession = {
          version: 1,
          expiresAt: Date.now() + SESSION_SECONDS * 1000,
          connectionRevision: randomUUID(),
          phase: "signed-out",
        };
        await options.store.withLock(nextId, signal, (lease) =>
          write(nextId, value, lease),
        );
        return {
          id: nextId,
          state: state(value),
          cookie: sessionCookie(nextId),
        };
      }
      const next = await locked(id, signal, async (value, lease) => {
        if (!value.device || (value.nextPollAt ?? 0) > Date.now())
          return state(value);
        const device = value.device;
        let waits = 0;
        try {
          value.session = await completeOpenCodeConsoleDeviceSignIn(device, {
            fetch: options.fetch,
            signal: lease,
            sleep: async (milliseconds) => {
              if (waits++ > 0) throw new NextPoll(milliseconds);
            },
          });
          value.device = undefined;
          value.nextPollAt = undefined;
          value.connectionRevision = randomUUID();
          value.error = undefined;
        } catch (cause) {
          if (cause instanceof NextPoll) {
            device.intervalMs = Math.max(1000, cause.milliseconds);
            value.nextPollAt = Date.now() + cause.milliseconds;
          } else {
            value.device = undefined;
            value.nextPollAt = undefined;
            value.phase = "error";
            value.error = publicAuthError(cause);
            value.connectionRevision = randomUUID();
          }
        }
        await write(id, value, lease);
        return state(value);
      });
      return { id, state: next };
    },
    async start(id: string, signal: AbortSignal) {
      return locked(id, signal, async (value, lease) => {
        value.session = undefined;
        value.device = undefined;
        value.nextPollAt = undefined;
        value.error = undefined;
        value.connectionRevision = randomUUID();
        value.phase = "signed-out";
        await write(id, value, lease);
        try {
          value.device = await requestOpenCodeConsoleDeviceCode({
            fetch: options.fetch,
            server: options.authServer,
            signal: lease,
          });
          value.nextPollAt = Date.now() + value.device.intervalMs;
          value.phase = "pending";
        } catch (cause) {
          value.phase = "error";
          value.error = publicAuthError(cause);
        }
        await write(id, value, lease);
        return state(value);
      });
    },
    async selectOrganization(id: string, orgId: string, signal: AbortSignal) {
      return locked(id, signal, async (value, lease) => {
        if (!value.session)
          throw new HttpError(401, "Sign in before choosing a workspace.");
        const supplier = createOpenCodeConsoleSessionAuth(value.session);
        try {
          supplier.selectOrganization(orgId);
        } catch {
          throw new HttpError(
            400,
            "Choose a workspace available to this Console session.",
          );
        }
        value.session = supplier.getSession();
        value.connectionRevision = randomUUID();
        await write(id, value, lease);
        return state(value);
      });
    },
    async logout(id: string | undefined, signal: AbortSignal) {
      if (id)
        await options.store.withLock(id, signal, (lease) =>
          options.store.delete(id, lease),
        );
      return state();
    },
    async getState(id: string, signal: AbortSignal) {
      return state(await read(id, signal));
    },
    async assertRevision(id: string, revision: string, signal: AbortSignal) {
      const value = await read(id, signal);
      if (!value || value.connectionRevision !== revision)
        throw new HttpError(
          409,
          "The Console connection changed. Wait for the connection panel to update, then try again.",
        );
    },
    async credentials(id: string, revision: string, signal: AbortSignal) {
      return locked(id, signal, async (value, lease) => {
        if (value.connectionRevision !== revision)
          throw new HttpError(
            409,
            "The Console connection changed. Reload the models and try again.",
          );
        if (!value.session?.orgId)
          throw new HttpError(
            401,
            "Sign in to Console and choose a workspace first.",
          );
        if (value.session.expiresAt <= Date.now() + 60_000) {
          try {
            value.session = await refreshOpenCodeConsoleSession(value.session, {
              fetch: options.fetch,
              signal: lease,
            });
          } catch {
            value.session = undefined;
            value.phase = "error";
            value.error =
              "Console session refresh failed. Start a new sign-in.";
            value.connectionRevision = randomUUID();
            await write(id, value, lease);
            throw new HttpError(401, value.error);
          }
          // Finish persistence even when the browser disconnects during token rotation.
          await write(id, value, lease);
        }
        signal.throwIfAborted();
        return {
          accessToken: value.session.accessToken,
          orgId: value.session.orgId!,
        };
      });
    },
  };
}

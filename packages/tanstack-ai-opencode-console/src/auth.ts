import type { OpenCodeConsoleSessionSupplier } from "./types.js";
import { safeHeaders } from "./transport.js";

export const OPENCODE_CONSOLE_AUTH_SERVER = "https://opencode.ai/console";
/** This adapter's own identity; it does not impersonate an OpenCode app. */
export const OPENCODE_CONSOLE_DEVICE_CLIENT_ID = "tanstack-ai-opencode-console";

export interface OpenCodeConsoleOrganization {
  id: string;
  name: string;
}

export interface OpenCodeConsoleDeviceCode {
  server: string;
  clientId: string;
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
  intervalMs: number;
}

export interface OpenCodeConsoleSession {
  server: string;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  account: { id: string; email: string };
  organizations: OpenCodeConsoleOrganization[];
  orgId?: string;
  /** Organization bound by the server's device grant; cannot be switched locally. */
  scopedOrgId?: string;
}

export interface OpenCodeConsoleAuthOptions {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

export type OpenCodeConsoleAuthStage =
  "authorization" | "token" | "account" | "organizations";

/** Safe protocol failure metadata; excludes response bodies and credentials. */
export class OpenCodeConsoleAuthError extends Error {
  constructor(
    readonly stage: OpenCodeConsoleAuthStage,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OpenCodeConsoleAuthError";
  }
}

const MAX_TIMER_MS = 2_147_483_647;

function serverURL(server: string): string {
  const url = new URL(server);
  if (
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Console auth server must be an HTTPS URL (HTTP is allowed on loopback only).",
    );
  }
  if (url.hostname === "console.opencode.ai") {
    url.hostname = "opencode.ai";
    if (url.pathname !== "/console" && !url.pathname.startsWith("/console/"))
      url.pathname = `/console${url.pathname}`;
  }
  return url.href.replace(/\/+$/, "");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Console returned an invalid authentication response.");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Console returned an incomplete authentication response.");
  }
  return value.trim();
}

function seconds(
  value: unknown,
  stage: OpenCodeConsoleAuthStage = "authorization",
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    !Number.isSafeInteger(value * 1000) ||
    value * 1000 > 8_640_000_000_000_000 - Date.now()
  ) {
    throw new OpenCodeConsoleAuthError(
      stage,
      "Console returned an invalid authentication lifetime.",
    );
  }
  return value * 1000;
}

async function request(
  server: string,
  path: string,
  options: OpenCodeConsoleAuthOptions,
  init: RequestInit,
): Promise<{ response: Response; signal: AbortSignal }> {
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  signal.throwIfAborted();
  const response = await (options.fetch ?? globalThis.fetch)(
    `${serverURL(server)}${path}`,
    {
      ...init,
      headers: safeHeaders(init.headers),
      signal,
      redirect: "error",
    },
  );
  signal.throwIfAborted();
  return { response, signal };
}

const jsonHeaders = {
  Accept: "application/json",
  "Content-Type": "application/json",
};

function tokenFields(value: Record<string, unknown>) {
  if (
    value.token_type !== undefined &&
    String(value.token_type).toLowerCase() !== "bearer"
  ) {
    throw new Error("Console returned an unsupported token type.");
  }
  return {
    accessToken: text(value.access_token),
    expiresAt: Date.now() + seconds(value.expires_in, "token"),
  };
}

async function responseJSON(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  try {
    const value: unknown = await response.json();
    signal.throwIfAborted();
    return value;
  } catch (error) {
    signal.throwIfAborted();
    if (
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    )
      throw error;
    throw new Error("Console returned invalid authentication JSON.");
  }
}

/** Start a fresh, explicit sign-in. No credential stores are inspected. */
export async function requestOpenCodeConsoleDeviceCode(
  options: OpenCodeConsoleAuthOptions & {
    server?: string;
    clientId?: string;
  } = {},
): Promise<OpenCodeConsoleDeviceCode> {
  const server = serverURL(options.server ?? OPENCODE_CONSOLE_AUTH_SERVER);
  const clientId = text(options.clientId ?? OPENCODE_CONSOLE_DEVICE_CLIENT_ID);
  const { response, signal } = await request(
    server,
    "/auth/device/code",
    options,
    {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ client_id: clientId, supports_org_scope: true }),
    },
  );
  if (!response.ok)
    throw new OpenCodeConsoleAuthError(
      "authorization",
      `Console device authorization failed (HTTP ${response.status}).`,
      response.status,
    );
  const value = record(await responseJSON(response, signal));
  const verification = new URL(
    text(value.verification_uri_complete ?? value.verification_uri),
    `${server}/`,
  );
  // Verification is user-facing, but do not send the user to an unrelated origin.
  const normalizedVerification = new URL(
    serverURL(`${verification.origin}${verification.pathname}`),
  );
  normalizedVerification.search = verification.search;
  if (
    normalizedVerification.origin !== new URL(server).origin ||
    verification.username ||
    verification.password
  ) {
    throw new Error(
      "Console returned a verification URL outside its auth server.",
    );
  }
  const intervalMs = Math.max(1000, seconds(value.interval ?? 5));
  if (intervalMs > MAX_TIMER_MS)
    throw new OpenCodeConsoleAuthError(
      "authorization",
      "Console returned an invalid polling interval.",
    );
  return {
    server,
    clientId,
    deviceCode: text(value.device_code),
    userCode: text(value.user_code),
    verificationUrl: normalizedVerification.href,
    expiresAt: Date.now() + seconds(value.expires_in),
    intervalMs,
  };
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** RFC 8628 polling, with pending/slow-down handling and cancellation. */
export async function completeOpenCodeConsoleDeviceSignIn(
  device: OpenCodeConsoleDeviceCode,
  options: OpenCodeConsoleAuthOptions & { sleep?: typeof wait } = {},
): Promise<OpenCodeConsoleSession> {
  let interval = device.intervalMs;
  if (
    !Number.isFinite(interval) ||
    interval < 1000 ||
    interval > MAX_TIMER_MS ||
    !Number.isFinite(device.expiresAt)
  )
    throw new Error("Invalid Console device code lifetime.");
  while (Date.now() < device.expiresAt) {
    await (options.sleep ?? wait)(
      Math.min(interval, device.expiresAt - Date.now()),
      options.signal,
    );
    options.signal?.throwIfAborted();
    if (Date.now() >= device.expiresAt) break;
    const { response, signal } = await request(
      device.server,
      "/auth/device/token",
      options,
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: device.deviceCode,
          client_id: device.clientId,
        }),
      },
    );
    const value = record(await responseJSON(response, signal));
    if (value.error === "authorization_pending") continue;
    if (value.error === "slow_down") {
      interval = Math.min(MAX_TIMER_MS, interval + 5000);
      continue;
    }
    if (value.error === "expired_token") break;
    if (value.error === "access_denied")
      throw new OpenCodeConsoleAuthError(
        "token",
        "Console sign-in was denied.",
      );
    if (!response.ok || value.error)
      throw new OpenCodeConsoleAuthError(
        "token",
        `Console token exchange failed (HTTP ${response.status}).`,
        response.status,
      );
    const tokens = tokenFields(value);
    const refreshToken = text(value.refresh_token);
    const get = async (
      path: string,
      stage: "account" | "organizations",
    ): Promise<unknown> => {
      const { response: result, signal: discoverySignal } = await request(
        device.server,
        path,
        options,
        {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${tokens.accessToken}`,
          },
        },
      );
      if (!result.ok)
        throw new OpenCodeConsoleAuthError(
          stage,
          `Console ${stage === "account" ? "account" : "organization"} discovery failed (HTTP ${result.status}).`,
          result.status,
        );
      return responseJSON(result, discoverySignal);
    };
    const [userRaw, orgsRaw] = await Promise.all([
      get("/api/user", "account"),
      get("/api/orgs", "organizations"),
    ]);
    const user = record(userRaw);
    if (!Array.isArray(orgsRaw))
      throw new Error("Console returned invalid organizations.");
    const organizations = orgsRaw.map((item) => {
      const org = record(item);
      return { id: text(org.id), name: text(org.name) };
    });
    const scopedOrgId =
      value.org_id === undefined ? undefined : text(value.org_id);
    if (scopedOrgId && !organizations.some((org) => org.id === scopedOrgId))
      throw new Error(
        "Console granted a session for an unavailable organization.",
      );
    const session: OpenCodeConsoleSession = {
      server: serverURL(device.server),
      clientId: device.clientId,
      ...tokens,
      refreshToken,
      account: { id: text(user.id), email: text(user.email) },
      organizations,
      ...(scopedOrgId
        ? { orgId: scopedOrgId, scopedOrgId }
        : organizations.length === 1
          ? { orgId: organizations[0]!.id }
          : {}),
    };
    return session;
  }
  throw new OpenCodeConsoleAuthError(
    "token",
    "Console device code expired; start sign-in again.",
  );
}

/** Refresh once; callers own persistence of the rotated refresh token. */
export async function refreshOpenCodeConsoleSession(
  session: OpenCodeConsoleSession,
  options: OpenCodeConsoleAuthOptions = {},
): Promise<OpenCodeConsoleSession> {
  const { response, signal } = await request(
    session.server,
    "/auth/device/token",
    options,
    {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: text(session.refreshToken),
        client_id: text(session.clientId),
      }),
    },
  );
  if (!response.ok)
    throw new Error(
      `Console session refresh failed (HTTP ${response.status}); sign in again.`,
    );
  const value = record(await responseJSON(response, signal));
  if (value.error)
    throw new Error("Console session refresh was rejected; sign in again.");
  const scopedOrgId =
    value.org_id === undefined ? session.scopedOrgId : text(value.org_id);
  if (session.scopedOrgId && scopedOrgId !== session.scopedOrgId)
    throw new Error(
      "Console refresh changed the session's organization scope.",
    );
  if (
    scopedOrgId &&
    !session.organizations.some((org) => org.id === scopedOrgId)
  )
    throw new Error(
      "Console refreshed a session for an unavailable organization.",
    );
  return {
    ...session,
    ...tokenFields(value),
    refreshToken:
      value.refresh_token === undefined
        ? session.refreshToken
        : text(value.refresh_token),
    ...(scopedOrgId ? { scopedOrgId, orgId: scopedOrgId } : {}),
  };
}

/** Revoke a refresh-token session through Console's advertised OAuth endpoint. */
export async function revokeOpenCodeConsoleSession(
  session: OpenCodeConsoleSession,
  options: OpenCodeConsoleAuthOptions = {},
): Promise<void> {
  const { response } = await request(
    session.server,
    "/auth/oauth/revoke",
    options,
    {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        token: text(session.refreshToken),
        token_type_hint: "refresh_token",
        client_id: text(session.clientId),
      }),
    },
  );
  if (!response.ok)
    throw new Error(
      `Console session revocation failed (HTTP ${response.status}).`,
    );
}

export interface OpenCodeConsoleSessionAuth extends OpenCodeConsoleSessionSupplier {
  getSession(): OpenCodeConsoleSession | undefined;
  selectOrganization(orgId: string): void;
  /** Clear this in-memory session; this does not revoke it at the server. */
  clear(): void;
  refresh(signal?: AbortSignal): Promise<OpenCodeConsoleSession>;
}

function copy(session: OpenCodeConsoleSession): OpenCodeConsoleSession {
  return {
    ...session,
    account: { ...session.account },
    organizations: session.organizations.map((org) => ({ ...org })),
  };
}

/** A per-session, in-memory supplier. Concurrent requests share one refresh. */
export function createOpenCodeConsoleSessionAuth(
  initialSession: OpenCodeConsoleSession,
  options: Pick<OpenCodeConsoleAuthOptions, "fetch"> = {},
): OpenCodeConsoleSessionAuth {
  text(initialSession.accessToken);
  text(initialSession.refreshToken);
  if (!Number.isFinite(initialSession.expiresAt))
    throw new Error("Invalid Console session lifetime.");
  if (
    initialSession.scopedOrgId &&
    initialSession.orgId !== initialSession.scopedOrgId
  )
    throw new Error(
      "Console session organization must match its granted scope.",
    );
  if (
    initialSession.orgId &&
    !initialSession.organizations.some((org) => org.id === initialSession.orgId)
  )
    throw new Error(
      "That organization is not available to this Console account.",
    );
  let current: OpenCodeConsoleSession | undefined = copy(initialSession);
  let pending: Promise<OpenCodeConsoleSession> | undefined;
  let controller: AbortController | undefined;
  const requireSession = () => {
    if (!current) throw new Error("Sign in to Console first.");
    return current;
  };
  const refresh = async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const snapshot = requireSession();
    if (!pending) {
      controller = new AbortController();
      pending = refreshOpenCodeConsoleSession(snapshot, {
        ...options,
        signal: controller.signal,
      })
        .then((next) => {
          if (!current)
            throw new Error("Console session was cleared during refresh.");
          current = { ...next, orgId: next.scopedOrgId ?? current.orgId };
          return copy(current);
        })
        .finally(() => {
          pending = undefined;
          controller = undefined;
        });
    }
    // A caller's cancellation must not cancel refresh for other requests.
    const shared = pending;
    if (!signal) return shared.then(copy);
    return new Promise<OpenCodeConsoleSession>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      // A custom fetch can cancel this caller synchronously during setup.
      if (signal.aborted) onAbort();
      shared.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          if (signal.aborted) reject(signal.reason);
          else resolve(copy(value));
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  };
  const supplier = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!requireSession().orgId)
      throw new Error("Select a Console organization before inference.");
    if (requireSession().expiresAt <= Date.now() + 60_000)
      await refresh(signal);
    signal.throwIfAborted();
    const session = requireSession();
    return { accessToken: session.accessToken, orgId: session.orgId! };
  };
  return Object.assign(supplier, {
    getSession: () => (current ? copy(current) : undefined),
    selectOrganization: (orgId: string) => {
      const session = requireSession();
      if (session.scopedOrgId && orgId !== session.scopedOrgId)
        throw new Error(
          "This Console session is scoped to another organization; sign in again to switch.",
        );
      if (!session.organizations.some((org) => org.id === orgId))
        throw new Error(
          "That organization is not available to this Console account.",
        );
      current = { ...session, orgId };
    },
    clear: () => {
      current = undefined;
      controller?.abort();
    },
    refresh,
  });
}

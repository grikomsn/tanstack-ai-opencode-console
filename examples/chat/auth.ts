import { randomUUID } from "node:crypto";
import {
  completeOpenCodeConsoleDeviceSignIn,
  createOpenCodeConsoleSessionAuth,
  requestOpenCodeConsoleDeviceCode,
  OpenCodeConsoleAuthError,
} from "tanstack-ai-opencode-console/auth";
import type {
  OpenCodeConsoleDeviceCode,
  OpenCodeConsoleSessionAuth,
} from "tanstack-ai-opencode-console/auth";

export interface ExampleAuthState {
  /** Non-secret identity of this server's current connection context. */
  connectionRevision: string;
  mode: "api-key" | "session";
  keyConfigured: boolean;
  phase:
    | "api-key"
    | "signed-out"
    | "starting"
    | "pending"
    | "organization-required"
    | "signed-in"
    | "error";
  pending?: {
    userCode: string;
    verificationUrl: string;
    expiresAt: number;
  };
  session?: {
    account: { id: string; email: string };
    organizations: Array<{ id: string; name: string }>;
    orgId?: string;
    organizationLocked: boolean;
  };
  error?: string;
}

interface AuthOptions {
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  authServer?: string;
  onChange: () => void;
}

function publicAuthError(cause: unknown): string {
  if (cause instanceof OpenCodeConsoleAuthError) return cause.message;
  // These parser errors are generated locally and contain no upstream data.
  const safeMessages = new Set([
    "Console returned an invalid authentication response.",
    "Console returned an incomplete authentication response.",
    "Console returned invalid authentication JSON.",
    "Console returned an unsupported token type.",
    "Console returned invalid organizations.",
    "Console granted a session for an unavailable organization.",
  ]);
  if (cause instanceof Error && safeMessages.has(cause.message))
    return cause.message;
  if (cause instanceof Error && cause.name === "TimeoutError")
    return "Console sign-in request timed out. Try again.";
  return "Console sign-in could not complete. Start a new sign-in.";
}

/** Tokens and device credentials belong to this server-memory object only. */
export function createExampleAuth(options: AuthOptions) {
  let mode: ExampleAuthState["mode"] = options.apiKey ? "api-key" : "session";
  let phase: ExampleAuthState["phase"] = "signed-out";
  let error: string | undefined;
  let device: OpenCodeConsoleDeviceCode | undefined;
  let sessionAuth: OpenCodeConsoleSessionAuth | undefined;
  let controller: AbortController | undefined;
  let generation = 0;
  let connectionRevision = randomUUID();

  function changed() {
    connectionRevision = randomUUID();
    options.onChange();
  }

  function reset() {
    generation++;
    controller?.abort();
    controller = undefined;
    device = undefined;
    sessionAuth?.clear();
    sessionAuth = undefined;
    phase = "signed-out";
    error = undefined;
  }

  function getState(): ExampleAuthState {
    const session = sessionAuth?.getSession();
    return {
      connectionRevision,
      mode,
      keyConfigured: Boolean(options.apiKey),
      phase:
        mode === "api-key"
          ? "api-key"
          : session
            ? session.orgId
              ? "signed-in"
              : "organization-required"
            : phase,
      ...(mode === "session" && device
        ? {
            pending: {
              userCode: device.userCode,
              verificationUrl: device.verificationUrl,
              expiresAt: device.expiresAt,
            },
          }
        : {}),
      ...(mode === "session" && session
        ? {
            session: {
              account: { id: session.account.id, email: session.account.email },
              organizations: session.organizations.map(({ id, name }) => ({
                id,
                name,
              })),
              organizationLocked: Boolean(session.scopedOrgId),
              ...(session.orgId ? { orgId: session.orgId } : {}),
            },
          }
        : {}),
      ...(error ? { error } : {}),
    };
  }

  return {
    getState,
    getProviderAuth() {
      if (mode === "session" && sessionAuth?.getSession()?.orgId)
        return { session: sessionAuth };
      // An explicit empty key also suppresses the adapter's environment fallback.
      return { apiKey: mode === "api-key" ? (options.apiKey ?? "") : "" };
    },
    canChat() {
      return mode === "api-key" || Boolean(sessionAuth?.getSession()?.orgId);
    },
    setMode(nextMode: ExampleAuthState["mode"]) {
      if (nextMode === mode) return getState();
      reset();
      mode = nextMode;
      changed();
      return getState();
    },
    async start(signal: AbortSignal) {
      reset();
      mode = "session";
      phase = "starting";
      const currentGeneration = generation;
      const loginController = new AbortController();
      controller = loginController;
      changed();
      try {
        const nextDevice = await requestOpenCodeConsoleDeviceCode({
          fetch: options.fetch,
          server: options.authServer,
          signal: AbortSignal.any([signal, loginController.signal]),
        });
        if (generation !== currentGeneration || loginController.signal.aborted)
          return getState();
        device = nextDevice;
        phase = "pending";
        void completeOpenCodeConsoleDeviceSignIn(nextDevice, {
          fetch: options.fetch,
          signal: loginController.signal,
        })
          .then((session) => {
            if (
              generation !== currentGeneration ||
              loginController.signal.aborted
            )
              return;
            sessionAuth = createOpenCodeConsoleSessionAuth(session, {
              fetch: options.fetch,
            });
            console.info("Console sign-in completed:", {
              accessTokenLifetimeSeconds: Math.round(
                (session.expiresAt - Date.now()) / 1000,
              ),
              workspaceScoped: Boolean(session.scopedOrgId),
            });
            device = undefined;
            controller = undefined;
            changed();
          })
          .catch((cause: unknown) => {
            if (
              generation !== currentGeneration ||
              loginController.signal.aborted
            )
              return;
            phase = "error";
            error = publicAuthError(cause);
            console.error("Console sign-in failed:", error);
            device = undefined;
            controller = undefined;
            changed();
          });
      } catch (cause: unknown) {
        if (generation === currentGeneration) {
          phase = "error";
          error = publicAuthError(cause);
          controller = undefined;
          changed();
        }
      }
      return getState();
    },
    selectOrganization(orgId: string) {
      if (mode !== "session" || !sessionAuth)
        throw new Error("Sign in before choosing an organization.");
      sessionAuth.selectOrganization(orgId);
      changed();
      return getState();
    },
    logout() {
      reset();
      mode = "session";
      changed();
      return getState();
    },
    close: reset,
  };
}

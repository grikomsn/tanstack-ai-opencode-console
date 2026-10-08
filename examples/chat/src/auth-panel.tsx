import { useEffect, useRef, useState } from "react";
import type { ExampleAuthState } from "../auth.js";

function boundedPollInterval(interval: number | undefined): number {
  return typeof interval === "number" && Number.isFinite(interval)
    ? Math.max(1000, Math.min(30_000, Math.round(interval)))
    : 1000;
}

export function AuthPanel({
  state,
  onChange,
}: {
  state: ExampleAuthState | null;
  onChange: (state: ExampleAuthState) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actionGeneration = useRef(0);
  const actionPending = useRef(false);
  const pollInterval = useRef(boundedPollInterval(state?.statusPollIntervalMs));
  const schedulePoll = useRef<((delay: number) => void) | null>(null);

  useEffect(() => {
    const delay = boundedPollInterval(state?.statusPollIntervalMs);
    if (delay !== pollInterval.current) {
      pollInterval.current = delay;
      schedulePoll.current?.(delay);
    }
  }, [state?.statusPollIntervalMs]);

  useEffect(() => {
    const controller = new AbortController();
    let pollInFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (delay: number) => {
      if (controller.signal.aborted) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void poll();
      }, delay);
    };
    const poll = async () => {
      if (pollInFlight) return;
      if (actionPending.current) {
        schedule(pollInterval.current);
        return;
      }
      pollInFlight = true;
      const generation = actionGeneration.current;
      try {
        const response = await fetch("/api/auth/status", {
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error("Could not read the server sign-in status.");
        const next = (await response.json()) as ExampleAuthState;
        if (
          !controller.signal.aborted &&
          generation === actionGeneration.current &&
          !actionPending.current
        ) {
          pollInterval.current = boundedPollInterval(next.statusPollIntervalMs);
          setError(null);
          onChange(next);
        }
      } catch (cause) {
        if (
          !controller.signal.aborted &&
          generation === actionGeneration.current &&
          !actionPending.current
        )
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not read sign-in status.",
          );
      } finally {
        pollInFlight = false;
        schedule(pollInterval.current);
      }
    };
    schedulePoll.current = schedule;
    void poll();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
      if (schedulePoll.current === schedule) schedulePoll.current = null;
    };
  }, [onChange]);

  async function action(route: string, body: unknown = {}) {
    const generation = ++actionGeneration.current;
    actionPending.current = true;
    setBusy(true);
    setError(null);
    if (route === "start")
      onChange({
        ...(state ?? {}),
        connectionRevision: state?.connectionRevision ?? "",
        mode: "session",
        keyConfigured: state?.keyConfigured ?? false,
        phase: "starting",
        canChat: false,
        statusPollIntervalMs: 1000,
        pending: undefined,
        session: undefined,
        error: undefined,
      });
    try {
      const response = await fetch(`/api/auth/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const next = (await response.json()) as ExampleAuthState & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(next.error ?? "The sign-in action failed.");
      if (generation === actionGeneration.current) onChange(next);
    } catch (cause) {
      if (generation === actionGeneration.current)
        setError(
          cause instanceof Error ? cause.message : "The sign-in action failed.",
        );
    } finally {
      if (generation === actionGeneration.current) {
        actionPending.current = false;
        setBusy(false);
      }
    }
  }

  const waiting = state?.phase === "pending" || state?.phase === "starting";
  const availableModes = state?.availableModes ?? ["api-key", "session"];
  const hostedSession =
    availableModes.length === 1 && availableModes[0] === "session";
  const workspace = state?.session?.organizations.find(
    (org) => org.id === state.session?.orgId,
  );
  return (
    <section className="auth-panel" aria-label="Authentication">
      <h2 className="panel-title">Connection</h2>
      {state && availableModes.length > 1 && (
        <div
          className="auth-modes"
          role="group"
          aria-label="Authentication mode"
        >
          <button
            type="button"
            aria-pressed={state?.mode === "api-key"}
            disabled={busy && !waiting}
            onClick={() => {
              void action("mode", { mode: "api-key" });
            }}
          >
            Server key
          </button>
          <button
            type="button"
            aria-pressed={state?.mode === "session"}
            disabled={busy && !waiting}
            onClick={() => {
              void action("mode", { mode: "session" });
            }}
          >
            Console sign-in
          </button>
        </div>
      )}
      {!state && (
        <p className="auth-note" role="status">
          Checking your connection…
        </p>
      )}
      {state?.mode === "api-key" && (
        <p className="auth-note">
          {state.keyConfigured
            ? "Using the API key configured on the server."
            : "No server key configured. Use Console sign-in, or configure an API key."}
        </p>
      )}
      {state?.mode === "session" && (
        <>
          {state.session ? (
            <>
              <div className="connected-account">
                <span className="connection-state">
                  <span className="status-dot" />
                  {workspace ? "Connected" : "Choose a workspace"}
                </span>
                {workspace && (
                  <strong className="workspace-name">{workspace.name}</strong>
                )}
                <span className="account-email">
                  {state.session.account.email}
                </span>
              </div>
              {!state.session.organizationLocked && (
                <>
                  <label className="auth-label" htmlFor="organization">
                    Workspace
                  </label>
                  <select
                    id="organization"
                    value={state.session.orgId ?? ""}
                    disabled={busy}
                    onChange={(event) => {
                      void action("organization", {
                        orgId: event.target.value,
                      });
                    }}
                  >
                    {!state.session.orgId && (
                      <option value="" disabled>
                        Choose a workspace
                      </option>
                    )}
                    {state.session.organizations.map((org) => (
                      <option key={org.id} value={org.id}>
                        {org.name}
                      </option>
                    ))}
                  </select>
                </>
              )}
              <button
                className="text-button auth-signout"
                disabled={busy}
                onClick={() => {
                  void action("logout");
                }}
              >
                Sign out
              </button>
            </>
          ) : waiting ? (
            <>
              {state.pending ? (
                <div className="device-code">
                  <p>Open the verification page and approve this code:</p>
                  <strong>{state.pending.userCode}</strong>
                  <a
                    href={state.pending.verificationUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Verify Console sign-in <span>↗</span>
                  </a>
                  <p className="auth-note">
                    Waiting for approval. Code expires at{" "}
                    {new Date(state.pending.expiresAt).toLocaleTimeString()}.
                  </p>
                </div>
              ) : (
                <p className="auth-note">Starting a fresh Console sign-in…</p>
              )}
              <button
                className="text-button"
                onClick={() => {
                  void action("logout");
                }}
              >
                Cancel sign-in
              </button>
            </>
          ) : (
            <>
              <p className="auth-note">
                Connect your Console account to use its workspace and billing.
              </p>
              <button
                className="auth-login"
                disabled={busy}
                onClick={() => {
                  void action("start");
                }}
              >
                Sign in to Console <span>↗</span>
              </button>
            </>
          )}
        </>
      )}
      {hostedSession && (
        <p className="auth-note">
          Your Console tokens stay in shared server-side session storage. Each
          visitor has a separate session.
        </p>
      )}
      {(error || state?.error) && (
        <div className="error-banner model-error" role="alert">
          {error ?? state?.error}
        </div>
      )}
    </section>
  );
}

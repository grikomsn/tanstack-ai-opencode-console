import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { fetchServerSentEvents, useChat } from "@tanstack/ai-react";
import type { FormEvent } from "react";
import type { UIMessage } from "@tanstack/ai-react";
import { AuthPanel } from "./auth-panel.js";
import { resolveModelSelection } from "./model-selection.js";
import type { ExampleAuthState } from "../auth.js";
import "./styles.css";

interface Model {
  id: string;
  api: string;
}

interface Catalog {
  models: Model[];
  authenticated: boolean;
  defaultModel: string | null;
}

const connection = fetchServerSentEvents("/api/chat", {
  fetchClient: async (input, init) => {
    const response = await fetch(input, init);
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      throw new Error(
        body &&
          typeof body === "object" &&
          "error" in body &&
          typeof body.error === "string"
          ? body.error
          : `The server returned HTTP ${response.status}. Try again.`,
      );
    }
    return response;
  },
});

function pretty(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2) ?? "";
}

function Message({ message }: { message: UIMessage }) {
  return (
    <article
      className={`message message-${message.role}`}
      aria-label={`${message.role} message`}
    >
      <div className={`avatar avatar-${message.role}`} aria-hidden="true">
        {message.role === "user" ? (
          "U"
        ) : (
          <img src="/opencode-mark-dark.svg" alt="" />
        )}
      </div>
      <div className="message-body">
        <div className="message-label">
          {message.role === "user" ? "You" : "OpenCode"}
        </div>
        <div className="message-content">
          {message.parts.map((part, index) => {
            if (part.type === "text") {
              return (
                <div className="message-text" key={index}>
                  {part.content}
                </div>
              );
            }
            if (part.type === "thinking") {
              return (
                <details className="reasoning" key={index}>
                  <summary>
                    Reasoning <span>model trace</span>
                  </summary>
                  <div>
                    {part.content ||
                      "The provider returned an encrypted reasoning block."}
                  </div>
                </details>
              );
            }
            if (part.type === "tool-call") {
              return (
                <details className="tool-card" key={index} open>
                  <summary>
                    <span className="tool-icon">↗</span> {part.name}
                    <span>{part.state}</span>
                  </summary>
                  <pre>{pretty(part.input ?? part.arguments)}</pre>
                  {part.output !== undefined && (
                    <pre className="tool-output">{pretty(part.output)}</pre>
                  )}
                </details>
              );
            }
            if (part.type === "tool-result") {
              return (
                <details className="tool-card tool-result" key={index}>
                  <summary>
                    <span className="tool-icon">✓</span> Tool result
                    <span>{part.state}</span>
                  </summary>
                  <pre>{pretty(part.content)}</pre>
                </details>
              );
            }
            return null;
          })}
        </div>
      </div>
    </article>
  );
}

function Chat({
  model,
  canChat,
  connectionRevision,
}: {
  model: Model;
  canChat: boolean;
  connectionRevision: string;
}) {
  const [input, setInput] = useState("");
  const [toolsEnabled, setToolsEnabled] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const { messages, sendMessage, isLoading, error, stop, clear } = useChat({
    connection,
    queue: "drop",
  });
  const endRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  async function send(text: string, useTools = toolsEnabled) {
    const content = text.trim();
    if (!content || isLoading || !canChat) return;
    setSubmitError(null);
    setInput("");
    try {
      await sendMessage(content, {
        body: { model: model.id, toolsEnabled: useTools, connectionRevision },
      });
    } catch (cause) {
      setSubmitError(
        cause instanceof Error ? cause.message : "Could not send your message.",
      );
    }
    textareaRef.current?.focus();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void send(input);
  }

  const displayedError = error?.message ?? submitError;

  return (
    <section className="chat-panel" aria-label="Chat">
      <div className="chat-toolbar">
        <div className="session-status">
          <span
            className={
              isLoading
                ? "status-dot pulsing"
                : canChat
                  ? "status-dot"
                  : "status-dot inactive"
            }
          />
          {isLoading
            ? "Generating"
            : canChat
              ? "Ready"
              : "Connect an account to chat"}
        </div>
        <button
          className="text-button"
          disabled={isLoading || messages.length === 0}
          onClick={() => {
            clear();
            setSubmitError(null);
          }}
        >
          New chat
        </button>
      </div>
      <div
        className="transcript"
        aria-live="polite"
        aria-relevant="additions text"
      >
        {messages.length === 0 && (
          <div className="empty-chat">
            <img
              className="empty-mark"
              src="/opencode-mark-dark.svg"
              alt=""
              aria-hidden="true"
            />
            <h2>Basic Chat</h2>
            <p>
              {canChat
                ? `Send a message to ${model.id}.`
                : "Connect your account, then send your first message."}
            </p>
            <div className="suggestions">
              <button
                disabled={isLoading || !canChat}
                onClick={() => {
                  setInput(
                    "Explain streaming AI responses in three simple sentences.",
                  );
                  textareaRef.current?.focus();
                }}
              >
                Explain streaming
              </button>
              <button
                disabled={isLoading || !canChat}
                onClick={() => {
                  setToolsEnabled(true);
                  setInput(
                    "Use getCurrentTime to tell me the current date and time in UTC.",
                  );
                  textareaRef.current?.focus();
                }}
              >
                Try the time tool
              </button>
            </div>
          </div>
        )}
        {messages.map((message) => (
          <Message key={message.id} message={message} />
        ))}
        {isLoading && (
          <div className="generating">
            <span />
            <span />
            <span />
            <span className="sr-only">Waiting for the model</span>
          </div>
        )}
        <div ref={endRef} />
      </div>
      <div className="composer-area">
        {displayedError && (
          <div className="error-banner" role="alert">
            {displayedError}
          </div>
        )}
        <form className="composer" onSubmit={submit}>
          <label className="sr-only" htmlFor="message-input">
            Your message
          </label>
          <textarea
            id="message-input"
            ref={textareaRef}
            placeholder={
              canChat ? "Write a message…" : "Connect an account to chat"
            }
            rows={2}
            value={input}
            maxLength={12_000}
            disabled={isLoading || !canChat}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void send(input);
              }
            }}
          />
          <div className="composer-actions">
            <label className="tool-toggle">
              <input
                type="checkbox"
                checked={toolsEnabled}
                disabled={isLoading || !canChat}
                onChange={(event) => setToolsEnabled(event.target.checked)}
              />
              <span className="toggle-track" />
              Current-time tool
            </label>
            {isLoading ? (
              <button
                type="button"
                className="send-button stop-button"
                onClick={stop}
              >
                <span>■</span> Stop
              </button>
            ) : (
              <button
                type="submit"
                className="send-button"
                disabled={!input.trim() || !canChat}
              >
                Send <span>↑</span>
              </button>
            )}
          </div>
        </form>
        <p className="composer-note">
          Enter to send <span>·</span> Shift + Enter for a new line
        </p>
      </div>
    </section>
  );
}

function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [auth, setAuth] = useState<ExampleAuthState | null>(null);
  const [modelId, setModelId] = useState("");
  const explicitModelChoice = useRef(false);
  const [loading, setLoading] = useState(true);
  const [modelError, setModelError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const selectedModel = useMemo(
    () => catalog?.models.find((model) => model.id === modelId),
    [catalog, modelId],
  );

  useEffect(() => {
    setRefresh((value) => value + 1);
  }, [auth?.mode, auth?.phase, auth?.session?.orgId, auth?.connectionRevision]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setModelError(null);
    void (async () => {
      try {
        const response = await fetch("/api/models", {
          signal: controller.signal,
        });
        const body = (await response.json()) as Catalog & { error?: string };
        if (controller.signal.aborted) return;
        if (!response.ok)
          throw new Error(body.error ?? "Could not load models.");
        if (!Array.isArray(body.models))
          throw new Error("The server returned an invalid model catalog.");
        setCatalog(body);
        setModelId((current) => {
          const selection = resolveModelSelection(
            body,
            current,
            explicitModelChoice.current,
          );
          explicitModelChoice.current = selection.explicitlyChosen;
          return selection.modelId;
        });
      } catch (cause) {
        if (!controller.signal.aborted)
          setModelError(
            cause instanceof Error ? cause.message : "Could not load models.",
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [refresh]);

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="/" aria-label="OpenCode Console home">
          <img
            className="brand-mark"
            src="/opencode-mark-dark.svg"
            alt=""
            aria-hidden="true"
          />
          <div>
            <h1>OpenCode Console</h1>
            <span className="brand-caption">
              <span>TanStack AI</span>
              <span aria-hidden="true"> / </span>Basic chat example
            </span>
          </div>
        </a>
        <a
          className="source-link"
          href="https://github.com/grikomsn/tanstack-ai-opencode-console"
          target="_blank"
          rel="noreferrer"
        >
          View source <span>↗</span>
        </a>
      </header>
      <main>
        <div className="workspace">
          <aside className="model-panel">
            <AuthPanel state={auth} onChange={setAuth} />
            <div className="sidebar-rule" />
            <div className="panel-heading">
              <label className="model-label" htmlFor="model-select">
                Model
              </label>
              <button
                className="text-button refresh-button"
                disabled={loading}
                aria-label="Refresh models"
                title="Refresh models"
                onClick={() => setRefresh((value) => value + 1)}
              >
                <span aria-hidden="true">↻</span>
              </button>
            </div>
            <div className="model-select-wrap">
              <select
                id="model-select"
                value={modelId}
                disabled={loading || !catalog?.models.length}
                onChange={(event) => {
                  explicitModelChoice.current = true;
                  setModelId(event.target.value);
                }}
              >
                {!catalog?.models.length && (
                  <option value="">
                    {loading ? "Loading models…" : "No models available"}
                  </option>
                )}
                {catalog?.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.id}
                  </option>
                ))}
              </select>
            </div>
            <p className="model-count" role="status">
              {loading
                ? "Loading models…"
                : `${catalog?.models.length ?? 0} ${catalog?.models.length === 1 ? "model" : "models"}`}
            </p>
            {modelError && (
              <div className="error-banner model-error" role="alert">
                {modelError}
              </div>
            )}
            {!loading && !modelError && catalog?.models.length === 0 && (
              <p className="muted">
                {catalog.authenticated
                  ? "No supported models matched the server's model allowlist."
                  : "Connect your Console account to load models."}
              </p>
            )}
            {selectedModel && (
              <details className="adapter-details">
                <summary>Adapter details</summary>
                <dl>
                  <dt>API</dt>
                  <dd>{selectedModel.api}</dd>
                </dl>
              </details>
            )}
            <div className="sidebar-bottom">
              <p>Changing the model starts a new chat.</p>
              <a
                href="https://opencode.ai/v2/docs/console/inference/"
                target="_blank"
                rel="noreferrer"
              >
                Inference docs <span>↗</span>
              </a>
            </div>
          </aside>
          {selectedModel ? (
            <Chat
              key={`${selectedModel.id}:${auth?.connectionRevision}`}
              model={selectedModel}
              connectionRevision={auth?.connectionRevision ?? ""}
              canChat={
                auth?.canChat ??
                (auth?.mode === "api-key" || auth?.phase === "signed-in")
              }
            />
          ) : (
            <section className="chat-panel unavailable-panel">
              <img
                className="empty-mark"
                src="/opencode-mark-dark.svg"
                alt=""
                aria-hidden="true"
              />
              <h2>
                {loading
                  ? "Connecting to OpenCode…"
                  : "Choose a model to begin"}
              </h2>
              <p>
                {loading
                  ? "Fetching the current model catalog."
                  : "Load a supported model to start the conversation."}
              </p>
            </section>
          )}
        </div>
      </main>
      <footer>
        <span>OpenCode v2 inference</span>
        <span>Text · Reasoning · Tools</span>
      </footer>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing React root element.");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

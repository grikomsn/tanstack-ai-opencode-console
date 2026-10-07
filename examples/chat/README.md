# Chat example

A React and Vite chat with a local Node backend. The server signs in to Console or uses a configured service key, discovers OpenCode v2 inference models, selects the adapter protocol, and streams TanStack AI events to `useChat`. The UI displays text, available reasoning traces, tool calls, tool results, errors, and a Stop button.

Use the [published npm adapter](https://www.npmjs.com/package/tanstack-ai-opencode-console) in your own app. This example runs from the repository's local workspace package; see the [release history](../../docs/releases.md) for published versions and source tags.

The connection panel shows the approved workspace and account before the model selector. Protocol information is available under **Adapter details**. The compact layout keeps the transcript and composer visible on desktop and stacks the controls above chat on narrow screens.

From the repository root:

```sh
npm install
npm run dev
```

Open <http://127.0.0.1:5173>. Choose **Console sign-in**, click **Sign in to Console**, then follow the verification link and approve the displayed code. The backend polls for approval. Choose an organization when requested; an organization-scoped sign-in selects and locks the approved organization automatically. Cancel stops polling. Sign out clears the local session and cancels active inference; it does not claim to revoke the account's device authorization.

Access and refresh tokens stay in backend memory and are refreshed before requests when necessary. The browser receives only the user-facing code/link and account/organization metadata. No Console credential store is read and no session is written to disk. Restarting the backend signs you out. This is one local server session shared by its browser tabs. The connection panel continues checking status after sign-in so changes in another tab are reflected here. Account, workspace, or authentication mode changes clear chat history; requests from an outdated connection context are rejected before inference. Selecting the current authentication mode keeps the session and active chat intact.

To use a service key instead, configure `OPENCODE_API_KEY` on the server and choose **Server key**. The chosen mode is explicit: Console sign-in overrides any ambient server key, and signing out keeps session mode selected until you choose Server key again.

Root `.env` and optional `examples/chat/.env` are loaded by the Node backend. The latter overrides values from the root file. Restart the backend after changing configuration.

OpenCode documents service API keys and its model discovery endpoint in the [v2 inference reference](https://opencode.ai/v2/docs/console/inference/). Access depends on your account and the selected model. Our live check encountered a gateway restriction on external use of a free model despite the documentation describing keyless calls; use a Console service key and an available paid model if the gateway rejects a free request. This app reports those errors and does not imitate an OpenCode client identity.

Configuration is server-only:

| Variable                  | Purpose                                                  |
| ------------------------- | -------------------------------------------------------- |
| `OPENCODE_API_KEY`        | Console service key; never use a `VITE_` prefix.         |
| `OPENCODE_BASE_URL`       | Inference root, default `https://opencode.ai/inference`. |
| `OPENCODE_MODEL`          | Preferred initial model if present in the catalog.       |
| `OPENCODE_ALLOWED_MODELS` | Optional comma-separated subset of discovered model IDs. |

The model menu contains currently discovered models supported by the adapter. Model discovery is cached for 30 seconds. With a server key configured or a signed-in session, `gpt-5-nano` is initially selected when available; `OPENCODE_MODEL` overrides that choice. Automatic selection follows the authenticated default after sign-in, while a model you explicitly chose is preserved if still available. Switching models starts a new chat. Enable **Current-time tool**, or choose the tool suggestion, to let the model execute `getCurrentTime` on the server; it only reads the UTC clock. Reasoning is displayed when the selected model and provider emit it. A model may decline to call a tool.

Both development and preview bind to `127.0.0.1`. Vite proxies `/api` to the backend at port 3001. The backend checks Origin and Host, limits requests to 128 KiB and 40 messages, uses only its own tool definitions, limits runs to three model turns and 2,048 output tokens per model turn, and cancels upstream inference when Stop or a disconnected client closes the stream. It provides local demo protections, not a deployed multi-user authentication system.

```sh
npm run build
npm run preview --workspace @opencode-console/chat-example
# Preview: http://127.0.0.1:4173
npm run typecheck --workspace @opencode-console/chat-example
npm run test --workspace @opencode-console/chat-example
```

Tests use a local fake OpenAI-compatible inference server with the actual adapter. They verify catalog filtering, credential isolation, streaming, a complete tool round trip, input/origin limits, sanitized provider errors, inference cancellation, device polling, organization selection and scoping, session inference headers, local signout, canceled sign-in polling, stale connection rejection before and during discovery, same-mode session and stream continuity, and automatic versus explicit model selection. They make no live model requests.

The [October 7 Console verification](../../docs/verification/console-2026-10-07.json) records separate live requests through a workspace-scoped device session across Chat Completions, Responses, and Messages. This evidence is independent of the fixture tests and the [Go gateway verification](../../docs/go.md).

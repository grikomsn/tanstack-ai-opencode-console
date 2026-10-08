<div align="center">
  <img src="media/header-opencode-console.png" alt="TanStack AI + OpenCode Console — community adapter for OpenCode v2 inference" width="900" />
</div>

<br />

<div align="center">
  <a href="https://www.npmjs.com/package/tanstack-ai-opencode-console"><img src="https://img.shields.io/npm/v/tanstack-ai-opencode-console?color=e66845" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/tanstack-ai-opencode-console"><img src="https://img.shields.io/npm/dm/tanstack-ai-opencode-console" alt="npm downloads" /></a>
  <a href="https://github.com/grikomsn/tanstack-ai-opencode-console/actions/workflows/ci.yml"><img src="https://github.com/grikomsn/tanstack-ai-opencode-console/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license" /></a>
</div>

<br />

# TanStack AI · OpenCode Console

[npm package](https://www.npmjs.com/package/tanstack-ai-opencode-console) · [GitHub releases](https://github.com/grikomsn/tanstack-ai-opencode-console/releases) · [Release history](docs/releases.md)

A community [TanStack AI](https://tanstack.com/ai) adapter for the **OpenCode v2 Console inference APIs**. Call hosted models directly from your server through `https://opencode.ai/inference`.

TanStack's existing [`@tanstack/ai-opencode`](https://tanstack.com/ai/latest/docs/adapters/opencode) adapter runs the OpenCode CLI. This package connects to the inference service; it needs no CLI installation or local OpenCode process.

## Start here

- [Quick start](#quick-start) — stream a response from a server or script.
- [React chat example](examples/chat) — run the demo with server-side credentials.
- [Console sign-in](docs/authentication.md) — connect a workspace without an API key.
- [OpenCode Go](docs/go.md) — configure the separate subscription gateway.
- [Release history](docs/releases.md) — published versions and verification evidence.

## What it supports

- Streaming text through TanStack's Responses, Chat Completions, Anthropic Messages, and Gemini adapters.
- Tool calls, reasoning, usage, and structured output through the selected native adapter, where the model supports them.
- Service keys or workspace-scoped Console device sign-in, with credentials kept on your server.
- Model discovery, explicit protocol overrides, cancellation, and configurable transport.

## Install

```sh
npm install @tanstack/ai tanstack-ai-opencode-console
```

Requires Node.js 22.19+ and `@tanstack/ai` 0.65.x. This repository includes the [published npm package](https://www.npmjs.com/package/tanstack-ai-opencode-console) and a private example app.

## Quick start

Create a service account key in [OpenCode Console](https://opencode.ai/console) and set `OPENCODE_API_KEY` on your server. The [v2 inference reference](https://opencode.ai/v2/docs/console/inference/) describes free chat models without a key, but a live external-client check on October 5, 2026 returned HTTP 403: "OpenCode's free tier can only be used from within OpenCode". Use a service key and an eligible paid model for this example; the adapter preserves its own client identity.

```ts
import { chat } from "@tanstack/ai";
import { opencodeConsoleText } from "tanstack-ai-opencode-console";

const stream = chat({
  adapter: opencodeConsoleText("gpt-5.5"),
  messages: [{ role: "user", content: "Explain SSE in one sentence." }],
  modelOptions: { max_output_tokens: 256 },
});

for await (const event of stream) {
  if (event.type === "TEXT_MESSAGE_CONTENT") {
    process.stdout.write(event.delta);
  }
}
```

To omit authentication explicitly, use `apiKey: ""` to ignore an environment key. Gateway eligibility rules still apply:

```ts
const adapter = opencodeConsoleText("big-pickle", { apiKey: "" });
```

Keep the main package import and your credentials on the server. React clients connect to your server's SSE endpoint, as demonstrated by [the chat example](examples/chat).

## Console sign-in without an API key

The server-only `/auth` entry requests a fresh, workspace-scoped device sign-in and manages user sessions:

```ts
import {
  requestOpenCodeConsoleDeviceCode,
  completeOpenCodeConsoleDeviceSignIn,
  createOpenCodeConsoleSessionAuth,
} from "tanstack-ai-opencode-console/auth";

const device = await requestOpenCodeConsoleDeviceCode();
// Display only these fields; deviceCode and tokens must remain on the server.
console.log(device.verificationUrl, device.userCode);
const session = await completeOpenCodeConsoleDeviceSignIn(device);
const sessionAuth = createOpenCodeConsoleSessionAuth(session);
const adapter = opencodeConsoleText("gpt-5-nano", { session: sessionAuth });
```

The supplier refreshes before expiry and shares an in-flight refresh across requests for that session. `getSession()` returns a snapshot for caller-owned secure persistence; rotated tokens otherwise remain in memory. Scoped grants preserve the workspace selected during browser approval. Account-wide grants with multiple workspaces require `sessionAuth.selectOrganization(id)` before inference. A scoped grant cannot switch workspaces locally.

Applications that already own a session can pass `{ session: { accessToken, orgId } }` or an async `session(signal)` supplier. Session mode ignores `OPENCODE_API_KEY`, sends Bearer authentication with matching `x-org-id` and `x-opencode-org-id` headers, and rejects an explicitly combined `apiKey` setting. `clear()` deletes only the in-memory session. Remote revocation is a separate operation through `revokeOpenCodeConsoleSession(session)`.

The package uses its own device client ID, currently labeled "Unknown client" by Console. It never reads another application's credential store. These helpers follow the current Console device contract; see [authentication and verification](docs/authentication.md) for cancellation, storage, and evidence limits. Model eligibility and account credits still apply.

## Model routing

For the separate subscription gateway, see [Go configuration and live verification](docs/go.md). Use the Go root and explicit protocol overrides where Go differs from Console.

The adapter delegates message conversion, SSE parsing, tool calls, reasoning, usage, and structured output to the maintained TanStack OpenAI-compatible, Anthropic, and Gemini adapters.

| Model family                                       | API              | v2 endpoint                                        |
| -------------------------------------------------- | ---------------- | -------------------------------------------------- |
| GPT, Grok, Muse Spark                              | Responses        | `/openai/v1/responses`                             |
| Claude, Qwen                                       | Messages         | `/anthropic/v1/messages`                           |
| Gemini                                             | Gemini           | `/google/v1beta/models/<id>:streamGenerateContent` |
| Kimi, GLM, DeepSeek, MiniMax, ordinary free models | Chat Completions | `/openai/v1/chat/completions`                      |

Paths are relative to `https://opencode.ai/inference`. `qwen3.8-max` is a Chat Completions exception. Jev uses the System One decision API and is excluded from this text adapter. These assignments follow the [OpenCode model endpoint table](https://opencode.ai/v2/docs/console/models/); the endpoint root and universal Bearer authentication follow the [v2 inference reference](https://opencode.ai/v2/docs/console/inference/). The model table still shows legacy Zen URLs, so this package uses its protocol assignments with the documented v2 paths.

Pass gateway model IDs, such as `claude-sonnet-4-6`, without the CLI's `opencode/` prefix. Unknown families default to Chat Completions. Override routing for new models or your own gateway:

```ts
opencodeConsoleText("new-model", { api: "responses" });
```

## Configure once and discover models

```ts
import { createOpenCodeConsole } from "tanstack-ai-opencode-console";

const consoleAI = createOpenCodeConsole({
  apiKey: process.env.OPENCODE_API_KEY,
  timeout: 120_000,
});

const available = await consoleAI.listModels();
const supported = available.filter((model) => model.supported);
const adapter = consoleAI("kimi-k2.6");
```

`listOpenCodeConsoleModels(config?, { signal }?)` also works without a factory. Discovery calls `/v1/models` and returns `id`, inferred `api`, `supported`, and optional `created`/`ownedBy`. The public catalog supplies availability IDs, not complete modality, pricing, token-limit, tool, or schema guarantees. The `api` value uses local routing rules rather than a server-provided protocol field. Discovery retains unsupported decision models with `supported: false` so callers can filter them.

Model capabilities and provider options remain model-specific. The adapter defaults to a text-only input type. Declare additional verified input modalities explicitly:

```ts
opencodeConsoleText("claude-sonnet-4-6", {
  inputModalities: ["text", "image", "document"] as const,
});
```

This declaration changes TypeScript's accepted inputs; it does not enable a capability on the gateway. Provider file handles and uploaded-file workflows are not exposed by this adapter.

## Provider options and structured output

Supply options using each wire API's spelling in `chat({ modelOptions })`:

| API              | Output-token limit  | Example reasoning option                             |
| ---------------- | ------------------- | ---------------------------------------------------- |
| Chat Completions | `max_tokens`        | `reasoning_effort` where supported                   |
| Responses        | `max_output_tokens` | `reasoning: { effort: "low" }`                       |
| Messages         | `max_tokens`        | `thinking: { type: "enabled", budget_tokens: 1024 }` |
| Gemini           | `maxOutputTokens`   | `thinkingConfig: { thinkingBudget: 1024 }`           |

Options are dynamically typed because Console's model list evolves independently from upstream model unions. Native adapters and the gateway validate what a model accepts. Messages defaults `max_tokens` to 4096; pass a larger value for longer output. Responses defaults to `store: false`, which you may override in `modelOptions`.

TanStack tool definitions, agent loops, and `outputSchema` are forwarded through the selected native adapter. For example:

```ts
import { chat } from "@tanstack/ai";
import { z } from "zod";
import { opencodeConsoleText } from "tanstack-ai-opencode-console";

const result = await chat({
  adapter: opencodeConsoleText("gpt-5.5"),
  messages: [{ role: "user", content: "Describe the purpose of SSE." }],
  outputSchema: z.object({ summary: z.string() }),
});
```

Structured output, tools, and reasoning depend on the selected model's support; discovery does not certify them. The example includes a server-side current-time tool.

## Transport configuration

`opencodeConsoleText(model, config?)` and `createOpenCodeConsole(config?)` accept:

| Option            | Default                         | Purpose                                                                             |
| ----------------- | ------------------------------- | ----------------------------------------------------------------------------------- |
| `apiKey`          | `OPENCODE_API_KEY`              | Service key or async key supplier; `""` omits auth                                  |
| `session`         | None                            | User token + organization, or cancellable session supplier; ignores environment key |
| `baseURL`         | `https://opencode.ai/inference` | Root URL, without a protocol suffix                                                 |
| `api`             | Inferred from model ID          | `chat-completions`, `responses`, `messages`, or `gemini`                            |
| `fetch`           | Global fetch                    | Inject transport for tests, proxies, or observability                               |
| `defaultHeaders`  | None                            | Additional request headers                                                          |
| `timeout`         | 600000 ms                       | Per-request network timeout                                                         |
| `maxRetries`      | 0                               | Native SDK retry count before a successful response                                 |
| `inputModalities` | `["text"]`                      | Verified input modalities for TypeScript                                            |

The transport removes native SDK key headers and sets Console Bearer authentication for every protocol. Authentication, session organization scope, and the `x-opencode-client` identity header cannot be overridden by additional headers. An async credential supplier is called on each outgoing request. The `/auth` entry manages device sign-in and refresh in memory; persistent secret storage remains the caller's responsibility. This package does not read OpenCode, Pi, or VS Code credential files or call legacy Go/Zen endpoints.

Pass `abortController` to TanStack's `chat()` to cancel work. The example propagates browser disconnects to the upstream request. No stream is replayed after its response has started. Per-call request headers follow native adapter support; use `defaultHeaders` for headers that must reach every protocol, including Gemini.

For a browser-safe BYOK descriptor, import the isolated subpath:

```ts
import { opencodeConsoleByok } from "tanstack-ai-opencode-console/byok";
```

It declares the `x-byok-opencode-console` slug and `OPENCODE_API_KEY` environment name, as described in the [TanStack community adapter guide](https://tanstack.com/ai/latest/docs/community-adapters/guide). Handle BYOK credentials in your application's server relay.

## Run the example

```sh
npm ci
cp .env.example .env # Only if you do not already have .env
# Set OPENCODE_API_KEY, or use Console sign-in in the example.
npm run dev
```

Open `http://127.0.0.1:5173`. The React app uses TanStack's `useChat` and SSE transport. Its local Node server discovers models, selects the appropriate protocol, executes the time tool, and keeps the key out of the browser bundle. See [example configuration and tests](examples/chat/README.md).

For a hosted demo with a separate Console session for each visitor, follow the [Vercel deployment guide](docs/vercel.md). It uses secure browser cookies and encrypted shared Redis storage.

## Development and release

```sh
npm run check
npm run build
npm run changeset
```

The repository uses npm workspaces, Node tests, TypeScript, Prettier, Changesets, and CI on Node 22/24/26. `npm run check` builds both workspaces, checks types and formatting, runs mocked protocol/example integration tests, and validates a packed tarball in an isolated consumer. Tests make no live inference calls.

The published package is under `packages/tanstack-ai-opencode-console`; the example is private. See [release history](docs/releases.md) and [development instructions](docs/development.md). Package publication and a TanStack community-list submission are separate release steps.

## References

- [OpenCode v2 inference API](https://opencode.ai/v2/docs/console/inference/)
- [OpenCode model endpoints](https://opencode.ai/v2/docs/console/models/)
- [TanStack OpenAI adapter](https://tanstack.com/ai/latest/docs/adapters/openai)
- [TanStack OpenAI-compatible adapter](https://tanstack.com/ai/latest/docs/adapters/openai-compatible)
- [TanStack community adapter guide](https://tanstack.com/ai/latest/docs/community-adapters/guide)
- [OpenCode for Copilot Chat](https://github.com/grikomsn/opencode-copilot-chat)
- [Pi OpenCode Console provider](https://github.com/grikomsn/pi-provider-opencode-console)
- [OpenAI OAuth for Copilot Chat](https://github.com/grikomsn/openai-oauth-copilot-chat)
- [TanStack AI README](https://github.com/TanStack/ai) and [React basic chat example](https://tanstack.com/ai/latest/docs/framework/react/examples/basic-chat) — README and demo styling references.
- [Brand assets and header prompt](media/README.md)

Unofficial community project. Licensed under [MIT](LICENSE).

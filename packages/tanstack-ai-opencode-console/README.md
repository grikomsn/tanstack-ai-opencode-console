# tanstack-ai-opencode-console

Community TanStack AI text adapter for the **OpenCode v2 Console inference APIs**. It calls `https://opencode.ai/inference` directly; it does not run the OpenCode CLI.

```sh
npm install @tanstack/ai tanstack-ai-opencode-console
```

```ts
import { chat } from "@tanstack/ai";
import { opencodeConsoleText } from "tanstack-ai-opencode-console";

const stream = chat({
  adapter: opencodeConsoleText("gpt-5.5"),
  messages: [{ role: "user", content: "Explain SSE in one sentence." }],
  modelOptions: { max_output_tokens: 256 },
});

for await (const event of stream) {
  if (event.type === "TEXT_MESSAGE_CONTENT") process.stdout.write(event.delta);
}
```

Set `OPENCODE_API_KEY` on the server or pass `apiKey`. Alternatively, use the server-only device sign-in helpers:

```ts
import {
  requestOpenCodeConsoleDeviceCode,
  completeOpenCodeConsoleDeviceSignIn,
  createOpenCodeConsoleSessionAuth,
} from "tanstack-ai-opencode-console/auth";
const device = await requestOpenCodeConsoleDeviceCode();
// Display only verificationUrl and userCode; keep deviceCode on the server.
const session = await completeOpenCodeConsoleDeviceSignIn(device);
const sessionAuth = createOpenCodeConsoleSessionAuth(session);
const adapter = opencodeConsoleText("gpt-5-nano", { session: sessionAuth });
```

Device sign-in requests workspace-scoped access. Console currently labels this package's own client ID "Unknown client". Token-bound workspaces cannot be switched locally. Account-wide sessions with multiple workspaces need `sessionAuth.selectOrganization(id)` before inference. A static `session: {accessToken,orgId}` or cancellable supplier also works. Session mode ignores the environment key and cannot be combined with an explicit `apiKey`.

The `/auth` entry also exports `refreshOpenCodeConsoleSession` and `revokeOpenCodeConsoleSession`. The supplier keeps rotated tokens in memory with per-session single-flight refresh. `getSession()` returns a copy for caller-managed secure storage. `clear()` deletes only local state; remote revocation is explicit. Do not send tokens to a browser. See [authentication verification](https://github.com/grikomsn/tanstack-ai-opencode-console/blob/main/docs/authentication.md) for evidence and limits.

Set `apiKey: ""` to omit authentication; gateway eligibility rules still apply. A live external free-tier call on October 5, 2026 returned HTTP 403 restricting usage to OpenCode clients. Use an eligible paid model. Requires Node 22.19+ and `@tanstack/ai` 0.65.x.

Exports `opencodeConsoleText`, `OpenCodeConsoleTextAdapter`, `createOpenCodeConsole`, `listOpenCodeConsoleModels`, `parseOpenCodeConsoleModels`, `resolveOpenCodeConsoleApi`, and `OPENCODE_CONSOLE_BASE_URL`. Import the browser-safe `opencodeConsoleByok` from `tanstack-ai-opencode-console/byok`.

The factory chooses Responses, Chat Completions, Anthropic Messages, or Gemini by model ID and accepts an explicit `api` override. Jev decision models are excluded. Discovery reports availability and inferred routing; it does not guarantee tools, multimodal input, or structured output. Input types default to text; declare verified `inputModalities` in the adapter config. Provider-specific parameters go in `modelOptions`.

Configuration supports a root `baseURL`, `fetch`, `defaultHeaders`, `timeout` (600000 ms), `maxRetries` (0), and `apiKey` or `session` authentication. Every protocol uses Console Bearer auth; sessions also send matching `x-org-id` and `x-opencode-org-id` headers. Persistent secret storage stays with the caller. Responses default to `store:false`; Messages defaults to `max_tokens:4096`. Cancellation, reasoning, tool calls, usage, and schema output delegate to the native TanStack adapters. Provider file handles are not exposed.

Go subscription inference can be configured with `baseURL: "https://opencode.ai/inference/go"`, a stable `x-opencode-session`, your own `User-Agent`, and an explicit `api` where Go routing differs (MiniMax and Qwen use Messages). See [Go configuration and verification](https://github.com/grikomsn/tanstack-ai-opencode-console/blob/main/docs/go.md) for credential requirements and live evidence.

See [full documentation and example app](https://github.com/grikomsn/tanstack-ai-opencode-console#readme), the [v2 inference reference](https://opencode.ai/v2/docs/console/inference/), and the [TanStack compatible adapter](https://tanstack.com/ai/latest/docs/adapters/openai-compatible).

Unofficial community project. MIT license.

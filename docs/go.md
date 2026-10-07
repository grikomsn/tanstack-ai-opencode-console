# Go inference

Go has a separate subscription gateway. Use the current root `https://opencode.ai/inference/go`; the adapter's default root remains Console's `https://opencode.ai/inference`. Device sign-in is shared, but a signed-in user or a public model catalog does not establish Go entitlement.

```ts
import { randomUUID } from "node:crypto";
import { opencodeConsoleText } from "tanstack-ai-opencode-console";

// Keep this ID stable across turns and tool calls in one conversation.
const conversationId = randomUUID();
const goConfig = {
  baseURL: "https://opencode.ai/inference/go",
  session: sessionAuth, // Or apiKey for an eligible Go workspace credential.
  defaultHeaders: {
    "User-Agent": "my-app/1.0",
    "x-opencode-session": conversationId,
  },
};

const adapter = opencodeConsoleText("minimax-m2.7", {
  ...goConfig,
  api: "messages",
});
```

Supply your own application user agent and a stable conversation ID, as required by [Go's client guide](https://opencode.ai/v2/docs/console/go/). User sessions send matching `x-org-id` and `x-opencode-org-id` headers for their selected workspace; additional headers cannot change that scope.

Go protocols can differ from Console's routing. Supply an explicit `api`:

| Examples                            | API                |
| ----------------------------------- | ------------------ |
| GLM, Kimi, DeepSeek                 | `chat-completions` |
| MiniMax, Qwen including Qwen3.8 Max | `messages`         |
| GPT, Grok                           | `responses`        |

These assignments follow the [Go endpoint guide](https://opencode.ai/v2/docs/console/go/). Discover available IDs with `listOpenCodeConsoleModels(goConfig)`. The public catalog does not prove subscription access.

The public guide still shows `/zen/go/v1` URLs. The upstream [migration proxy](https://github.com/anomalyco/opencode/blob/ecc4916b5a9608c30e6dd58a67f2137b594407ca/packages/console/app/src/lib/inference-proxy.ts) maps them to `/go/openai/v1`, `/go/anthropic/v1`, and `/go/v1/models` under the production inference root. This recipe uses that v2 destination directly. Legacy proxy key authentication does not establish device-token support.

## Live verification

```sh
npm run verify:go
npm run verify:go -- --device
npm run verify:go -- --model=glm-5.3-flash
```

The first command uses this project's server-side `OPENCODE_API_KEY`. `--device` starts a fresh sign-in; approve it for a workspace/member with an active Go subscription. Tokens stay in process memory. The verifier does not revoke other sessions or read another application's credentials.

Use `--org=<workspace-id>` with `--device` to require the exact approved workspace; a different workspace stops verification before inference. This is useful when comparing Console and Go access for one workspace.

The four small requests cover Chat Completions, Messages, and Responses, each capped at 128 output tokens with SDK retries disabled. Its fetch guard rejects inference outside `/inference/go/`. Results contain model IDs, statuses, completion flags, and safe failure categories; account names, tokens, prompts, and output text are excluded. Set `OPENCODE_GO_VERIFICATION_OUTPUT` to save non-secret JSON evidence. This verifier calls Go only; Console has separate verification records.

On October 7, 2026 a freshly approved, workspace-scoped device session successfully completed all four Go requests. Each returned HTTP 200, streamed text, and emitted `RUN_FINISHED` without `RUN_ERROR`:

| Model         | API                | Live result |
| ------------- | ------------------ | ----------- |
| GLM-5.3-Flash | `chat-completions` | Passed      |
| MiniMax M2.7  | `messages`         | Passed      |
| GPT-6-Luna    | `responses`        | Passed      |
| Qwen3.8 Max   | `messages`         | Passed      |

The same Go catalog returned 36 models. The configured project server key returned HTTP 403 for these four models; a diagnostic GLM request identified a Go subscription rejection. Those results establish that this device session had Go access and this project key did not. They do not establish entitlement for other users or credentials. The four Go requests did not call Console inference endpoints.

Console access and Go access were also checked independently for one Console-billed workspace. A workspace-scoped device session completed live Console requests across Chat Completions, Responses, and Messages, plus a browser tool round trip. A separately approved device session matched to the same workspace returned HTTP 403 with a Go subscription rejection for GLM-5.3-Flash. See the [Console results](verification/console-2026-10-07.json) and [Go rejection](verification/go-console-workspace-2026-10-07.json). Workspace names are removed from the public records. The public Go catalog was still readable; catalog access does not establish subscription access.

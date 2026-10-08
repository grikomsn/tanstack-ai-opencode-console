# Deploy the chat example to Vercel

Import this repository as one Vercel project with **Root Directory left at the repository root**, **Framework Preset set to Other**, and **Node.js 24.x**. Commit `vercel.json` with the app: it installs the npm workspaces, builds the adapter before function tracing, builds Vite into `examples/chat/dist`, and exposes seven explicit Node functions under `/api`. SPA navigation excludes API paths so unknown API routes return 404 rather than HTML.

This follows Vercel's [Node function handlers](https://vercel.com/docs/functions/functions-api-reference), [project configuration](https://vercel.com/docs/project-configuration/vercel-json), and [Node version selection](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions). The private repository workspace targets Node 24; the published adapter retains Node.js 22.19+ support.

## Shared Console sessions

Connect an **Upstash Redis** database through the [Vercel Marketplace](https://vercel.com/marketplace/upstash), or configure an existing database's HTTPS REST endpoint and full read/write REST token. The example uses the [Upstash REST API](https://upstash.com/docs/redis/features/restapi) directly, including Lua scripts for primary reads and owner-safe lock release. It adds no Redis SDK dependency.

Vercel's Upstash integration supplies `KV_REST_API_URL` and `KV_REST_API_TOKEN`; the backend accepts that pair automatically. Manual setup can use the `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` pair below. If either manual variable is present, both are required so credentials are never mixed between endpoints.

Set the following **server-side** environment variables for every environment you intend to deploy. Nothing uses a `VITE_` prefix.

| Variable                   | Required               | Value                                                                                                                                 |
| -------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `UPSTASH_REDIS_REST_URL`   | Yes                    | Database HTTPS REST root, such as `https://your-database.upstash.io`.                                                                 |
| `UPSTASH_REDIS_REST_TOKEN` | Yes                    | Full read/write REST token; read-only tokens cannot create or lock sessions.                                                          |
| `OPENCODE_SESSION_SECRET`  | Yes                    | Exactly 64 hexadecimal characters: a random 32-byte AES encryption key.                                                               |
| `OPENCODE_SESSION_PREFIX`  | Yes                    | Stable namespace such as `tanstack-opencode:production` or `tanstack-opencode:preview`.                                               |
| `OPENCODE_ALLOWED_ORIGINS` | For additional domains | Comma-separated exact HTTPS origins, including any custom domain not covered by Vercel's supplied project URL. No paths or wildcards. |
| `OPENCODE_MODEL`           | No                     | Preferred initial model, if available in the account's catalog. Defaults to `gpt-5-nano`.                                             |
| `OPENCODE_ALLOWED_MODELS`  | No                     | Comma-separated subset of discovered model IDs.                                                                                       |
| `OPENCODE_BASE_URL`        | No                     | Inference root, default `https://opencode.ai/inference`.                                                                              |

Generate the session key locally and paste the result into a sensitive Vercel environment variable:

```sh
openssl rand -hex 32
```

Use separate databases or distinct prefixes and encryption secrets for Production and Preview. Give independent previews separate prefixes when they must not share sessions. Keep a production prefix and key stable across redeployments; rotating the encryption key signs existing visitors out. Redis and function location should be close to reduce the latency of session reads and locks. This preparation does not provision storage or deploy the project.

The hosted demo offers **Console sign-in only**. Every visitor approves their own OpenCode workspace. It ignores any server `OPENCODE_API_KEY`, so an unsigned visitor cannot infer using the deployment owner's account. Access still depends on the visitor's OpenCode billing or subscription and selected inference root; deploying the example does not enable Go or grant model access.

The browser receives an opaque, random session ID in a `__Host-` cookie with `HttpOnly`, `Secure`, `SameSite=Strict`, and a 12-hour lifetime. Access tokens, refresh tokens, and device grant secrets are encrypted with AES-256-GCM in Redis, with matching TTLs. Ciphertext is authenticated against its visitor ID. Only the visible approval code/link and account/workspace metadata reach the browser. Chat history remains in browser memory and is not persisted in Redis.

Device polling advances during `/api/auth/status` requests, at most one token exchange per due poll; pending and `slow_down` deadlines are stored. There is no polling job relying on a warm function. A per-session distributed lock serializes approval, workspace selection, sign-out, and refresh rotation across instances. Once a token refresh starts, it finishes and persists its rotated token even if the browser disconnects. If another operation holds the session lock for more than ten seconds, the app reports a retryable busy status; an unsuccessful sign-out keeps the current session until a retry succeeds.

Changing the workspace, restarting sign-in, or signing out changes or removes the stored connection revision. Requests from old chat contexts are rejected; active streams check their visitor's revision every three seconds and cancel when it changes. Stop and browser disconnects cancel the request immediately. Sign-out deletes this demo's encrypted session and rotates the cookie to a fresh signed-out session; remote OAuth revocation is separate.

## Function and project settings

`vercel.json` enables Fluid Compute, request cancellation, and a 240-second function ceiling, with functions in Singapore (`sin1`) beside the session database. The chat has its own 120-second run deadline, a 60-second upstream request timeout, three model turns, and 2,048 output tokens per turn. Request input is limited to 128 KiB and 40 messages. Raw upstream and Redis errors never reach the browser. These settings use Vercel's documented [function configuration and cancellation](https://vercel.com/docs/functions/functions-api-reference).

Leave install, build, and output overrides unset in the dashboard so `vercel.json` applies. The repository's `24.x` engine selects the function runtime. Keep Preview Deployment Protection enabled while verifying the app. Before opening a public deployment, configure Vercel traffic/rate controls for anonymous status and device-start traffic: per-visitor Console authentication protects inference credentials, while anonymous sessions still consume function and Redis capacity.

Vercel supplies the deployment, branch, and primary production hostnames through `VERCEL_URL`, `VERCEL_BRANCH_URL`, and `VERCEL_PROJECT_PRODUCTION_URL`. Those exact HTTPS origins are accepted automatically. Add each extra custom domain through `OPENCODE_ALLOWED_ORIGINS`. Cross-origin POSTs are rejected; every authentication/chat POST must come from the app's own origin.

## Verify a preview

Run the repository checks before creating a deployment:

```sh
npm ci
npm run check
```

After configuring the project and environment variables, create a Preview deployment and verify:

1. `/api/auth/status` returns JSON, a signed-out state, and a secure opaque cookie. Missing configuration returns a safe 503.
2. `/api/unknown` returns 404, while frontend navigation still loads the app.
3. Sign in, approve a workspace, and confirm that its account/workspace appears before chatting. Refresh the page and confirm the session survives.
4. Repeat in a private browser window with another account/workspace. Confirm neither window sees the other's identity or conversation.
5. Send a short prompt, try the current-time tool, and use Stop during a longer reply.
6. Sign out in another tab of the same browser while a reply is running. The account clears and the stream stops within the three-second revision check interval plus storage latency; the private window stays signed in.

Local fixtures cover shared sessions across independently created handlers, encrypted credential isolation, polling/slow-down timing, refresh rotation, scoped workspaces, real adapter text/tool streams, cancellation, and input/origin constraints. A local build using Vercel's official Node builder also traced the API handler and workspace adapter without including `.env` files. These are preparation checks; a deployed preview and a live Upstash database must still be verified after deployment.

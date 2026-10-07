# Authentication and verification

The inference adapter supports service-account keys and user session tokens. Device authorization is a separate server-only Console API surface exposed by `tanstack-ai-opencode-console/auth`; inference continues to use `https://opencode.ai/inference`.

| Authentication        | Configuration                                           | Rotation and storage                                      |
| --------------------- | ------------------------------------------------------- | --------------------------------------------------------- |
| Service account       | `apiKey`, or `OPENCODE_API_KEY`                         | Caller-owned key or supplier                              |
| Existing user session | `session: {accessToken, orgId}`                         | Caller-owned session or cancellable supplier              |
| Fresh device sign-in  | `/auth` start/poll helpers, then `session: sessionAuth` | In-memory automatic refresh; caller-owned durable storage |

Session configuration overrides the environment key and cannot be combined with an explicit `apiKey`. All inference protocols receive `Authorization: Bearer` and user sessions also receive matching `x-org-id` and `x-opencode-org-id` headers. The transport protects these session headers from native SDK keys and caller-supplied headers. Requests cannot leave the configured inference root or follow redirects.

## Device grants

`requestOpenCodeConsoleDeviceCode({server?, clientId?, fetch?, signal?})` sends `supports_org_scope:true` to the Console device endpoint. The default client ID is `tanstack-ai-opencode-console`; the deployed approval page currently calls unrecognized client IDs "Unknown client". The adapter preserves its own client identity.

Only `verificationUrl`, `userCode`, and expiration belong in the browser UI. Keep `deviceCode` on the server. `completeOpenCodeConsoleDeviceSignIn(device, {fetch?, signal?})` respects the polling interval, increases it by five seconds on `slow_down`, and terminates on denial, expiry, or cancellation. Successful authorization discovers the account and organizations without logging credentials.

Token lifetimes are independent of JavaScript timer limits; a 30-day access token is valid. Polling delays remain within the timer limit. `OpenCodeConsoleAuthError` exposes safe `stage` and optional HTTP `status` metadata for protocol failures. The example reports these failures without forwarding response bodies or credentials, and retries its initial status connection while the development API starts.

If the token response includes `org_id`, the session records it as `scopedOrgId` and selects that organization. Refresh preserves the binding and rejects changes. Account-wide legacy sessions with one organization select it automatically; multiple organizations require explicit selection. Switching a bound grant requires a new sign-in.

`createOpenCodeConsoleSessionAuth(session, {fetch?})` returns a supplier with `getSession()`, `selectOrganization(id)`, `refresh(signal?)`, and `clear()`. It refreshes within one minute of expiration, serializes refresh per instance, and isolates a cancelled caller from other requests sharing that refresh. Returned snapshots are copies. Rotated tokens remain in this supplier's memory; applications that need persistence must save the new snapshot to their own secure store. `refreshOpenCodeConsoleSession` also works without the supplier.

`clear()` forgets local state and cancels its refresh. It does not revoke a remote session. `revokeOpenCodeConsoleSession(session, {fetch?, signal?})` sends the refresh token to the OAuth revocation endpoint advertised by Console. HTTP acceptance alone does not prove revocation; verify that the revoked refresh token is rejected. The example's sign-out clears local memory only.

## Verification before publication

`npm run check` covers mocked device grants, token rotation, scope binding, concurrent refresh, aborts, malformed/error responses, protected transport headers, all four protocol SDKs, and the example's browser-safe auth responses. Packed-package validation imports and typechecks the public `/auth` entry.

Run the optional interactive check separately:

```sh
npm run verify:auth
```

It starts a new sign-in, prints only the approval URL and user-facing code, then verifies refresh rotation, one small Responses request capped at 128 output tokens, and refresh-token revocation. The model is selected from that workspace's catalog, preferring `gpt-5-nano` when present. It requires browser approval and an eligible workspace with credits. It does not load an environment API key or another application's credentials. Tokens exist only in process memory and are cleared at exit. This command is never part of CI.

Live verification on October 7, 2026 completed fresh device approval with a workspace-bound, 30-day access token, followed by account and organization discovery. The example completed Console inference through Chat Completions, Responses, and Messages, plus a browser tool round trip. Separate device-session tests completed Go inference for a Go-enabled workspace and received a Go subscription rejection for a Console-billed workspace without Go access. See the [Console record](verification/console-2026-10-07.json) and [Go verification](go.md).

Refresh rotation and remote revocation are covered by fixtures and the optional interactive helper, but have not been verified live. Live sign-in and inference do not establish those outcomes. The expiry parser accepts the 30-day token lifetime observed during these checks; token lifetimes remain separate from polling timer limits.

## Protocol evidence

The [current OpenCode provider](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/core/src/plugin/provider/opencode.ts) implements Console device start, polling, refresh, and account/org discovery. The deployed [Console API client](https://opencode.ai/console/assets/index-BnMp0JQS.js) exposes workspace-scoped device grants and optional `org_id`; the [approval page](https://opencode.ai/console/assets/page-sZ5ONOW1.js) distinguishes workspace access from account-wide access. Asset URLs are evidence from this date and may change with deployments.

The [authorization-server metadata](https://opencode.ai/console/.well-known/oauth-authorization-server) advertises `/auth/oauth/revoke` without client authentication. The [Console guide](https://console.opencode.ai/guides) describes user session tokens with organization headers. The [v2 inference reference](https://opencode.ai/v2/docs/console/inference/) documents service keys and universal Bearer auth; it currently does not describe device authentication in detail. Browser authorization-code/PKCE and provider-specific third-party OAuth integrations are outside this adapter's device/session API.

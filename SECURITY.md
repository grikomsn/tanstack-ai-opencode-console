# Security

Load the adapter's main entry only on the server. Service account keys belong in server environment variables or caller-managed secret storage; the adapter never reads another application's credentials. The separate `/byok` entry contains only a provider descriptor.

The `/auth` entry is also server-only. Keep device codes, access tokens, and refresh tokens out of browser responses and logs. Device sign-in requests a workspace-scoped grant. Persist rotated refresh tokens in caller-managed secure storage if sessions must survive restarts; the example keeps them only in server memory. Local sign-out clears local state; remote token revocation is a separate operation.

The chat example is a local development app bound to loopback. Before exposing a relay publicly, add authentication, rate limits, origin policy, and spending controls appropriate to your application.

Report credential exposure or security defects through [a private GitHub security advisory](https://github.com/grikomsn/tanstack-ai-opencode-console/security/advisories/new), without including real keys or private conversations.

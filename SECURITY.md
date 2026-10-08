# Security

Load the adapter's main entry only on the server. Service account keys belong in server environment variables or caller-managed secret storage; the adapter never reads another application's credentials. The separate `/byok` entry contains only a provider descriptor.

The `/auth` entry is also server-only. Keep device codes, access tokens, and refresh tokens out of browser responses and logs. Device sign-in requests a workspace-scoped grant. Persist rotated refresh tokens in caller-managed secure storage if sessions must survive restarts; the local example keeps them only in server memory, while the Vercel example encrypts per-visitor credentials in shared Redis storage. Local sign-out clears local state; remote token revocation is a separate operation.

The local chat server binds to loopback and shares one session among its tabs. The Vercel backend uses a separate opaque cookie and encrypted Redis session for each visitor, exact-origin request checks, and the visitor's own Console account. It does not expose an owner service key. Configure deployment traffic/rate controls before public access and keep storage secrets server-side; see [the Vercel guide](docs/vercel.md).

Report credential exposure or security defects through [a private GitHub security advisory](https://github.com/grikomsn/tanstack-ai-opencode-console/security/advisories/new), without including real keys or private conversations.

# Releases

Find installable versions on [npm](https://www.npmjs.com/package/tanstack-ai-opencode-console) and release notes and downloads on [GitHub](https://github.com/grikomsn/tanstack-ai-opencode-console/releases).

## 0.1.0 — October 7, 2026

The first public release connects TanStack AI to OpenCode v2 hosted inference. It delegates Chat Completions, Responses, Messages, and Gemini to native TanStack adapters, supports service keys and workspace-scoped Console device sign-in, and includes a private React chat example. [Go inference](go.md) uses a separate gateway with explicit protocol overrides and requires subscription access.

```sh
npm install @tanstack/ai tanstack-ai-opencode-console
```

Requires Node.js 22.19+ and `@tanstack/ai` 0.65.x.

- [npm version 0.1.0](https://www.npmjs.com/package/tanstack-ai-opencode-console/v/0.1.0)
- [GitHub release and downloads](https://github.com/grikomsn/tanstack-ai-opencode-console/releases/tag/tanstack-ai-opencode-console%400.1.0)
- Source tag: `tanstack-ai-opencode-console@0.1.0`, commit `76f82b6b6c963a27ab1c947864aecb30019934cb`.

The published archive contains 19 files. Its anonymous registry download matched the reviewed checksum, and a fresh consumer imported the main, `/auth`, and `/byok` entries successfully. Builds, types, formatting, package validation, and 104 fixture tests passed on Node 22, 24, and 26. Separate [Console authentication](authentication.md) and [Go verification](go.md) records describe the live checks and their limits.

This bootstrap release was published locally without provenance. Future releases can use [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) from a supported CI environment. The GitHub release includes the exact npm archive and a `SHA256SUMS` file for download verification.

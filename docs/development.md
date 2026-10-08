# Development and releases

Use Node.js 24.x and npm for this workspace (`.node-version` pins the local patch release). The published adapter supports Node.js 22.19+; CI also checks adapter compatibility on Node 22 and 26. The root lockfile covers the publishable adapter in `packages/tanstack-ai-opencode-console` and the private Vite/React example in `examples/chat`.

```sh
npm ci
npm run check
```

`check` verifies formatting, builds the adapter and browser app, checks both workspaces' types, runs Node tests with injected network fixtures, then packs the adapter and installs it into a temporary consumer. The consumer imports the main, auth, and BYOK exports and compiles their public TypeScript types. Local CI does not prove a paid model, authentication account, or remote deployment works.

For iteration:

```sh
npm run test --workspace tanstack-ai-opencode-console
npm run typecheck --workspace tanstack-ai-opencode-console
npm run dev
```

The example loads the root `.env` and optional `examples/chat/.env`. Keep both files out of Git. Do not prefix service keys with `VITE_`.

## Architecture

- `src/routing.ts`: model-family mapping and v2 URL normalization.
- `src/transport.ts`: caller-managed credential resolution, universal Bearer auth, fetch injection, timeout, and cancellation.
- `src/models.ts`: live availability catalog parsing and discovery.
- `src/adapter.ts`: `BaseTextAdapter` facade over native TanStack protocols; preserves tool-call metadata and native structured-output fallback.
- `src/byok.ts`: isolated browser-safe descriptor; no SDK imports.
- `src/auth.ts`: isolated server-only device authorization, workspace scoping, refresh, revocation, and in-memory session supplier.

Service keys and user sessions share the v2 inference transport. The separate Console device-auth surface creates fresh sessions without importing another application's credentials. Sibling Pi/VS Code projects informed naming, npm tooling, transport separation, and tests. Legacy Zen inference routes are not used. Model routing follows the official endpoint table, including Qwen3.8 Max and Jev exceptions. Update routing with current primary-source evidence and tests when the gateway changes; do not copy prices or guessed modalities into discovery.

## Publishing

Version [0.1.0](https://www.npmjs.com/package/tanstack-ai-opencode-console/v/0.1.0) was published locally without provenance to bootstrap the npm package. The matching [GitHub release](https://github.com/grikomsn/tanstack-ai-opencode-console/releases/tag/tanstack-ai-opencode-console%400.1.0) uses the source tag `tanstack-ai-opencode-console@0.1.0`. See [release history](releases.md) for artifact and verification details. Review every release with `npm run check`, then publish the adapter workspace from its configured CI environment when authorized:

```sh
npm publish --workspace tanstack-ai-opencode-console
```

The package keeps `publishConfig.provenance:true` for future CI releases. An explicitly approved local publish can override it for that invocation with `npm publish --workspace tanstack-ai-opencode-console --provenance=false`. Configure [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) for future releases with provenance from a supported CI environment.

For later changes, add a Changeset, run `npm run version-packages`, review version/changelog updates, and use `npm run release`. The example and root are private and cannot be published by Changesets.

The CI workflow runs on the pinned Node 22, 24, and 26 patch releases on Ubuntu 26.04. Checkout and setup-node use full release commit SHAs, with their version tags recorded in comments. There is no automatic publishing workflow. Submitting this package to TanStack's community adapter list is a separate upstream change, following the [community guide](https://tanstack.com/ai/latest/docs/community-adapters/guide).

Direct runtime and development dependencies use exact stable versions; the public `@tanstack/ai` peer dependency retains its compatible `^0.65.0` range. The lockfile fixes transitive versions within the upstream packages' supported ranges. Do not force a newer SDK major through overrides when the native TanStack adapter depends on an older major. Recheck stable npm dist-tags and the action release tags when updating these pins. GitHub-hosted runner labels fix the OS release; GitHub maintains the VM image builds behind those labels.

The development runner `concurrently` pins an older `shell-quote` release. A scoped override selects `shell-quote` 1.12.0 to address its [command-injection advisory](https://github.com/advisories/GHSA-pqg4-j6r4-53mv). Keep this override until the runner updates its dependency, and check both `npm audit` and runner startup when changing it.

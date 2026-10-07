# Contributing

Run `npm ci` with Node 22.19+ and `npm run check` before submitting a change. Keep changes focused, use strict TypeScript, and cover routing/transport behavior with injected fetch fixtures rather than live model calls.

Add a Changeset for published-package changes after the initial release. Update the README when configuration, routes, supported workflows, or compatibility requirements change. Keep service keys, account state, private prompts, and captured responses out of commits and logs.

See [development instructions](docs/development.md) for the workspace structure and release checks.

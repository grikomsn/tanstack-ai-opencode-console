# Repository guidance

This npm workspace contains a published ESM TypeScript package under `packages/tanstack-ai-opencode-console` and a private chat example under `examples/chat`. Use Node.js 22.19+ and npm; `package-lock.json` is authoritative.

- Follow strict TypeScript, double quotes, and two-space indentation.
- Use the OpenCode **v2 inference** root `https://opencode.ai/inference`. Legacy Zen paths, CLI harnesses, and device OAuth are separate integration surfaces.
- Reuse TanStack's protocol adapters. Keep routing, transport authentication, and catalog parsing covered by injected network fixtures.
- Keep credentials server-side. Never read another application's credential store or log keys/prompts.
- Preserve cancellation and reasoning/tool-call continuity. Never retry a partially consumed stream.
- The public catalog reports availability, not complete capabilities. Do not invent model limits, prices, or modality guarantees.
- Run `npm run check` before handing off. Packaging must exclude secrets, examples, test fixtures, and generated logs.
- Use Changesets for published-package changes after the initial release. Publishing or pushing requires a user request.

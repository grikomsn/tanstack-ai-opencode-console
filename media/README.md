# Brand assets

`header-opencode-console.png` is a 2172 × 724 dedicated community-adapter header created with the built-in imagegen tool. It adapts the user-provided TanStack AI banner composition and incorporates the official OpenCode mark. The banner labels this repository as a community adapter.

The root README loads the local image. The package README uses its GitHub-hosted URL so the banner stays outside the npm tarball. Publish the repository asset before publishing the README update.

The example uses the original OpenCode SVG at `examples/chat/public/opencode-mark-dark.svg`. Its geometry and colors are unchanged; Vite serves it locally, without contacting a third-party asset host.

## References

- [TanStack AI README](https://github.com/TanStack/ai) — centered banner, badges, and quick navigation.
- [TanStack AI basic chat](https://tanstack.com/ai/latest/docs/framework/react/examples/basic-chat) and [source](https://github.com/TanStack/ai/tree/main/examples/react/basic-chat) — slate surfaces, orange accents, and assistant message treatment.
- [OpenCode brand assets](https://opencode.ai/brand) and [SVG source](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/asset/brand/opencode-logo-dark.svg) — official OpenCode mark.

The TanStack and OpenCode marks identify the integrated projects. This repository is an independent community project. See the upstream [TanStack license](https://github.com/TanStack/ai/blob/main/LICENSE) and [OpenCode license](https://github.com/anomalyco/opencode/blob/dev/LICENSE) for their source assets.

## Header prompt

Mode: built-in imagegen, compositing edit. Inputs: the user-supplied TanStack AI header and the official OpenCode square PNG.

```text
Use case: compositing
Asset type: a dedicated GitHub and npm README header banner for tanstack-ai-opencode-console.
Primary request: adapt the first reference (the official TanStack AI header) into an equally restrained header for the community OpenCode Console inference adapter. Use the second input as the exact OpenCode logo insert.
Input images: Image 1 is the edit target and style/composition reference; Image 2 is the supporting OpenCode logo on transparency. Do not use the brand preview checkerboard or editor selection handles.
Scene/backdrop: uniform near-black #111111, same as the original banner. Preserve the thin orange #e66845 stripe across the full bottom edge.
Style/medium: flat, clean brand graphic with sharp sans-serif typography, generous negative space, no decorative illustration.
Composition/framing: very wide horizontal README banner, ideally 1800 by 450 pixels with the same 4:1 aspect ratio as Image 1. Keep the original cream palm/waves TanStack emblem on the left, make room for the official geometric OpenCode emblem immediately to its right with a small muted multiplication sign between them. Both emblems should be compact and balanced. Begin the text block to the right of the paired logos, with all text comfortably inside the canvas.
Text (verbatim), only these four lines:
"COMMUNITY ADAPTER" (small muted cream uppercase)
"TanStack AI" (medium cream)
"OpenCode Console" (large orange, primary title)
"OpenCode v2 inference for TanStack AI." (smaller muted cream subtitle)
Constraints: keep the original TanStack palm emblem recognizable and the provided OpenCode mark geometrically accurate (cream rectangular frame, dark top aperture, gray lower interior). Do not fuse or redesign either logo. Match the reference's near-black, cream, muted warm gray and orange palette. Clear crisp text, no clipped text. This is explicitly a community adapter, not an official joint product. No additional slogans, badges, gradients, shadows, textures, watermarks, browser UI, blue outlines or selection handles.
```

import type { OpenCodeConsoleApi } from "./types.js";

export const OPENCODE_CONSOLE_BASE_URL = "https://opencode.ai/inference";

/** Infer a wire protocol, with exact exceptions ahead of family defaults. */
export function resolveOpenCodeConsoleApi(
  model: string,
): OpenCodeConsoleApi | "systemone" {
  const id = validateModelId(model).toLowerCase();
  if (/^jev(?:-|$)/.test(id)) return "systemone";
  // The endpoint table gives this model a different API from other Qwen models.
  if (id === "qwen3.8-max") return "chat-completions";
  if (/^(gpt-|grok(?:-|$)|muse-spark-)/.test(id)) return "responses";
  if (/^(claude-|qwen)/.test(id)) return "messages";
  if (/^gemini-/.test(id)) return "gemini";
  return "chat-completions";
}

/** IDs here are gateway IDs, without the CLI's `opencode/` prefix. */
export function validateModelId(model: string): string {
  if (
    typeof model !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(model)
  ) {
    throw new Error(
      "Use an OpenCode inference model ID, such as gpt-5.5 or big-pickle, without a provider prefix.",
    );
  }
  return model;
}

export function normalizeBaseURL(baseURL = OPENCODE_CONSOLE_BASE_URL): string {
  const url = new URL(baseURL);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "baseURL must be an HTTP(S) inference root without credentials, query, or fragment.",
    );
  }
  return url.href.replace(/\/+$/, "");
}

export function protocolBaseURL(root: string, api: OpenCodeConsoleApi): string {
  switch (api) {
    case "chat-completions":
    case "responses":
      return `${root}/openai/v1`;
    case "messages":
      // Anthropic's SDK adds /v1/messages.
      return `${root}/anthropic`;
    case "gemini":
      // Google's SDK adds /v1beta/models/<model>:<method>.
      return `${root}/google`;
    default:
      throw new Error("Unsupported OpenCode inference API.");
  }
}

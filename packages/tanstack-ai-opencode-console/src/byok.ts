import { defineByokProvider } from "@tanstack/ai/byok";

/** Browser-safe provider descriptor: this subpath imports no inference SDKs. */
export const opencodeConsoleByok = defineByokProvider({
  id: "opencode-console",
  label: "OpenCode Console",
  env: "OPENCODE_API_KEY",
});

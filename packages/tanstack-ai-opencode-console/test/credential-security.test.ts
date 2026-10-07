import assert from "node:assert/strict";
import test from "node:test";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { opencodeConsoleText } from "../src/index.js";

test("Gemini error events never echo malformed credentials or request headers", async () => {
  const sensitive = "fixture-sensitive-credential";
  const invalid = `${sensitive}\ninvalid`;
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return Response.json({});
  };
  for (const config of [
    { apiKey: invalid },
    { session: { accessToken: invalid, orgId: "fixture-org" } },
  ]) {
    const adapter = opencodeConsoleText("gemini-3.1-pro", {
      ...config,
      fetch: fetcher,
    });
    let errors = 0;
    for await (const chunk of adapter.chatStream({
      model: "gemini-3.1-pro",
      messages: [{ role: "user", content: "Fixture input" }],
      logger: resolveDebugOption(false),
    })) {
      assert.equal(JSON.stringify(chunk).includes(sensitive), false);
      if (chunk.type === "RUN_ERROR") {
        errors++;
        assert.match(chunk.message, /HTTP headers.*invalid/);
      }
    }
    assert.equal(errors, 1);
  }
  assert.equal(calls, 0);
});

import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { chat } from "@tanstack/ai";
import {
  opencodeConsoleText,
  listOpenCodeConsoleModels,
} from "tanstack-ai-opencode-console";
import {
  requestOpenCodeConsoleDeviceCode,
  completeOpenCodeConsoleDeviceSignIn,
  createOpenCodeConsoleSessionAuth,
} from "tanstack-ai-opencode-console/auth";

const root = "https://opencode.ai/inference/go";
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
const deviceMode = process.argv.includes("--device");
const expectedOrg = process.argv
  .find((arg) => arg.startsWith("--org="))
  ?.slice("--org=".length);
const chosenModel = process.argv
  .find((arg) => arg.startsWith("--model="))
  ?.slice("--model=".length);
const testCases = [
  ["glm-5.3-flash", "chat-completions"],
  ["minimax-m2.7", "messages"],
  ["gpt-6-luna", "responses"],
  ["qwen3.8-max", "messages"],
];
class VerificationError extends Error {}
let auth;
const results = {
  root,
  credential: deviceMode ? "device-session" : "project-server-key",
  tests: [],
};

// Fail closed: this verifier can never make a Console inference call.
function onlyGo(record) {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (
      url.origin !== "https://opencode.ai" ||
      !url.pathname.startsWith("/inference/go/")
    )
      throw new Error("Go verification refused a request outside the Go root.");
    const response = await fetch(input, { ...init, redirect: "error" });
    let failure;
    if (!response.ok) {
      const body = await response.clone().text();
      failure = /cloudflare|access denied|error 1020/i.test(body)
        ? "gateway-access"
        : /subscription|subscribe|go plan/i.test(body)
          ? "go-subscription"
          : /balance|credits|quota/i.test(body)
            ? "quota"
            : /protocol|unsupported/i.test(body)
              ? "protocol"
              : /session/i.test(body)
                ? "session"
                : response.status === 401
                  ? "authentication"
                  : "unspecified";
    }
    record?.push({
      path: url.pathname,
      status: response.status,
      ...(failure ? { failure } : {}),
    });
    return response;
  };
}

try {
  if (
    process.argv
      .slice(2)
      .some(
        (arg) =>
          arg !== "--device" &&
          !arg.startsWith("--model=") &&
          !arg.startsWith("--org="),
      )
  )
    throw new VerificationError(
      "Use --device, --model=<ID>, or --org=<workspace-id>.",
    );
  if (
    chosenModel !== undefined &&
    !testCases.some(([model]) => model === chosenModel)
  )
    throw new VerificationError(
      "Choose one of the four documented Go verification models.",
    );
  if (expectedOrg !== undefined && (!deviceMode || !expectedOrg))
    throw new VerificationError(
      "--org requires --device and a non-empty workspace ID.",
    );
  if (deviceMode) {
    const device = await requestOpenCodeConsoleDeviceCode({
      signal: controller.signal,
    });
    console.log(
      JSON.stringify({
        stage: "approve",
        verificationUrl: device.verificationUrl,
        userCode: device.userCode,
      }),
    );
    const session = await completeOpenCodeConsoleDeviceSignIn(device, {
      signal: controller.signal,
    });
    if (!session.orgId)
      throw new VerificationError("Select a workspace during device approval.");
    if (expectedOrg) {
      results.workspaceMatched = session.orgId === expectedOrg;
      if (!results.workspaceMatched)
        throw new VerificationError(
          "The approved workspace differs from the requested workspace.",
        );
    }
    auth = createOpenCodeConsoleSessionAuth(session);
    results.workspaceScoped = Boolean(session.scopedOrgId);
  } else if (!process.env.OPENCODE_API_KEY?.trim()) {
    throw new VerificationError(
      "Set this project's OPENCODE_API_KEY, or run verify:go with --device.",
    );
  }
  const config = {
    baseURL: root,
    ...(auth ? { session: auth } : { apiKey: process.env.OPENCODE_API_KEY }),
    timeout: 45_000,
    maxRetries: 0,
    defaultHeaders: { "User-Agent": "tanstack-ai-opencode-console/0.1.0" },
    fetch: onlyGo(),
  };
  const models = await listOpenCodeConsoleModels(config, {
    signal: controller.signal,
  });
  results.catalogCount = models.length;
  for (const [model, api] of testCases) {
    if (chosenModel && model !== chosenModel) continue;
    if (!models.some((candidate) => candidate.id === model)) {
      results.tests.push({ model, api, skipped: "not in Go catalog" });
      continue;
    }
    const requests = [];
    let textChunks = 0,
      thinkingChunks = 0,
      finished = false,
      error = false,
      usage;
    try {
      const stream = chat({
        adapter: opencodeConsoleText(model, {
          ...config,
          api,
          defaultHeaders: {
            ...config.defaultHeaders,
            "x-opencode-session": randomUUID(),
          },
          fetch: onlyGo(requests),
        }),
        messages: [{ role: "user", content: "Reply with the word OK." }],
        modelOptions:
          api === "responses"
            ? { max_output_tokens: 128 }
            : { max_tokens: 128 },
        abortController: controller,
        debug: false,
      });
      for await (const event of stream) {
        if (event.type === "TEXT_MESSAGE_CONTENT" && event.delta) textChunks++;
        if (event.type === "REASONING_MESSAGE_CONTENT" && event.delta)
          thinkingChunks++;
        if (event.type === "RUN_FINISHED") {
          finished = true;
          usage = event.usage;
        }
        if (event.type === "RUN_ERROR") error = true;
      }
    } catch {
      error = true;
    }
    results.tests.push({
      model,
      api,
      requests,
      textChunks,
      thinkingChunks,
      finished,
      error,
      ...(usage ? { usage } : {}),
      passed:
        requests.length > 0 &&
        requests.every((x) => x.status === 200) &&
        textChunks > 0 &&
        finished &&
        !error,
    });
    console.log(JSON.stringify(results.tests.at(-1)));
  }
  if (!results.tests.some((result) => typeof result.passed === "boolean"))
    throw new VerificationError(
      "None of the selected test models were in Go's catalog.",
    );
  if (results.tests.some((result) => result.passed === false))
    process.exitCode = 1;
} catch (error) {
  // Never output provider error bodies, tokens, or prompts.
  results.error =
    error instanceof VerificationError
      ? error.message
      : deviceMode
        ? "Go device verification could not complete."
        : "Go server-key verification could not complete.";
  process.exitCode = 1;
} finally {
  auth?.clear();
  const output = process.env.OPENCODE_GO_VERIFICATION_OUTPUT;
  if (output) await writeFile(output, JSON.stringify(results, null, 2) + "\n");
  console.log(JSON.stringify({ stage: "result", ...results }));
}

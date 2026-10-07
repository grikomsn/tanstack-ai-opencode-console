import { chat } from "@tanstack/ai";
import {
  opencodeConsoleText,
  listOpenCodeConsoleModels,
} from "tanstack-ai-opencode-console";
import {
  requestOpenCodeConsoleDeviceCode,
  completeOpenCodeConsoleDeviceSignIn,
  createOpenCodeConsoleSessionAuth,
  refreshOpenCodeConsoleSession,
  revokeOpenCodeConsoleSession,
  OpenCodeConsoleAuthError,
} from "tanstack-ai-opencode-console/auth";

// Opt-in, interactive verification. Tokens exist only in this process's memory.
// No environment API key or another application's credential store is read.
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
const results = {};
class VerificationError extends Error {}
let auth;
try {
  const device = await requestOpenCodeConsoleDeviceCode({
    signal: controller.signal,
  });
  console.log(
    JSON.stringify({
      stage: "approve",
      verificationUrl: device.verificationUrl,
      userCode: device.userCode,
      expiresAt: device.expiresAt,
    }),
  );
  const session = await completeOpenCodeConsoleDeviceSignIn(device, {
    signal: controller.signal,
  });
  auth = createOpenCodeConsoleSessionAuth(session);
  if (!session.orgId)
    throw new VerificationError(
      "Select a workspace during sign-in, then restart verification.",
    );
  results.deviceSignIn = "passed";
  results.workspaceScoped = Boolean(session.scopedOrgId);
  const refreshed = await auth.refresh(controller.signal);
  results.refreshRotation = refreshed.refreshToken !== session.refreshToken;
  const models = await listOpenCodeConsoleModels(
    { session: auth, maxRetries: 0, timeout: 60_000 },
    { signal: controller.signal },
  );
  const responses = models.filter(
    (model) => model.supported && model.api === "responses",
  );
  const model =
    responses.find((model) => model.id === "gpt-5-nano") ??
    responses.find((model) => /^gpt-.*-luna$/.test(model.id)) ??
    responses[0];
  if (!model)
    throw new VerificationError(
      "The approved workspace lists no Responses model for this auth check.",
    );
  results.model = model.id;
  const statuses = [];
  let textChunks = 0;
  let runFinished = false;
  let runError = false;
  const api = opencodeConsoleText(model.id, {
    session: auth,
    maxRetries: 0,
    timeout: 60_000,
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      statuses.push(response.status);
      return response;
    },
  });
  try {
    for await (const event of chat({
      adapter: api,
      messages: [{ role: "user", content: "Reply with OK." }],
      modelOptions: { max_output_tokens: 128 },
      abortController: controller,
    })) {
      if (event.type === "TEXT_MESSAGE_CONTENT" && event.delta) textChunks++;
      if (event.type === "RUN_FINISHED") runFinished = true;
      if (event.type === "RUN_ERROR") runError = true;
    }
  } catch {
    runError = true;
  }
  results.inference = { statuses, textChunks, runFinished, runError };
  const latest = auth.getSession();
  await revokeOpenCodeConsoleSession(latest, { signal: controller.signal });
  results.revocationEndpoint = "accepted";
  let revokedRefreshStatus;
  try {
    await refreshOpenCodeConsoleSession(latest, {
      signal: controller.signal,
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        revokedRefreshStatus = response.status;
        return response;
      },
    });
    results.revokedRefreshRejected = false;
  } catch {
    results.revokedRefreshRejected = [400, 401, 403].includes(
      revokedRefreshStatus,
    );
  }
  results.revokedRefreshStatus = revokedRefreshStatus;
  if (
    statuses.some((status) => status !== 200) ||
    !textChunks ||
    !runFinished ||
    runError ||
    !results.refreshRotation ||
    !results.revokedRefreshRejected
  )
    process.exitCode = 1;
} catch (error) {
  results.error =
    error instanceof OpenCodeConsoleAuthError ||
    error instanceof VerificationError
      ? error.message
      : "Console verification could not complete.";
  process.exitCode = 1;
} finally {
  auth?.clear();
  console.log(JSON.stringify({ stage: "result", ...results }));
}

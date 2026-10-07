import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createExampleServer } from "../server.js";
import type { Server } from "node:http";
import type { ExampleAuthState } from "../auth.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await delay(20);
  }
  assert.fail("Timed out waiting for the provider connection to close.");
}

function payload(
  model = "fake-chat",
  toolsEnabled = false,
  connectionRevision?: string,
) {
  return {
    threadId: "test-thread",
    runId: "test-run",
    messages: [{ id: "user-1", role: "user", content: "Hello" }],
    tools: [],
    context: [],
    forwardedProps: {
      model,
      toolsEnabled,
      ...(connectionRevision === undefined ? {} : { connectionRevision }),
    },
    state: {},
  };
}

async function fixture(
  mode: "text" | "tool" | "error" | "slow" = "text",
  allowedModels?: string[],
  scopedOrganization?: string,
  authFailure?: "account" | "organizations",
  holdCatalog = false,
) {
  const requests: Array<{
    path: string;
    authorization: string | undefined;
    orgId?: string;
    body?: Record<string, unknown>;
  }> = [];
  let providerDisconnected = false;
  let tokenPolls = 0;
  let releaseCatalog: (() => void) | undefined;
  const catalogGate = holdCatalog
    ? new Promise<void>((resolve) => {
        releaseCatalog = resolve;
      })
    : undefined;
  const provider = createServer(async (request, response) => {
    if (request.url?.startsWith("/console/")) {
      let raw = "";
      for await (const chunk of request) raw += String(chunk);
      const body = raw
        ? (JSON.parse(raw) as Record<string, unknown>)
        : undefined;
      requests.push({
        path: request.url,
        authorization: request.headers.authorization,
        body,
      });
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/console/auth/device/code") {
        response.end(
          JSON.stringify({
            device_code: "device-secret-code",
            user_code: "SHOW-CODE",
            verification_uri_complete: `http://${request.headers.host}/console/auth/device?user_code=SHOW-CODE`,
            expires_in: 300,
            interval: 1,
          }),
        );
      } else if (request.url === "/console/auth/device/token") {
        tokenPolls++;
        if (tokenPolls === 1) {
          response.writeHead(400);
          response.end(JSON.stringify({ error: "authorization_pending" }));
        } else {
          response.end(
            JSON.stringify({
              access_token: "session-secret-access",
              refresh_token: "session-secret-refresh",
              token_type: "Bearer",
              expires_in: 3600,
              ...(scopedOrganization ? { org_id: scopedOrganization } : {}),
            }),
          );
        }
      } else if (request.url === "/console/api/user") {
        if (authFailure === "account") {
          response.writeHead(401);
          response.end(
            JSON.stringify({
              error: "session-secret-access session-secret-refresh",
            }),
          );
          return;
        }
        response.end(
          JSON.stringify({ id: "account-demo", email: "demo@example.test" }),
        );
      } else if (request.url === "/console/api/orgs") {
        if (authFailure === "organizations") {
          response.writeHead(403);
          response.end(
            JSON.stringify({
              error: "session-secret-access session-secret-refresh",
            }),
          );
          return;
        }
        response.end(
          JSON.stringify([
            { id: "org-one", name: "One" },
            { id: "org-two", name: "Two" },
          ]),
        );
      } else {
        response.writeHead(404);
        response.end(JSON.stringify({ error: "not_found" }));
      }
      return;
    }
    if (request.url === "/inference/v1/models") {
      requests.push({
        path: request.url,
        authorization: request.headers.authorization,
      });
      await catalogGate;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          data: [
            { id: "fake-chat" },
            { id: "other-chat" },
            { id: "gpt-5-nano" },
            { id: "jev-test" },
          ],
        }),
      );
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw) as Record<string, unknown>;
    requests.push({
      path: request.url ?? "",
      authorization: request.headers.authorization,
      orgId: request.headers["x-org-id"] as string | undefined,
      body,
    });
    if (mode === "error") {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "Unauthorized test-only-secret-key",
            type: "authentication_error",
          },
        }),
      );
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: unknown, finishReason: string | null = null) => {
      response.write(
        `data: ${JSON.stringify({ id: "fake-completion", object: "chat.completion.chunk", created: 1, model: "fake-chat", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
      );
    };
    if (mode === "slow") {
      chunk({ role: "assistant", content: "Beginning…" });
      response.once("close", () => {
        providerDisconnected = true;
      });
      return;
    }
    const messages = body.messages as Array<{ role: string; content: string }>;
    if (
      mode === "tool" &&
      !messages.some((message) => message.role === "tool")
    ) {
      chunk({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call-time",
            type: "function",
            function: { name: "getCurrentTime", arguments: "{}" },
          },
        ],
      });
      chunk({}, "tool_calls");
    } else {
      chunk({ role: "assistant", content: "Hello from the fixture." });
      chunk({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  });
  const providerURL = await listen(provider);
  const app = createExampleServer({
    baseURL: `${providerURL}/inference`,
    authServer: `${providerURL}/console`,
    apiKey: "test-only-secret-key",
    allowedModels,
  });
  const url = await listen(app.server);
  return {
    url,
    requests,
    async authPost(route: string, body: unknown = {}) {
      return fetch(`${url}/api/auth/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: url },
        body: JSON.stringify(body),
      });
    },
    async authStatus() {
      const response = await fetch(`${url}/api/auth/status`);
      return response.json() as Promise<ExampleAuthState>;
    },
    get tokenPolls() {
      return tokenPolls;
    },
    get providerDisconnected() {
      return providerDisconnected;
    },
    releaseCatalog() {
      releaseCatalog?.();
    },
    async post(
      body: unknown,
      headers: Record<string, string> = {},
      signal?: AbortSignal,
    ) {
      let requestBody = body;
      if (body && typeof body === "object" && "forwardedProps" in body) {
        const forwardedProps = body.forwardedProps;
        if (
          forwardedProps &&
          typeof forwardedProps === "object" &&
          !("connectionRevision" in forwardedProps)
        ) {
          const state = (await fetch(`${url}/api/auth/status`).then(
            (response) => response.json(),
          )) as ExampleAuthState;
          requestBody = {
            ...body,
            forwardedProps: {
              ...forwardedProps,
              connectionRevision: state.connectionRevision,
            },
          };
        }
      }
      return fetch(`${url}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: url,
          ...headers,
        },
        body:
          typeof requestBody === "string"
            ? requestBody
            : JSON.stringify(requestBody),
        signal,
      });
    },
    async close() {
      releaseCatalog?.();
      await app.close();
      provider.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        provider.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

test("discovers only supported allowlisted models and keeps credentials off the wire", async (t) => {
  const server = await fixture("text", ["fake-chat", "jev-test"]);
  t.after(() => server.close());
  const response = await fetch(`${server.url}/api/models`);
  const body = (await response.json()) as {
    models: Array<{ id: string; api: string }>;
    authenticated: boolean;
    defaultModel: string;
  };
  assert.deepEqual(body.models, [{ id: "fake-chat", api: "chat-completions" }]);
  assert.equal(body.authenticated, true);
  assert.equal(body.defaultModel, "fake-chat");
  assert.ok(!JSON.stringify(body).includes("test-only-secret-key"));
  assert.equal(
    server.requests[0]?.authorization,
    "Bearer test-only-secret-key",
  );
});

test("streams a real adapter completion through the Node server as TanStack SSE", async (t) => {
  const server = await fixture();
  t.after(() => server.close());
  const response = await server.post(payload());
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /text\/event-stream/,
  );
  const text = await response.text();
  assert.match(text, /TEXT_MESSAGE_CONTENT/);
  assert.match(text, /Hello from the fixture/);
  assert.match(text, /RUN_FINISHED/);
  assert.ok(!text.includes("test-only-secret-key"));
  assert.equal(
    server.requests[1]?.path,
    "/inference/openai/v1/chat/completions",
  );
  assert.equal(
    server.requests[1]?.authorization,
    "Bearer test-only-secret-key",
  );
  assert.equal(server.requests[1]?.body?.max_tokens, 2048);
});

test("prefers gpt-5-nano when a server key is configured and the model is available", async (t) => {
  const server = await fixture();
  t.after(() => server.close());
  const response = await fetch(`${server.url}/api/models`);
  const body = (await response.json()) as { defaultModel: string };
  assert.equal(body.defaultModel, "gpt-5-nano");
});

test("executes the harmless time tool and sends its result into the next model turn", async (t) => {
  const server = await fixture("tool");
  t.after(() => server.close());
  const response = await server.post(payload("fake-chat", true));
  const text = await response.text();
  assert.match(text, /TOOL_CALL_START/);
  assert.match(text, /TOOL_CALL_RESULT/);
  assert.match(text, /getCurrentTime/);
  assert.match(text, /Hello from the fixture/);
  const followup = server.requests.find((request) =>
    (request.body?.messages as Array<{ role: string }> | undefined)?.some(
      (message) => message.role === "tool",
    ),
  );
  assert.ok(followup);
  const toolMessage = (
    followup.body?.messages as Array<{ role: string; content: string }>
  ).find((message) => message.role === "tool");
  assert.ok(toolMessage);
  const result = JSON.parse(toolMessage.content) as {
    iso: string;
    timeZone: string;
  };
  assert.match(result.iso, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(result.timeZone, "UTC");
});

test("rejects cross-origin, untrusted Host, malformed, oversized and unknown-model requests", async (t) => {
  const server = await fixture();
  t.after(() => server.close());
  const crossOrigin = await server.post(payload(), {
    Origin: "https://untrusted.example",
  });
  assert.equal(crossOrigin.status, 403);
  await crossOrigin.arrayBuffer();
  // Node's fetch owns the Host header, so use raw HTTP to exercise rebinding protection.
  const badHostStatus = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      `${server.url}/api/chat`,
      {
        method: "POST",
        headers: {
          Host: "untrusted.example",
          Origin: server.url,
          "Content-Type": "application/json",
        },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.once("error", reject);
    request.end(JSON.stringify(payload()));
  });
  assert.equal(badHostStatus, 403);
  const malformed = await server.post("{");
  assert.equal(malformed.status, 400);
  await malformed.arrayBuffer();
  const oversized = await server.post(" ".repeat(129 * 1024));
  assert.equal(oversized.status, 413);
  await oversized.arrayBuffer();
  const unknownModel = await server.post(payload("not-in-catalog"));
  assert.equal(unknownModel.status, 400);
  await unknownModel.arrayBuffer();
  const systemMessage = payload();
  systemMessage.messages[0]!.role = "system";
  const injection = await server.post(systemMessage);
  assert.equal(injection.status, 400);
  await injection.arrayBuffer();
  assert.ok(
    server.requests.every((request) => request.path.endsWith("/models")),
  );
});

test("surfaces useful errors without exposing upstream bodies or keys", async (t) => {
  const server = await fixture("error");
  t.after(() => server.close());
  const response = await server.post(payload());
  const text = await response.text();
  assert.match(text, /RUN_ERROR/);
  assert.match(text, /OpenCode rejected this authentication/);
  assert.ok(!text.includes("test-only-secret-key"));
});

test("stopping the browser stream aborts the upstream inference request", async (t) => {
  const server = await fixture("slow");
  t.after(() => server.close());
  const abortController = new AbortController();
  const response = await server.post(payload(), {}, abortController.signal);
  const reader = response.body!.getReader();
  await reader.read();
  await waitFor(() =>
    server.requests.some((request) =>
      request.path.endsWith("/chat/completions"),
    ),
  );
  abortController.abort();
  await reader.cancel().catch(() => undefined);
  await waitFor(() => server.providerDisconnected);
  assert.ok(server.providerDisconnected);
});

function assertNoCredentials(value: unknown) {
  const wire = JSON.stringify(value);
  for (const secret of [
    "test-only-secret-key",
    "device-secret-code",
    "session-secret-access",
    "session-secret-refresh",
  ]) {
    assert.ok(
      !wire.includes(secret),
      "An auth response must not expose credentials.",
    );
  }
  for (const field of [
    "accessToken",
    "refreshToken",
    "deviceCode",
    "clientId",
  ]) {
    assert.ok(
      !wire.includes(`"${field}"`),
      `An auth response must not expose ${field}.`,
    );
  }
}

async function waitForAuth(
  server: Awaited<ReturnType<typeof fixture>>,
  phase: ExampleAuthState["phase"],
) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await server.authStatus();
    assertNoCredentials(state);
    if (state.phase === phase) return state;
    await delay(50);
  }
  assert.fail(`Auth did not enter ${phase}.`);
}

test("post-approval lookup failures show the failed step and status without tokens", async (t) => {
  for (const [stage, message] of [
    ["account", "Console account discovery failed (HTTP 401)."],
    ["organizations", "Console organization discovery failed (HTTP 403)."],
  ] as const) {
    await t.test(stage, async (t) => {
      const server = await fixture("text", undefined, undefined, stage);
      t.after(() => server.close());
      const started = await server.authPost("start");
      assertNoCredentials(await started.json());
      const failure = await waitForAuth(server, "error");
      assert.equal(failure.error, message);
      assert.equal(failure.pending, undefined);
      assert.equal(failure.session, undefined);
      assertNoCredentials(failure);
    });
  }
});

test("device sign-in polls on the server, selects an organization, sends session headers and signs out", async (t) => {
  const server = await fixture();
  t.after(() => server.close());
  const initial = await server.authStatus();
  assert.equal(initial.mode, "api-key");
  assertNoCredentials(initial);
  const started = await server.authPost("start");
  assert.equal(started.status, 202);
  const pending = (await started.json()) as ExampleAuthState;
  assert.equal(pending.mode, "session");
  assert.equal(pending.phase, "pending");
  assert.equal(pending.pending?.userCode, "SHOW-CODE");
  assert.match(pending.pending?.verificationUrl ?? "", /user_code=SHOW-CODE/);
  assertNoCredentials(pending);
  const blocked = await server.post(payload());
  assert.equal(blocked.status, 401);
  await blocked.arrayBuffer();
  const publicCatalog = await fetch(`${server.url}/api/models`);
  assertNoCredentials(await publicCatalog.json());
  const pendingCatalogRequest = server.requests.find((request) =>
    request.path.endsWith("/models"),
  );
  assert.equal(pendingCatalogRequest?.authorization, undefined);
  const choosing = await waitForAuth(server, "organization-required");
  assert.equal(choosing.session?.account.email, "demo@example.test");
  assert.equal(choosing.session?.organizations.length, 2);
  assert.equal(choosing.session?.orgId, undefined);
  assert.ok(server.tokenPolls >= 2);
  const startRequest = server.requests.find((request) =>
    request.path.endsWith("/device/code"),
  );
  assert.equal(startRequest?.body?.supports_org_scope, true);
  const wrongOrganization = await server.authPost("organization", {
    orgId: "unrelated-org",
  });
  assert.equal(wrongOrganization.status, 400);
  assertNoCredentials(await wrongOrganization.json());
  const selected = await server.authPost("organization", { orgId: "org-two" });
  const signedIn = (await selected.json()) as ExampleAuthState;
  assert.equal(signedIn.phase, "signed-in");
  assert.equal(signedIn.session?.orgId, "org-two");
  assertNoCredentials(signedIn);
  const sameMode = await server.authPost("mode", { mode: "session" });
  const unchanged = (await sameMode.json()) as ExampleAuthState;
  assert.equal(unchanged.connectionRevision, signedIn.connectionRevision);
  assert.deepEqual(unchanged.session, signedIn.session);
  const staleWorkspace = await server.post(
    payload("fake-chat", false, choosing.connectionRevision),
  );
  assert.equal(staleWorkspace.status, 409);
  assertNoCredentials(await staleWorkspace.json());
  const completion = await server.post(payload());
  const text = await completion.text();
  assert.match(text, /Hello from the fixture/);
  assertNoCredentials(text);
  const inference = server.requests.find((request) =>
    request.path.endsWith("/chat/completions"),
  );
  assert.equal(inference?.authorization, "Bearer session-secret-access");
  assert.equal(inference?.orgId, "org-two");
  const loggedOut = await server.authPost("logout");
  const signedOut = (await loggedOut.json()) as ExampleAuthState;
  assert.equal(signedOut.phase, "signed-out");
  assert.equal(signedOut.session, undefined);
  assertNoCredentials(signedOut);
  const afterLogout = await server.post(payload());
  assert.equal(afterLogout.status, 401);
  await afterLogout.arrayBuffer();
  const restoreKey = await server.authPost("mode", { mode: "api-key" });
  assertNoCredentials(await restoreKey.json());
  const staleAccount = await server.post(
    payload("fake-chat", false, signedIn.connectionRevision),
  );
  assert.equal(staleAccount.status, 409);
  assertNoCredentials(await staleAccount.json());
  const keyCompletion = await server.post(payload());
  await keyCompletion.text();
  const keyInference = server.requests
    .filter((request) => request.path.endsWith("/chat/completions"))
    .at(-1);
  assert.equal(keyInference?.authorization, "Bearer test-only-secret-key");
  assert.equal(keyInference?.orgId, undefined);
});

test("same-mode selection preserves the connection revision and active inference", async (t) => {
  const server = await fixture("slow");
  t.after(() => server.close());
  const before = await server.authStatus();
  const abortController = new AbortController();
  const response = await server.post(
    payload("fake-chat", false, before.connectionRevision),
    {},
    abortController.signal,
  );
  const reader = response.body!.getReader();
  await reader.read();
  await waitFor(() =>
    server.requests.some((request) =>
      request.path.endsWith("/chat/completions"),
    ),
  );
  const sameMode = await server.authPost("mode", { mode: "api-key" });
  const state = (await sameMode.json()) as ExampleAuthState;
  assert.equal(state.connectionRevision, before.connectionRevision);
  await delay(50);
  assert.equal(server.providerDisconnected, false);
  abortController.abort();
  await reader.cancel().catch(() => undefined);
  await waitFor(() => server.providerDisconnected);
});

test("a stale tab cannot start inference after another tab changes authentication", async (t) => {
  const server = await fixture();
  t.after(() => server.close());
  const oldConnection = await server.authStatus();
  const changed = await server.authPost("mode", { mode: "session" });
  const next = (await changed.json()) as ExampleAuthState;
  assert.notEqual(next.connectionRevision, oldConnection.connectionRevision);
  const response = await server.post(
    payload("fake-chat", false, oldConnection.connectionRevision),
  );
  assert.equal(response.status, 409);
  assertNoCredentials(await response.json());
  assert.equal(server.requests.length, 0);
});

test("auth changes while discovery is awaited reject inference under the new connection", async (t) => {
  const server = await fixture("text", undefined, undefined, undefined, true);
  t.after(() => server.close());
  const oldConnection = await server.authStatus();
  const pendingResponse = server.post(
    payload("fake-chat", false, oldConnection.connectionRevision),
  );
  await waitFor(() =>
    server.requests.some((request) => request.path.endsWith("/models")),
  );
  const changed = await server.authPost("mode", { mode: "session" });
  assertNoCredentials(await changed.json());
  server.releaseCatalog();
  const response = await pendingResponse;
  assert.equal(response.status, 409);
  assertNoCredentials(await response.json());
  assert.ok(
    server.requests.every((request) => request.path.endsWith("/models")),
  );
});

test("canceling pending sign-in stops device polling and clears its browser code", async (t) => {
  const server = await fixture();
  t.after(() => server.close());
  const forbidden = await fetch(`${server.url}/api/auth/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://untrusted.example",
    },
    body: "{}",
  });
  assert.equal(forbidden.status, 403);
  assertNoCredentials(await forbidden.json());
  assert.ok(
    !server.requests.some((request) => request.path.endsWith("/device/code")),
  );
  const started = await server.authPost("start");
  assertNoCredentials(await started.json());
  const cancelled = await server.authPost("logout");
  const state = (await cancelled.json()) as ExampleAuthState;
  assert.equal(state.phase, "signed-out");
  assert.equal(state.pending, undefined);
  assertNoCredentials(state);
  await delay(1150);
  assert.equal(server.tokenPolls, 0);
  const final = await server.authStatus();
  assert.equal(final.phase, "signed-out");
  assert.equal(final.session, undefined);
});

test("an organization-scoped sign-in locks the selector and rejects another organization", async (t) => {
  const server = await fixture("text", undefined, "org-two");
  t.after(() => server.close());
  const start = await server.authPost("start");
  assertNoCredentials(await start.json());
  const state = await waitForAuth(server, "signed-in");
  assert.equal(state.session?.orgId, "org-two");
  assert.equal(state.session?.organizationLocked, true);
  const switchOrg = await server.authPost("organization", { orgId: "org-one" });
  assert.equal(switchOrg.status, 400);
  assertNoCredentials(await switchOrg.json());
  assert.equal((await server.authStatus()).session?.orgId, "org-two");
});

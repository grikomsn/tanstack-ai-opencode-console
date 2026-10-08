import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { ExampleAuthState } from "../auth.js";
import { createHostedAuth, SESSION_COOKIE } from "../hosted-auth.js";
import { SessionStoreError, type SessionStore } from "../session-store.js";
import { createVercelHandler, deploymentOrigins } from "../vercel.js";

class MemoryStore implements SessionStore {
  values = new Map<string, string>();
  locks = new Map<string, Promise<unknown>>();
  async read(id: string) {
    return this.values.get(id);
  }
  async write(id: string, value: string) {
    this.values.set(id, value);
  }
  async delete(id: string) {
    this.values.delete(id);
  }
  async withLock<T>(
    id: string,
    signal: AbortSignal | undefined,
    operation: (lease: AbortSignal) => Promise<T>,
  ): Promise<T> {
    signal?.throwIfAborted();
    const before = this.locks.get(id) ?? Promise.resolve();
    const result = before
      .catch(() => {})
      .then(() => {
        signal?.throwIfAborted();
        return operation(AbortSignal.timeout(90_000));
      });
    this.locks.set(id, result);
    try {
      return await result;
    } finally {
      if (this.locks.get(id) === result) this.locks.delete(id);
    }
  }
}
const site = "https://demo.example.test";
const secret = "ab".repeat(32);

function fixture(
  t: test.TestContext,
  mode: "text" | "tool" | "slow" | "error" = "text",
  expiresIn = 3600,
  polling?: "pending" | "slow_down" | "always-pending",
) {
  let now = Date.now();
  const originalNow = Date.now;
  Date.now = () => now;
  t.after(() => {
    Date.now = originalNow;
  });
  const store = new MemoryStore();
  const calls: Array<{
    path: string;
    headers: Headers;
    body?: Record<string, unknown>;
  }> = [];
  let devices = 0;
  let refreshes = 0;
  let polls = 0;
  let canceled = false;
  const network: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const headers = new Headers(init?.headers ?? request?.headers);
    const signal = init?.signal ?? request?.signal;
    const raw =
      init?.body ??
      (request?.method === "POST" ? await request.text() : undefined);
    const body = raw
      ? (JSON.parse(String(raw)) as Record<string, unknown>)
      : undefined;
    calls.push({ path: url.pathname, headers, body });
    if (url.pathname === "/console/auth/device/code") {
      devices++;
      return Response.json({
        device_code: `device-secret-${devices}`,
        user_code: `CODE-${devices}`,
        verification_uri_complete: `https://auth.example.test/console/device?user_code=CODE-${devices}`,
        expires_in: 300,
        interval: 1,
      });
    }
    if (url.pathname === "/console/auth/device/token") {
      if (body?.grant_type === "refresh_token") {
        refreshes++;
        await delay(10);
        return Response.json({
          access_token: `rotated-secret-${refreshes}`,
          refresh_token: `refresh-rotated-secret-${refreshes}`,
          expires_in: 3600,
        });
      }
      polls++;
      if (polling && (polls === 1 || polling === "always-pending"))
        return Response.json(
          {
            error:
              polling !== "slow_down" ? "authorization_pending" : "slow_down",
          },
          { status: 400 },
        );
      const visitor = String(body?.device_code).split("-").at(-1);
      return Response.json({
        access_token: `access-secret-${visitor}`,
        refresh_token: `refresh-secret-${visitor}`,
        expires_in: expiresIn,
        org_id: `org-${visitor}`,
      });
    }
    if (url.pathname === "/console/api/user")
      return Response.json({ id: "account", email: "visitor@example.test" });
    if (url.pathname === "/console/api/orgs")
      return Response.json([
        { id: "org-1", name: "One" },
        { id: "org-2", name: "Two" },
      ]);
    if (url.pathname === "/inference/v1/models")
      return Response.json({ data: [{ id: "fake-chat" }, { id: "jev-test" }] });
    assert.equal(url.pathname, "/inference/openai/v1/chat/completions");
    if (mode === "error")
      return Response.json(
        { error: { message: "access-secret-1 refresh-secret-1" } },
        { status: 401 },
      );
    const encoder = new TextEncoder();
    const part = (delta: unknown, finish_reason: string | null = null) =>
      encoder.encode(
        `data: ${JSON.stringify({ id: "completion", object: "chat.completion.chunk", model: "fake-chat", created: 1, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (mode === "slow") {
          controller.enqueue(part({ role: "assistant", content: "Beginning" }));
          signal!.addEventListener(
            "abort",
            () => {
              canceled = true;
              controller.error(signal!.reason);
            },
            { once: true },
          );
          return;
        }
        const hasTool = (body?.messages as Array<{ role: string }>).some(
          (message) => message.role === "tool",
        );
        if (mode === "tool" && !hasTool) {
          controller.enqueue(
            part({
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call-clock",
                  type: "function",
                  function: { name: "getCurrentTime", arguments: "{}" },
                },
              ],
            }),
          );
          controller.enqueue(part({}, "tool_calls"));
        } else {
          controller.enqueue(
            part({ role: "assistant", content: "Hello from hosted fixture." }),
          );
          controller.enqueue(part({}, "stop"));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
      cancel() {
        canceled = true;
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream" },
    });
  };
  const options = {
    store,
    sessionSecret: secret,
    allowedOrigins: [site],
    baseURL: "https://provider.example.test/inference",
    authServer: "https://auth.example.test/console",
    fetch: network,
    watchIntervalMs: 10,
  };
  const first = createVercelHandler(options);
  const second = createVercelHandler(options);
  function request(
    path: string,
    cookie?: string,
    body?: unknown,
    signal?: AbortSignal,
  ) {
    return new Request(`${site}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined
          ? {}
          : { Origin: site, "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
  }
  async function visitor() {
    const response = await first(request("/api/auth/status"));
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie")!;
    assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/);
    const id = cookie.split("=")[1]!.split(";")[0]!;
    return {
      cookie: cookie.split(";")[0]!,
      id,
      state: (await response.json()) as ExampleAuthState,
    };
  }
  async function signIn() {
    const visitorState = await visitor();
    const started = await first(
      request("/api/auth/start", visitorState.cookie, {}),
    );
    const pending = (await started.json()) as ExampleAuthState;
    assert.equal(pending.phase, "pending");
    now += 1001;
    const result = await second(
      request("/api/auth/status", visitorState.cookie),
    );
    return {
      ...visitorState,
      state: (await result.json()) as ExampleAuthState,
    };
  }
  return {
    store,
    first,
    second,
    request,
    visitor,
    signIn,
    calls,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    get refreshes() {
      return refreshes;
    },
    get polls() {
      return polls;
    },
    get canceled() {
      return canceled;
    },
  };
}
function payload(revision: string, toolsEnabled = false) {
  return {
    threadId: "hosted-thread",
    runId: "hosted-run",
    messages: [{ id: "message", role: "user", content: "Hello" }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {
      model: "fake-chat",
      toolsEnabled,
      connectionRevision: revision,
    },
  };
}

test("hosted sessions survive handler instances and isolate visitors, tokens and orgs", async (t) => {
  const previousKey = process.env.OPENCODE_API_KEY;
  process.env.OPENCODE_API_KEY = "fixture-owner-service-key";
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = previousKey;
  });
  const f = fixture(t);
  const unsigned = await f.visitor();
  assert.deepEqual(
    await (await f.first(f.request("/api/models", unsigned.cookie))).json(),
    { models: [], authenticated: false, defaultModel: null },
  );
  const a = await f.signIn();
  const b = await f.signIn();
  assert.notEqual(a.id, b.id);
  assert.equal(a.state.session?.orgId, "org-1");
  assert.equal(b.state.session?.orgId, "org-2");
  assert.deepEqual(a.state.availableModes, ["session"]);
  assert.equal(a.state.keyConfigured, false);
  assert.doesNotMatch(
    JSON.stringify([...f.store.values.values()]),
    /secret-|device_code|accessToken/,
  );
  assert.doesNotMatch(
    JSON.stringify(a.state),
    /access-secret|refresh-secret|device-secret/,
  );
  const catalog = await f.second(f.request("/api/models", a.cookie));
  assert.equal(catalog.status, 200);
  assert.deepEqual((await catalog.json()).models, [
    { id: "fake-chat", api: "chat-completions" },
  ]);
  const response = await f.second(
    f.request("/api/chat", a.cookie, payload(a.state.connectionRevision)),
  );
  assert.equal(response.status, 200);
  const received = await response.text();
  assert.ok(
    f.calls.some((call) => call.path.endsWith("chat/completions")),
    JSON.stringify(f.calls.map((call) => call.path)),
  );
  assert.match(received, /Hello from hosted fixture/);
  const inference = f.calls.find((call) =>
    call.path.endsWith("chat/completions"),
  )!;
  assert.equal(
    inference.headers.get("authorization"),
    "Bearer access-secret-1",
  );
  assert.equal(inference.headers.get("x-org-id"), "org-1");
  assert.equal(inference.headers.get("x-opencode-org-id"), "org-1");
  await f.first(f.request("/api/auth/logout", a.cookie, {}));
  assert.equal(
    (
      await f.second(
        f.request("/api/chat", a.cookie, payload(a.state.connectionRevision)),
      )
    ).status,
    401,
  );
  assert.equal(
    (await f.second(f.request("/api/models", a.cookie))).status,
    200,
  );
  assert.equal(
    (await f.second(f.request("/api/models", b.cookie))).status,
    200,
  );
});

test("sign-out rotates the cookie so another sign-in can start immediately", async (t) => {
  const f = fixture(t);
  const a = await f.signIn();
  const response = await f.second(f.request("/api/auth/logout", a.cookie, {}));
  assert.equal(response.status, 200);
  const state = (await response.json()) as ExampleAuthState;
  assert.equal(state.phase, "signed-out");
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  assert.notEqual(cookie, a.cookie);
  assert.equal(f.store.values.has(a.id), false);
  assert.deepEqual(
    await (await f.first(f.request("/api/models", cookie))).json(),
    { models: [], authenticated: false, defaultModel: null },
  );
  const started = await f.first(f.request("/api/auth/start", cookie, {}));
  assert.equal(started.status, 200);
  assert.equal((await started.json()).phase, "pending");
});

test("pending device polling resumes per request and obeys shared slow_down timing", async (t) => {
  const f = fixture(t, "text", 3600, "slow_down");
  const a = await f.signIn();
  assert.equal(a.state.phase, "pending");
  assert.equal(f.polls, 1);
  await f.first(f.request("/api/auth/status", a.cookie));
  assert.equal(f.polls, 1);
  f.advance(5999);
  await f.second(f.request("/api/auth/status", a.cookie));
  assert.equal(f.polls, 1);
  f.advance(1);
  const completed = await f.first(f.request("/api/auth/status", a.cookie));
  assert.equal((await completed.json()).phase, "signed-in");
  assert.equal(f.polls, 2);
});

test("pending approval within its final second expires with the correct message", async (t) => {
  const f = fixture(t, "text", 3600, "always-pending");
  const a = await f.signIn();
  f.advance(298_500);
  const pending = await f.second(f.request("/api/auth/status", a.cookie));
  assert.equal((await pending.json()).phase, "pending");
  f.advance(500);
  const expired = await f.first(f.request("/api/auth/status", a.cookie));
  assert.match((await expired.json()).error, /expired/);
  assert.equal(f.polls, 2);
});

test("refresh rotation is serialized across instances and persisted encrypted", async (t) => {
  const f = fixture(t, "text", 30);
  const a = await f.signIn();
  const responses = await Promise.all([
    f.first(f.request("/api/models", a.cookie)),
    f.second(f.request("/api/models", a.cookie)),
  ]);
  assert.ok(responses.every((response) => response.status === 200));
  assert.equal(f.refreshes, 1);
  const network = f.calls.filter((call) => call.path.endsWith("models"));
  assert.ok(
    network.every(
      (call) => call.headers.get("authorization") === "Bearer rotated-secret-1",
    ),
  );
  assert.doesNotMatch([...f.store.values.values()].join(""), /rotated-secret/);
});

test("a disconnected refresh caller still persists the rotated credential", async (t) => {
  const f = fixture(t, "text", 30);
  const a = await f.signIn();
  const auth = createHostedAuth({
    store: f.store,
    secret,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/console/auth/device/token");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.refresh_token, "refresh-secret-1");
      await delay(5);
      controller.abort(reason);
      return Response.json({
        access_token: "persisted-access-secret",
        refresh_token: "persisted-refresh-secret",
        expires_in: 3600,
      });
    },
  });
  const controller = new AbortController();
  const reason = new Error("Fixture disconnected during refresh");
  await assert.rejects(
    auth.credentials(a.id, a.state.connectionRevision, controller.signal),
    (error) => error === reason,
  );
  const next = createHostedAuth({ store: f.store, secret });
  const credential = await next.credentials(
    a.id,
    a.state.connectionRevision,
    AbortSignal.timeout(1000),
  );
  assert.equal(credential.accessToken, "persisted-access-secret");
  assert.doesNotMatch(
    f.store.values.get(a.id)!,
    /persisted-access-secret|persisted-refresh-secret/,
  );
});

test("ciphertext cannot be moved to a different visitor ID", async (t) => {
  const f = fixture(t);
  const a = await f.signIn();
  const b = await f.visitor();
  f.store.values.set(b.id, f.store.values.get(a.id)!);
  const response = await f.second(f.request("/api/auth/status", b.cookie));
  const state = (await response.json()) as ExampleAuthState;
  assert.equal(state.phase, "signed-out");
  assert.equal(state.canChat, false);
  assert.ok(response.headers.has("set-cookie"));
});

test("hosted tool calls finish through the real TanStack adapter", async (t) => {
  const f = fixture(t, "tool");
  const a = await f.signIn();
  const response = await f.first(
    f.request("/api/chat", a.cookie, payload(a.state.connectionRevision, true)),
  );
  const text = await response.text();
  assert.match(text, /getCurrentTime/);
  assert.match(text, /Hello from hosted fixture/);
  assert.equal(
    f.calls.filter((call) => call.path.endsWith("chat/completions")).length,
    2,
  );
});

test("logout in another instance cancels this visitor's ongoing stream", async (t) => {
  const f = fixture(t, "slow");
  const a = await f.signIn();
  const response = await f.first(
    f.request("/api/chat", a.cookie, payload(a.state.connectionRevision)),
  );
  const reader = response.body!.getReader();
  for (
    let i = 0;
    i < 10 && !f.calls.some((call) => call.path.endsWith("chat/completions"));
    i++
  )
    await reader.read();
  await f.second(f.request("/api/auth/logout", a.cookie, {}));
  for (let i = 0; i < 100 && !f.canceled; i++) await delay(5);
  assert.equal(f.canceled, true);
  await reader.cancel();
});

test("browser cancellation closes upstream", async (t) => {
  const f = fixture(t, "slow");
  const a = await f.signIn();
  const response = await f.first(
    f.request("/api/chat", a.cookie, payload(a.state.connectionRevision)),
  );
  const reader = response.body!.getReader();
  for (
    let i = 0;
    i < 10 && !f.calls.some((call) => call.path.endsWith("chat/completions"));
    i++
  )
    await reader.read();
  await reader.cancel();
  assert.equal(f.canceled, true);
});

test("hosted provider errors never reveal session credentials", async (t) => {
  const f = fixture(t, "error");
  const a = await f.signIn();
  const response = await f.first(
    f.request("/api/chat", a.cookie, payload(a.state.connectionRevision)),
  );
  const text = await response.text();
  assert.match(text, /RUN_ERROR/);
  assert.doesNotMatch(text, /access-secret|refresh-secret/);
});

test("hosted routes enforce origin, connection revision and bounded input", async (t) => {
  const f = fixture(t);
  const a = await f.signIn();
  const crossOrigin = new Request(`${site}/api/auth/start`, {
    method: "POST",
    headers: {
      Origin: "https://elsewhere.test",
      "Content-Type": "application/json",
      Cookie: a.cookie,
    },
    body: "{}",
  });
  assert.equal((await f.first(crossOrigin)).status, 403);
  const stale = await f.first(
    f.request("/api/chat", a.cookie, payload("stale")),
  );
  assert.equal(stale.status, 409);
  const tooLarge = await f.first(
    f.request("/api/chat", a.cookie, { content: "x".repeat(130_000) }),
  );
  assert.equal(tooLarge.status, 400);
  const bigger = await f.first(
    f.request("/api/chat", a.cookie, { content: "x".repeat(140_000) }),
  );
  assert.equal(bigger.status, 413);
  assert.equal(
    (await f.first(f.request("/api/auth/mode", a.cookie, { mode: "api-key" })))
      .status,
    400,
  );
  assert.equal(
    (
      await f.first(
        f.request("/api/auth/organization", a.cookie, { orgId: "org-2" }),
      )
    ).status,
    400,
  );
  assert.equal(
    (await f.first(f.request("/api/unknown", a.cookie))).status,
    404,
  );
  assert.equal(
    f.calls.filter((call) => call.path.endsWith("chat/completions")).length,
    0,
  );
});

test("disconnect while uploading a stalled body cancels the reader promptly", async (t) => {
  const f = fixture(t);
  const a = await f.visitor();
  const controller = new AbortController();
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      canceled = true;
    },
  });
  const request = new Request(`${site}/api/auth/start`, {
    method: "POST",
    headers: {
      Origin: site,
      Cookie: a.cookie,
      "Content-Type": "application/json",
    },
    signal: controller.signal,
    body,
    duplex: "half",
  } as RequestInit);
  const pending = f.first(request);
  await delay(5);
  const reason = new Error("Fixture browser disconnected");
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(canceled, true);
  assert.equal(f.calls.length, 0);
});

test("expired pending sign-in fails safely without a background poll", async (t) => {
  const f = fixture(t, "text", 3600, "pending");
  const a = await f.signIn();
  f.advance(301_000);
  const response = await f.second(f.request("/api/auth/status", a.cookie));
  const state = (await response.json()) as ExampleAuthState;
  assert.equal(state.phase, "error");
  assert.match(state.error!, /expired/);
  assert.equal(f.polls, 1);
});

test("session configuration fails closed and accepts exact deployment origins", async () => {
  assert.throws(() =>
    createHostedAuth({ store: new MemoryStore(), secret: "short" }),
  );
  assert.deepEqual(
    deploymentOrigins({
      VERCEL_URL: "preview.vercel.app",
      VERCEL_BRANCH_URL: "branch.vercel.app",
      VERCEL_PROJECT_PRODUCTION_URL: "demo.vercel.app",
      OPENCODE_ALLOWED_ORIGINS: "https://chat.example.test",
    }),
    [
      "https://preview.vercel.app",
      "https://branch.vercel.app",
      "https://demo.vercel.app",
      "https://chat.example.test",
    ],
  );
  assert.throws(() =>
    deploymentOrigins({
      OPENCODE_ALLOWED_ORIGINS: "https://example.test/other",
    }),
  );
  const handler = createVercelHandler({
    allowedOrigins: [site],
    sessionSecret: "short",
  });
  const response = await handler(new Request(`${site}/api/auth/status`));
  assert.equal(response.status, 503);
  assert.match(await response.text(), /shared Console session storage/);
  const malformed = new Request(`${site}/api/auth/status`, {
    headers: { Cookie: `${SESSION_COOKIE}=secret` },
  });
  assert.equal((await handler(malformed)).status, 503);
});

test("storage contention returns a safe retryable status", async () => {
  const store = new MemoryStore();
  store.withLock = async () => {
    throw new SessionStoreError("lock_timeout", "fixture-storage-secret");
  };
  const handler = createVercelHandler({
    store,
    allowedOrigins: [site],
    sessionSecret: secret,
  });
  const response = await handler(new Request(`${site}/api/auth/status`));
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.match(body, /busy/);
  assert.doesNotMatch(body, /fixture-storage-secret/);
});

test("Vercel Marketplace KV variables create shared sessions without mixing manual credentials", async (t) => {
  const keys = [
    "KV_REST_API_URL",
    "KV_REST_API_TOKEN",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
    "OPENCODE_SESSION_PREFIX",
  ];
  const previous = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.KV_REST_API_URL = "https://fixture-redis.upstash.io";
  process.env.KV_REST_API_TOKEN = "fixture-marketplace-token";
  process.env.OPENCODE_SESSION_PREFIX = "fixture:preview";
  const values = new Map<string, string>();
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://fixture-redis.upstash.io");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer fixture-marketplace-token",
    );
    const command = JSON.parse(String(init?.body)) as Array<string | number>;
    let result: string | number | null = null;
    if (command[0] === "SET") {
      const key = String(command[1]);
      if (command[3] !== "NX" || !values.has(key)) {
        values.set(key, String(command[2]));
        result = "OK";
      }
    } else if (command[0] === "EVAL") {
      const key = String(command[3]);
      if (command.length === 4) result = values.get(key) ?? null;
      else {
        result = values.get(key) === command[4] ? 1 : 0;
        if (result === 1) values.delete(key);
      }
    } else assert.fail("Unexpected Redis command");
    return Response.json({ result });
  };
  const options = { allowedOrigins: [site], sessionSecret: secret };
  const first = createVercelHandler(options);
  const second = createVercelHandler(options);
  const response = await first(new Request(`${site}/api/auth/status`));
  assert.equal(response.status, 200);
  const state = (await response.json()) as ExampleAuthState;
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  const resumed = await second(
    new Request(`${site}/api/auth/status`, { headers: { Cookie: cookie } }),
  );
  assert.equal(resumed.status, 200);
  assert.equal(
    (await resumed.json()).connectionRevision,
    state.connectionRevision,
  );
  assert.equal(values.size, 1);
  assert.doesNotMatch(
    [...values.values()].join(""),
    /connectionRevision|fixture-marketplace-token/,
  );
  process.env.UPSTASH_REDIS_REST_URL = "https://other-redis.upstash.io";
  const partial = createVercelHandler(options);
  assert.equal(
    (await partial(new Request(`${site}/api/auth/status`))).status,
    503,
  );
});

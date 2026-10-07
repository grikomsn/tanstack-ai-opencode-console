import assert from "node:assert/strict";
import test from "node:test";
import {
  createOpenCodeConsole,
  listOpenCodeConsoleModels,
  opencodeConsoleText,
  parseOpenCodeConsoleModels,
  resolveOpenCodeConsoleApi,
} from "../src/index.js";
import { createConsoleFetch } from "../src/transport.js";

test("routes v2 families and exact catalog exceptions", () => {
  const expected = {
    "big-pickle": "chat-completions",
    "kimi-k2.6": "chat-completions",
    "glm-5.3": "chat-completions",
    "minimax-m3": "chat-completions",
    "deepseek-v4.1-flash": "chat-completions",
    "qwen3.8-max": "chat-completions",
    "gpt-6.1-sol": "responses",
    "grok-build-0.1": "responses",
    "muse-spark-1.3-contributor-free": "responses",
    "claude-sonnet-4-6": "messages",
    "qwen3.6-plus": "messages",
    "qwen3.8-flash": "messages",
    "gemini-3.8-flash": "gemini",
    "jev-1.13": "systemone",
    "jev-1.13-free": "systemone",
    "future-model": "chat-completions",
  };
  for (const [model, api] of Object.entries(expected)) {
    assert.equal(resolveOpenCodeConsoleApi(model), api, model);
  }
});

test("allows explicit routing for gateway aliases and rejects decision models", () => {
  assert.equal(
    opencodeConsoleText("custom-model", { api: "gemini" }).api,
    "gemini",
  );
  assert.throws(
    () => opencodeConsoleText("jev-1.13"),
    /System One.*text adapter/,
  );
  for (const model of [
    "",
    " gpt-5.5",
    "gpt-5.5 ",
    "opencode/gpt-5.5",
    "../model",
    "model?key=value",
  ]) {
    assert.throws(() => opencodeConsoleText(model), /inference model ID/);
  }
});

test("validates configuration before initializing protocol clients", () => {
  for (const timeout of [
    0,
    -1,
    1.5,
    2_147_483_648,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    assert.throws(
      () => opencodeConsoleText("big-pickle", { timeout }),
      /timeout/,
    );
  }
  for (const maxRetries of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => opencodeConsoleText("big-pickle", { maxRetries }),
      /maxRetries/,
    );
  }
  for (const baseURL of [
    "file:///tmp/inference",
    "https://key@example.com/inference",
    "https://example.com/inference?key=a",
    "https://example.com/inference#fragment",
  ]) {
    assert.throws(
      () => opencodeConsoleText("big-pickle", { baseURL }),
      /baseURL/,
    );
  }
});

test("catalog parsing preserves availability without inventing capabilities", () => {
  const models = parseOpenCodeConsoleModels({
    object: "list",
    data: [
      {
        id: "gpt-5.5",
        created: 123,
        owned_by: "opencode",
        limit: 100000,
        tools: true,
        price: 1,
      },
      "gemini-3.1-pro",
      { id: "jev-1.13", created: Number.NaN },
      { id: "qwen3.8-max", created: "123", owned_by: 42 },
      { id: "gpt-5.5", created: 456, owned_by: "updated" },
      null,
      [],
      { id: 1 },
      { id: "../bad" },
      { name: "missing-id" },
    ],
  });
  assert.deepEqual(models, [
    {
      id: "gpt-5.5",
      api: "responses",
      supported: true,
      created: 456,
      ownedBy: "updated",
    },
    { id: "gemini-3.1-pro", api: "gemini", supported: true },
    { id: "jev-1.13", api: "systemone", supported: false },
    { id: "qwen3.8-max", api: "chat-completions", supported: true },
  ]);
  for (const invalid of [null, [], {}, { data: {} }]) {
    assert.throws(
      () => parseOpenCodeConsoleModels(invalid),
      /invalid model catalog/,
    );
  }
});

test("discovery uses the public v2 root and provider overrides", async () => {
  const calls: {
    url: string;
    headers: Headers;
    signal: AbortSignal | null | undefined;
  }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      signal: init?.signal,
    });
    return Response.json({ data: [{ id: "big-pickle" }] });
  };
  const provider = createOpenCodeConsole({
    baseURL: "https://gateway.example/inference///",
    apiKey: "  service-key  ",
    defaultHeaders: { "X-Tenant": "workspace" },
    fetch: fetcher,
  });
  assert.equal(provider("gpt-5.5").api, "responses");
  assert.equal(
    provider("gpt-5.5", { api: "chat-completions" }).api,
    "chat-completions",
  );
  assert.deepEqual(await provider.listModels(), [
    { id: "big-pickle", api: "chat-completions", supported: true },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://gateway.example/inference/v1/models");
  assert.equal(calls[0]?.headers.get("authorization"), "Bearer service-key");
  assert.equal(calls[0]?.headers.get("x-tenant"), "workspace");
  assert.equal(calls[0]?.headers.get("accept"), "application/json");
  assert.ok(calls[0]?.signal);
});

test("discovery reports failed HTTP status and malformed catalog", async () => {
  await assert.rejects(
    listOpenCodeConsoleModels({
      apiKey: "",
      fetch: async () => new Response("denied", { status: 403 }),
    }),
    /discovery failed \(HTTP 403\)/,
  );
  await assert.rejects(
    listOpenCodeConsoleModels({
      apiKey: "",
      fetch: async () => Response.json({ models: [] }),
    }),
    /invalid model catalog/,
  );
});

test("transport merges request headers and replaces native SDK authentication", async () => {
  let captured:
    { headers: Headers; method?: string; body?: string } | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    captured = {
      headers: request.headers,
      method: request.method,
      body: await request.text(),
    };
    return Response.json({ ok: true });
  };
  const fetchConsole = createConsoleFetch({
    baseURL: "https://gateway.example/inference",
    apiKey: "  console-key  ",
    defaultHeaders: {
      "X-Tenant": "configured",
      Authorization: "Bearer stale-key",
      "X-Api-Key": "native-a",
    },
    fetch: fetcher,
  });
  await fetchConsole(
    new Request(
      "https://gateway.example/inference/openai/v1/chat/completions",
      {
        method: "POST",
        body: '{"model":"big-pickle"}',
        headers: {
          "X-Original": "kept",
          "X-Tenant": "original",
          "X-Goog-Api-Key": "native-g",
        },
      },
    ),
    { headers: { "X-Tenant": "per-call", "X-Call": "kept" } },
  );
  assert.equal(captured?.method, "POST");
  assert.equal(captured?.body, '{"model":"big-pickle"}');
  assert.equal(captured?.headers.get("x-original"), "kept");
  assert.equal(captured?.headers.get("x-call"), "kept");
  assert.equal(captured?.headers.get("x-tenant"), "configured");
  assert.equal(captured?.headers.get("authorization"), "Bearer console-key");
  assert.equal(captured?.headers.get("x-api-key"), null);
  assert.equal(captured?.headers.get("x-goog-api-key"), null);
  assert.equal(
    captured?.headers.get("x-opencode-client"),
    "tanstack-ai-opencode-console",
  );
});

test("explicit empty credentials omit every auth header even with an environment key", async () => {
  const previous = process.env.OPENCODE_API_KEY;
  process.env.OPENCODE_API_KEY = "environment-key";
  try {
    const recorded: Headers[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      recorded.push(new Headers(init?.headers));
      return Response.json({});
    };
    await createConsoleFetch({
      baseURL: "https://gateway.example",
      fetch: fetcher,
    })("https://gateway.example/v1/models");
    await createConsoleFetch({
      baseURL: "https://gateway.example",
      apiKey: "",
      fetch: fetcher,
    })("https://gateway.example/v1/models", {
      headers: {
        Authorization: "Bearer placeholder",
        "x-api-key": "placeholder",
        "x-goog-api-key": "placeholder",
      },
    });
    assert.equal(recorded[0]?.get("authorization"), "Bearer environment-key");
    for (const header of ["authorization", "x-api-key", "x-goog-api-key"]) {
      assert.equal(recorded[1]?.get(header), null, header);
    }
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = previous;
  }
});

test("async credential suppliers rotate per request and may select unauthenticated access", async () => {
  const keys = ["first", "second", undefined];
  const recorded: (string | null)[] = [];
  let resolutions = 0;
  const fetchConsole = createConsoleFetch({
    baseURL: "https://gateway.example",
    apiKey: async () => keys[resolutions++],
    fetch: async (_input, init) => {
      recorded.push(new Headers(init?.headers).get("authorization"));
      return Response.json({});
    },
  });
  for (let i = 0; i < 3; i++)
    await fetchConsole("https://gateway.example/v1/models");
  assert.deepEqual(recorded, ["Bearer first", "Bearer second", null]);
  assert.equal(resolutions, 3);
});

test("credential supplier failures prevent network calls", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return Response.json({});
  };
  await assert.rejects(
    createConsoleFetch({
      baseURL: "https://gateway.example",
      apiKey: async () => {
        throw new Error("refresh failed");
      },
      fetch: fetcher,
    })("https://gateway.example/v1/models"),
    /refresh failed/,
  );
  await assert.rejects(
    createConsoleFetch({
      baseURL: "https://gateway.example",
      // Deliberately represent a JavaScript caller violating the supplier contract.
      apiKey: (() => 42) as unknown as () => string,
      fetch: fetcher,
    })("https://gateway.example/v1/models"),
    /supplier must return a string or undefined/,
  );
  assert.equal(calls, 0);
});

test("malformed credentials and header values cannot appear in native validation errors", async () => {
  const sensitive = "fixture-sensitive-header-value";
  const invalid = `${sensitive}\ninvalid`;
  const safeError = (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /HTTP headers.*invalid/);
    assert.equal(error.message.includes(sensitive), false);
    assert.equal("cause" in error, false);
    return true;
  };
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return Response.json({});
  };
  for (const config of [
    { apiKey: invalid },
    { apiKey: async () => invalid },
    { session: { accessToken: invalid, orgId: "fixture-org" } },
    { session: { accessToken: "fixture-token", orgId: invalid } },
  ]) {
    await assert.rejects(
      createConsoleFetch({ ...config, fetch: fetcher })(
        "https://opencode.ai/inference/v1/models",
      ),
      safeError,
    );
  }
  const malformedHeaders: HeadersInit[] = [
    { Authorization: invalid },
    { "X-Tenant": invalid },
    { [`Invalid header ${sensitive}`]: "value" },
  ];
  for (const defaultHeaders of malformedHeaders) {
    assert.throws(
      () => createConsoleFetch({ apiKey: "", defaultHeaders, fetch: fetcher }),
      safeError,
    );
  }
  await assert.rejects(
    createConsoleFetch({ apiKey: "", fetch: fetcher })(
      "https://opencode.ai/inference/v1/models",
      { headers: { "X-Api-Key": invalid } },
    ),
    safeError,
  );
  assert.equal(calls, 0);
});

test("an already cancelled discovery request never reaches fetch", async () => {
  const controller = new AbortController();
  controller.abort(new Error("user cancelled"));
  let calls = 0;
  await assert.rejects(
    listOpenCodeConsoleModels(
      {
        apiKey: "",
        fetch: async () => {
          calls++;
          return Response.json({ data: [] });
        },
      },
      { signal: controller.signal },
    ),
    /user cancelled/,
  );
  assert.equal(calls, 0);
});

test("a hung credential supplier is bounded by timeout before any network request", async () => {
  let requests = 0;
  const fetchConsole = createConsoleFetch({
    apiKey: () => new Promise<string>(() => {}),
    timeout: 25,
    fetch: async () => {
      requests++;
      return Response.json({});
    },
  });
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    await assert.rejects(
      fetchConsole("https://opencode.ai/inference/v1/models"),
      (error: unknown) =>
        error instanceof Error && error.name === "TimeoutError",
    );
    assert.equal(requests, 0);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("caller cancellation interrupts a pending credential supplier", async () => {
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const controller = new AbortController();
  let requests = 0;
  const pending = createConsoleFetch({
    apiKey: () => {
      entered();
      return new Promise<string>(() => {});
    },
    fetch: async () => {
      requests++;
      return Response.json({});
    },
  })("https://opencode.ai/inference/v1/models", { signal: controller.signal });
  await ready;
  controller.abort(new Error("cancel credentials"));
  await assert.rejects(pending, /cancel credentials/);
  assert.equal(requests, 0);
});

test("the outbound root guard runs before credential resolution and disables redirects", async () => {
  let credentials = 0;
  let requests = 0;
  let redirect: RequestRedirect | undefined;
  const fetchConsole = createConsoleFetch({
    apiKey: () => {
      credentials++;
      return "service-key";
    },
    fetch: async (_input, init) => {
      requests++;
      redirect = init?.redirect;
      return Response.json({});
    },
  });
  for (const url of [
    "https://attacker.example/inference/v1/models",
    "https://opencode.ai/inference-evil/v1/models",
    "https://opencode.ai/console/v1/models",
    "https://embedded:key@opencode.ai/inference/v1/models",
  ]) {
    await assert.rejects(
      fetchConsole(url),
      /outside the configured inference root/,
    );
  }
  assert.equal(credentials, 0);
  assert.equal(requests, 0);
  await fetchConsole("https://opencode.ai/inference/v1/models", {
    redirect: "follow",
  });
  assert.equal(credentials, 1);
  assert.equal(requests, 1);
  assert.equal(redirect, "error");
});

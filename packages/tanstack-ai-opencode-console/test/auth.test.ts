import assert from "node:assert/strict";
import test from "node:test";
import {
  OPENCODE_CONSOLE_AUTH_SERVER,
  OPENCODE_CONSOLE_DEVICE_CLIENT_ID,
  OpenCodeConsoleAuthError,
  completeOpenCodeConsoleDeviceSignIn,
  createOpenCodeConsoleSessionAuth,
  refreshOpenCodeConsoleSession,
  requestOpenCodeConsoleDeviceCode,
  revokeOpenCodeConsoleSession,
} from "tanstack-ai-opencode-console/auth";
import type {
  OpenCodeConsoleDeviceCode,
  OpenCodeConsoleSession,
} from "tanstack-ai-opencode-console/auth";
import { opencodeConsoleText } from "tanstack-ai-opencode-console";
import { createConsoleFetch } from "../src/transport.js";

type Call = {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
  redirect: RequestRedirect;
  signal: AbortSignal | null | undefined;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function mockNetwork(responses: (Response | Promise<Response>)[]) {
  const calls: Call[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = await request.text();
    const index = calls.length;
    calls.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: body ? (JSON.parse(body) as Record<string, unknown>) : {},
      redirect: request.redirect,
      signal: init?.signal,
    });
    assert.ok(responses[index], `Unexpected mocked auth call ${index + 1}`);
    return responses[index]!;
  };
  return { calls, fetch: fetcher };
}

function deviceResponse(overrides: Record<string, unknown> = {}) {
  return Response.json({
    device_code: "device-secret",
    user_code: "READ-CODE",
    verification_uri_complete:
      "https://opencode.ai/console/device?user_code=READ-CODE",
    expires_in: 600,
    interval: 1,
    ...overrides,
  });
}

function tokenResponse(overrides: Record<string, unknown> = {}, status = 200) {
  return Response.json(
    {
      access_token: "new-session-token",
      refresh_token: "rotated-refresh-token",
      expires_in: 7200,
      token_type: "Bearer",
      ...overrides,
    },
    { status },
  );
}

function device(): OpenCodeConsoleDeviceCode {
  return {
    server: OPENCODE_CONSOLE_AUTH_SERVER,
    clientId: OPENCODE_CONSOLE_DEVICE_CLIENT_ID,
    deviceCode: "device-secret",
    userCode: "READ-CODE",
    verificationUrl: "https://opencode.ai/console/device",
    expiresAt: Date.now() + 600_000,
    intervalMs: 1000,
  };
}

function session(
  overrides: Partial<OpenCodeConsoleSession> & { scopedOrgId?: string } = {},
): OpenCodeConsoleSession {
  return {
    server: OPENCODE_CONSOLE_AUTH_SERVER,
    clientId: OPENCODE_CONSOLE_DEVICE_CLIENT_ID,
    accessToken: "session-token",
    refreshToken: "refresh-token",
    expiresAt: Date.now() + 7_200_000,
    account: { id: "account-1", email: "person@example.com" },
    organizations: [
      { id: "org-a", name: "First" },
      { id: "org-b", name: "Second" },
    ],
    orgId: "org-a",
    ...overrides,
  };
}

function accountResponse() {
  return Response.json({ id: "account-1", email: "person@example.com" });
}
function orgsResponse(ids = ["org-a", "org-b"]) {
  return Response.json(ids.map((id) => ({ id, name: `Name ${id}` })));
}
const noSleep = async () => {};

async function errorText(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
    assert.fail("Expected authentication to fail");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

test("public auth entry starts an explicit device grant and canonicalizes the legacy Console host", async () => {
  const network = mockNetwork([
    deviceResponse({
      verification_uri_complete:
        "https://console.opencode.ai/device?user_code=READ-CODE",
    }),
  ]);
  const started = Date.now();
  const code = await requestOpenCodeConsoleDeviceCode({
    server: "https://console.opencode.ai///",
    clientId: "custom-test-client",
    fetch: network.fetch,
  });
  assert.equal(code.server, "https://opencode.ai/console");
  assert.equal(code.clientId, "custom-test-client");
  assert.equal(code.deviceCode, "device-secret");
  assert.equal(code.userCode, "READ-CODE");
  assert.equal(
    code.verificationUrl,
    "https://opencode.ai/console/device?user_code=READ-CODE",
  );
  assert.equal(code.intervalMs, 1000);
  assert.ok(
    code.expiresAt >= started + 600_000 &&
      code.expiresAt <= Date.now() + 600_000,
  );
  const request = network.calls[0]!;
  assert.equal(request.url, "https://opencode.ai/console/auth/device/code");
  assert.equal(request.method, "POST");
  assert.deepEqual(request.body, {
    client_id: "custom-test-client",
    supports_org_scope: true,
  });
  assert.equal(request.headers.get("authorization"), null);
  assert.equal(request.redirect, "error");
  assert.ok(request.signal);
});

test("device-grant defaults use the public client and support relative verification URLs", async () => {
  const network = mockNetwork([
    deviceResponse({
      verification_uri_complete: undefined,
      verification_uri: "/console/device",
      interval: undefined,
    }),
  ]);
  const code = await requestOpenCodeConsoleDeviceCode({ fetch: network.fetch });
  assert.equal(code.server, OPENCODE_CONSOLE_AUTH_SERVER);
  assert.equal(code.clientId, OPENCODE_CONSOLE_DEVICE_CLIENT_ID);
  assert.equal(code.verificationUrl, "https://opencode.ai/console/device");
  assert.equal(code.intervalMs, 5000);
  assert.deepEqual(network.calls[0]?.body, {
    client_id: OPENCODE_CONSOLE_DEVICE_CLIENT_ID,
    supports_org_scope: true,
  });
});

test("auth servers reject unsafe URLs before network access and allow HTTP only on loopback", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return deviceResponse();
  };
  for (const server of [
    "http://example.com/console",
    "file:///console",
    "https://secret@example.com/console",
    "https://example.com/console?secret=key",
    "https://example.com/console#secret",
  ]) {
    await assert.rejects(
      requestOpenCodeConsoleDeviceCode({ server, fetch: fetcher }),
      /auth server.*HTTPS/,
    );
  }
  assert.equal(calls, 0);
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    const server = `http://${host}:4321/console`;
    const network = mockNetwork([
      deviceResponse({ verification_uri_complete: `${server}/device` }),
    ]);
    const code = await requestOpenCodeConsoleDeviceCode({
      server,
      fetch: network.fetch,
    });
    assert.equal(code.verificationUrl, `${server}/device`);
    assert.equal(network.calls[0]?.redirect, "error");
  }
});

test("device authorization rejects unrelated and credential-bearing verification URLs", async () => {
  for (const verification_uri_complete of [
    "https://attacker.example/device",
    "https://secret@opencode.ai/console/device",
  ]) {
    const network = mockNetwork([
      deviceResponse({ verification_uri_complete }),
    ]);
    await assert.rejects(
      requestOpenCodeConsoleDeviceCode({ fetch: network.fetch }),
      /verification URL outside/,
    );
  }
});

test("device grant rejects malformed fields and impossible lifetimes", async () => {
  for (const overrides of [
    { device_code: "" },
    { user_code: null },
    { expires_in: 0 },
    { expires_in: -1 },
    { expires_in: 8_640_000_000_001 },
    { expires_in: "600" },
    { interval: 0 },
    { interval: -1 },
    { interval: "five" },
  ]) {
    const network = mockNetwork([deviceResponse(overrides)]);
    await assert.rejects(
      requestOpenCodeConsoleDeviceCode({ fetch: network.fetch }),
      /authentication response|authentication lifetime/,
    );
  }
});

test("device polling respects pending and slow_down then discovers the selected account", async () => {
  const network = mockNetwork([
    Response.json({ error: "authorization_pending" }, { status: 400 }),
    Response.json({ error: "slow_down" }, { status: 400 }),
    tokenResponse(),
    accountResponse(),
    orgsResponse(["org-a"]),
  ]);
  const waits: number[] = [];
  const signedIn = await completeOpenCodeConsoleDeviceSignIn(device(), {
    fetch: network.fetch,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
    },
  });
  assert.deepEqual(waits, [1000, 1000, 6000]);
  assert.equal(signedIn.accessToken, "new-session-token");
  assert.equal(signedIn.refreshToken, "rotated-refresh-token");
  assert.equal(signedIn.orgId, "org-a");
  assert.deepEqual(signedIn.account, {
    id: "account-1",
    email: "person@example.com",
  });
  for (const request of network.calls.slice(0, 3)) {
    assert.equal(request.url, "https://opencode.ai/console/auth/device/token");
    assert.deepEqual(request.body, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: "device-secret",
      client_id: OPENCODE_CONSOLE_DEVICE_CLIENT_ID,
    });
    assert.equal(request.redirect, "error");
  }
  for (const request of network.calls.slice(3))
    assert.equal(
      request.headers.get("authorization"),
      "Bearer new-session-token",
    );
});

test("approved device grants and refreshes accept access tokens lasting thirty days", async () => {
  const lifetimeSeconds = 30 * 24 * 60 * 60;
  const lifetimeMs = lifetimeSeconds * 1000;
  const network = mockNetwork([
    tokenResponse({ expires_in: lifetimeSeconds, org_id: "org-a" }),
    accountResponse(),
    orgsResponse(),
  ]);
  const started = Date.now();
  const signedIn = await completeOpenCodeConsoleDeviceSignIn(device(), {
    fetch: network.fetch,
    sleep: noSleep,
  });
  assert.ok(signedIn.expiresAt >= started + lifetimeMs);
  assert.ok(signedIn.expiresAt <= Date.now() + lifetimeMs);
  assert.equal(signedIn.scopedOrgId, "org-a");
  assert.equal(new Date(signedIn.expiresAt).getTime(), signedIn.expiresAt);
  const auth = createOpenCodeConsoleSessionAuth(signedIn, {
    fetch: network.fetch,
  });
  assert.deepEqual(await auth(new AbortController().signal), {
    accessToken: "new-session-token",
    orgId: "org-a",
  });
  assert.equal(
    network.calls.length,
    3,
    "A fresh long-lived token needs no refresh",
  );

  const refreshNetwork = mockNetwork([
    tokenResponse({
      expires_in: lifetimeSeconds,
      access_token: "refreshed-long-lived-token",
    }),
  ]);
  const refreshing = Date.now();
  const refreshed = await refreshOpenCodeConsoleSession(signedIn, {
    fetch: refreshNetwork.fetch,
  });
  assert.ok(refreshed.expiresAt >= refreshing + lifetimeMs);
  assert.ok(refreshed.expiresAt <= Date.now() + lifetimeMs);
  assert.equal(refreshed.accessToken, "refreshed-long-lived-token");
  assert.equal(refreshed.scopedOrgId, "org-a");
  assert.equal(refreshed.orgId, "org-a");
  assert.equal(signedIn.accessToken, "new-session-token");
  assert.equal(refreshNetwork.calls.length, 1);
});

test("polling intervals keep the timer limit independently of token lifetimes", async () => {
  const network = mockNetwork([
    deviceResponse({ interval: 2_147_484, expires_in: 30 * 24 * 60 * 60 }),
  ]);
  await assert.rejects(
    requestOpenCodeConsoleDeviceCode({ fetch: network.fetch }),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeConsoleAuthError);
      assert.equal(error.stage, "authorization");
      assert.equal(error.status, undefined);
      assert.match(error.message, /invalid polling interval/);
      return true;
    },
  );
  let requests = 0;
  await assert.rejects(
    completeOpenCodeConsoleDeviceSignIn(
      { ...device(), intervalMs: 2_147_483_648 },
      {
        sleep: noSleep,
        fetch: async () => {
          requests++;
          return tokenResponse();
        },
      },
    ),
    /device code lifetime/,
  );
  assert.equal(requests, 0);
});

test("repeated slow_down responses cannot overflow the polling timer", async () => {
  const maximumTimerMs = 2_147_483_647;
  const network = mockNetwork([
    Response.json({ error: "slow_down" }, { status: 400 }),
    Response.json({ error: "slow_down" }, { status: 400 }),
    tokenResponse(),
    accountResponse(),
    orgsResponse(["org-a"]),
  ]);
  const waits: number[] = [];
  const signedIn = await completeOpenCodeConsoleDeviceSignIn(
    {
      ...device(),
      intervalMs: maximumTimerMs - 1000,
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    },
    {
      fetch: network.fetch,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    },
  );
  assert.deepEqual(waits, [
    maximumTimerMs - 1000,
    maximumTimerMs,
    maximumTimerMs,
  ]);
  assert.equal(signedIn.orgId, "org-a");
});

test("post-approval discovery errors identify account or organizations without returning secrets", async () => {
  const accessToken = "private-issued-access-token";
  const refreshToken = "private-issued-refresh-token";
  for (const [stage, status] of [
    ["account", 401],
    ["organizations", 403],
  ] as const) {
    const denied = Response.json(
      {
        error: "forbidden",
        error_description: `${accessToken} ${refreshToken}`,
        access_token: accessToken,
        refresh_token: refreshToken,
      },
      { status },
    );
    const network = mockNetwork([
      tokenResponse({ access_token: accessToken, refresh_token: refreshToken }),
      stage === "account" ? denied : accountResponse(),
      stage === "organizations" ? denied : orgsResponse(),
    ]);
    await assert.rejects(
      completeOpenCodeConsoleDeviceSignIn(device(), {
        fetch: network.fetch,
        sleep: noSleep,
      }),
      (error: unknown) => {
        assert.ok(error instanceof OpenCodeConsoleAuthError);
        assert.equal(error.name, "OpenCodeConsoleAuthError");
        assert.equal(error.stage, stage);
        assert.equal(error.status, status);
        assert.match(error.message, /discovery failed/);
        assert.equal(error.message.includes(accessToken), false);
        assert.equal(error.message.includes(refreshToken), false);
        assert.equal(JSON.stringify(error).includes(accessToken), false);
        assert.equal(JSON.stringify(error).includes(refreshToken), false);
        assert.equal("response" in error, false);
        return true;
      },
    );
    assert.equal(network.calls.length, 3);
    assert.equal(network.calls[1]?.url, "https://opencode.ai/console/api/user");
    assert.equal(network.calls[2]?.url, "https://opencode.ai/console/api/orgs");
    for (const call of network.calls.slice(1))
      assert.equal(call.headers.get("authorization"), `Bearer ${accessToken}`);
  }
});

test("an org-bound grant records its organization and prevents switching account context", async () => {
  const network = mockNetwork([
    tokenResponse({ org_id: "org-b" }),
    accountResponse(),
    orgsResponse(),
  ]);
  const signedIn = await completeOpenCodeConsoleDeviceSignIn(device(), {
    fetch: network.fetch,
    sleep: noSleep,
  });
  assert.equal(signedIn.orgId, "org-b");
  assert.equal(Reflect.get(signedIn, "scopedOrgId"), "org-b");
  const auth = createOpenCodeConsoleSessionAuth(signedIn);
  assert.throws(
    () => auth.selectOrganization("org-a"),
    /bound|scoped|sign in again/i,
  );
  auth.selectOrganization("org-b");
  assert.deepEqual(await auth(new AbortController().signal), {
    accessToken: "new-session-token",
    orgId: "org-b",
  });
  assert.throws(
    () =>
      createOpenCodeConsoleSessionAuth(
        session({ orgId: "org-b", scopedOrgId: "org-a" }),
      ),
    /organization.*granted scope/,
  );
});

test("multi-organization unbound sessions require an explicit organization selection", async () => {
  const network = mockNetwork([
    tokenResponse(),
    accountResponse(),
    orgsResponse(),
  ]);
  const signedIn = await completeOpenCodeConsoleDeviceSignIn(device(), {
    fetch: network.fetch,
    sleep: noSleep,
  });
  assert.equal(signedIn.orgId, undefined);
  const auth = createOpenCodeConsoleSessionAuth(signedIn);
  await assert.rejects(
    async () => auth(new AbortController().signal),
    /Select.*organization/,
  );
  assert.throws(() => auth.selectOrganization("unknown-org"), /not available/);
  auth.selectOrganization("org-b");
  assert.deepEqual(await auth(new AbortController().signal), {
    accessToken: "new-session-token",
    orgId: "org-b",
  });
});

test("polling denied, expired, and unknown errors terminate without exposing server detail", async () => {
  const sensitive = "sensitive-access-token";
  for (const [error, expected] of [
    ["access_denied", /denied/],
    ["expired_token", /expired/],
    ["server_error", /token exchange failed/],
  ] as const) {
    const network = mockNetwork([
      Response.json(
        { error, error_description: sensitive, access_token: sensitive },
        { status: 400 },
      ),
    ]);
    const message = await errorText(() =>
      completeOpenCodeConsoleDeviceSignIn(device(), {
        fetch: network.fetch,
        sleep: noSleep,
      }),
    );
    assert.match(message, expected);
    assert.equal(message.includes(sensitive), false);
    assert.equal(network.calls.length, 1);
  }
});

test("device polling expires while waiting and can be cancelled before another request", async () => {
  let requests = 0;
  const fetcher: typeof fetch = async () => {
    requests++;
    return tokenResponse();
  };
  const expiring = device();
  await assert.rejects(
    completeOpenCodeConsoleDeviceSignIn(expiring, {
      fetch: fetcher,
      sleep: async () => {
        expiring.expiresAt = Date.now() - 1;
      },
    }),
    /device code expired/,
  );
  const controller = new AbortController();
  const cancelled = completeOpenCodeConsoleDeviceSignIn(device(), {
    fetch: fetcher,
    signal: controller.signal,
  });
  controller.abort(new Error("cancel sign-in"));
  await assert.rejects(cancelled, /cancel sign-in/);
  assert.equal(requests, 0);
  for (const invalid of [
    { intervalMs: 0 },
    { intervalMs: Number.POSITIVE_INFINITY },
    { expiresAt: Number.NaN },
  ]) {
    await assert.rejects(
      completeOpenCodeConsoleDeviceSignIn(
        { ...device(), ...invalid },
        { fetch: fetcher, sleep: noSleep },
      ),
      /device code lifetime/,
    );
  }
});

test("token parsing rejects unsupported token types, invalid expiration, and malformed sensitive bodies", async () => {
  for (const overrides of [
    { token_type: "Basic" },
    { expires_in: 0 },
    { expires_in: "7200" },
    { access_token: "" },
    { refresh_token: null },
  ]) {
    const network = mockNetwork([tokenResponse(overrides)]);
    await assert.rejects(
      completeOpenCodeConsoleDeviceSignIn(device(), {
        fetch: network.fetch,
        sleep: noSleep,
      }),
      /token type|authentication lifetime|authentication response/,
    );
    assert.equal(network.calls.length, 1);
  }
  const sensitive = "DO-NOT-EXPOSE-REFRESH-TOKEN";
  const network = mockNetwork([
    new Response(`not-json ${sensitive}`, {
      headers: { "Content-Type": "application/json" },
    }),
  ]);
  const message = await errorText(() =>
    completeOpenCodeConsoleDeviceSignIn(device(), {
      fetch: network.fetch,
      sleep: noSleep,
    }),
  );
  assert.equal(message.includes(sensitive), false);
  assert.match(message, /invalid|authentication response|token exchange/i);
});

test("auth response-body cancellation preserves the caller's abort or timeout reason", async () => {
  for (const reason of [
    new Error("cancel fixture auth body"),
    new DOMException("fixture auth timeout", "TimeoutError"),
  ]) {
    const controller = new AbortController();
    const entered = deferred<void>();
    const signingIn = requestOpenCodeConsoleDeviceCode({
      signal: controller.signal,
      fetch: async (_input, init) => {
        const signal = init?.signal;
        assert.ok(signal);
        const response = new Response(
          new ReadableStream<Uint8Array>({
            start(body) {
              signal.addEventListener(
                "abort",
                () => body.error(signal.reason),
                { once: true },
              );
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
        const readJSON = response.json.bind(response);
        response.json = () => {
          entered.resolve();
          return readJSON();
        };
        return response;
      },
    });
    const rejected = assert.rejects(
      signingIn,
      (error: unknown) => error === reason,
    );
    await entered.promise;
    controller.abort(reason);
    await rejected;
  }
});

test("malformed issued access tokens fail before account discovery without echoing credentials", async () => {
  const sensitive = "fixture-sensitive-issued-token";
  const network = mockNetwork([
    tokenResponse({ access_token: `${sensitive}\ninvalid` }),
  ]);
  await assert.rejects(
    completeOpenCodeConsoleDeviceSignIn(device(), {
      fetch: network.fetch,
      sleep: noSleep,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HTTP headers.*invalid/);
      assert.equal(error.message.includes(sensitive), false);
      assert.equal("cause" in error, false);
      return true;
    },
  );
  assert.equal(network.calls.length, 1);
});

test("refresh rotates credentials and preserves org binding when the server omits it", async () => {
  const original = session({ orgId: "org-a", scopedOrgId: "org-a" });
  const network = mockNetwork([tokenResponse()]);
  const refreshed = await refreshOpenCodeConsoleSession(original, {
    fetch: network.fetch,
  });
  assert.equal(refreshed.accessToken, "new-session-token");
  assert.equal(refreshed.refreshToken, "rotated-refresh-token");
  assert.equal(refreshed.orgId, "org-a");
  assert.equal(Reflect.get(refreshed, "scopedOrgId"), "org-a");
  assert.equal(original.accessToken, "session-token");
  assert.deepEqual(network.calls[0]?.body, {
    grant_type: "refresh_token",
    refresh_token: "refresh-token",
    client_id: OPENCODE_CONSOLE_DEVICE_CLIENT_ID,
  });
  assert.equal(network.calls[0]?.redirect, "error");
  const omitted = mockNetwork([tokenResponse({ refresh_token: undefined })]);
  assert.equal(
    (await refreshOpenCodeConsoleSession(original, { fetch: omitted.fetch }))
      .refreshToken,
    "refresh-token",
  );
});

test("refresh rejects a change to the grant's bound organization", async () => {
  const network = mockNetwork([tokenResponse({ org_id: "org-b" })]);
  await assert.rejects(
    refreshOpenCodeConsoleSession(
      session({ orgId: "org-a", scopedOrgId: "org-a" }),
      { fetch: network.fetch },
    ),
    /organization|bound|scoped/i,
  );
});

test("refresh errors require sign-in again and do not reveal rejected credentials", async () => {
  const sensitive = "secret-refresh-token-in-body";
  for (const response of [
    Response.json(
      { error: "invalid_grant", error_description: sensitive },
      { status: 401 },
    ),
    Response.json({ error: "invalid_grant", refresh_token: sensitive }),
    tokenResponse({ expires_in: 0 }),
    new Response(`malformed ${sensitive}`),
  ]) {
    const network = mockNetwork([response]);
    const message = await errorText(() =>
      refreshOpenCodeConsoleSession(session(), { fetch: network.fetch }),
    );
    assert.equal(message.includes(sensitive), false);
    assert.match(message, /refresh|authentication response|invalid/i);
  }
});

test("public revocation sends only the refresh grant and treats local clearing independently", async () => {
  const network = mockNetwork([new Response(null, { status: 204 })]);
  const original = session();
  await revokeOpenCodeConsoleSession(original, { fetch: network.fetch });
  assert.equal(
    network.calls[0]?.url,
    "https://opencode.ai/console/auth/oauth/revoke",
  );
  assert.deepEqual(network.calls[0]?.body, {
    token: "refresh-token",
    token_type_hint: "refresh_token",
    client_id: OPENCODE_CONSOLE_DEVICE_CLIENT_ID,
  });
  assert.equal(network.calls[0]?.headers.get("authorization"), null);
  assert.equal(network.calls[0]?.redirect, "error");
  const auth = createOpenCodeConsoleSessionAuth(original, {
    fetch: network.fetch,
  });
  auth.clear();
  assert.equal(auth.getSession(), undefined);
  assert.equal(network.calls.length, 1);
  const denied = mockNetwork([
    Response.json({ error_description: "private-token" }, { status: 401 }),
  ]);
  const message = await errorText(() =>
    revokeOpenCodeConsoleSession(original, { fetch: denied.fetch }),
  );
  assert.match(message, /revocation failed.*401/);
  assert.equal(message.includes("private-token"), false);
});

test("session state and refresh results are isolated from caller mutation", async () => {
  const initial = session();
  const network = mockNetwork([tokenResponse()]);
  const auth = createOpenCodeConsoleSessionAuth(initial, {
    fetch: network.fetch,
  });
  initial.accessToken = "mutated-token";
  initial.account.email = "changed@example.com";
  initial.organizations[0]!.name = "Changed";
  assert.equal(auth.getSession()?.accessToken, "session-token");
  assert.equal(auth.getSession()?.account.email, "person@example.com");
  const snapshot = auth.getSession()!;
  snapshot.account.email = "mutated-copy@example.com";
  snapshot.organizations[0]!.name = "Mutated copy";
  assert.equal(auth.getSession()?.account.email, "person@example.com");
  assert.equal(auth.getSession()?.organizations[0]?.name, "First");
  const [one, two] = await Promise.all([auth.refresh(), auth.refresh()]);
  assert.notStrictEqual(one, two);
  one.account.email = "mutated-refresh@example.com";
  one.organizations[0]!.name = "Changed refresh";
  assert.equal(two.account.email, "person@example.com");
  assert.equal(two.organizations[0]?.name, "First");
  assert.equal(auth.getSession()?.account.email, "person@example.com");
  assert.equal(network.calls.length, 1);
});

test("concurrent inference callers share one refresh while each session instance remains independent", async () => {
  const network = mockNetwork([
    tokenResponse(),
    tokenResponse({ access_token: "other-session-token" }),
  ]);
  const first = createOpenCodeConsoleSessionAuth(
    session({ expiresAt: Date.now() - 1 }),
    { fetch: network.fetch },
  );
  const second = createOpenCodeConsoleSessionAuth(
    session({ expiresAt: Date.now() - 1 }),
    { fetch: network.fetch },
  );
  const credentials = await Promise.all([
    first(new AbortController().signal),
    first(new AbortController().signal),
    second(new AbortController().signal),
  ]);
  assert.deepEqual(
    credentials.map((value) => value.accessToken),
    ["new-session-token", "new-session-token", "other-session-token"],
  );
  assert.equal(network.calls.length, 2);
});

test("one cancelled caller does not abort another caller's shared refresh", async () => {
  const gate = deferred<Response>();
  const entered = deferred<void>();
  let requests = 0;
  let sharedSignal: AbortSignal | null | undefined;
  const auth = createOpenCodeConsoleSessionAuth(
    session({ expiresAt: Date.now() - 1 }),
    {
      fetch: async (_input, init) => {
        requests++;
        sharedSignal = init?.signal;
        entered.resolve();
        return gate.promise;
      },
    },
  );
  const controller = new AbortController();
  const cancelled = Promise.resolve(auth(controller.signal));
  const other = auth(new AbortController().signal);
  const rejection = assert.rejects(cancelled, /cancel one/);
  await entered.promise;
  controller.abort(new Error("cancel one"));
  await rejection;
  assert.equal(sharedSignal?.aborted, false);
  gate.resolve(tokenResponse());
  assert.deepEqual(await other, {
    accessToken: "new-session-token",
    orgId: "org-a",
  });
  assert.equal(requests, 1);
});

test("organization selection during an unbound refresh is retained", async () => {
  const gate = deferred<Response>();
  const entered = deferred<void>();
  const auth = createOpenCodeConsoleSessionAuth(session(), {
    fetch: async () => {
      entered.resolve();
      return gate.promise;
    },
  });
  const refreshing = auth.refresh();
  await entered.promise;
  auth.selectOrganization("org-b");
  gate.resolve(tokenResponse());
  assert.equal((await refreshing).orgId, "org-b");
  assert.equal(auth.getSession()?.orgId, "org-b");
});

test("synchronous fetch cancellation rejects only that refresh caller", async () => {
  const controller = new AbortController();
  const reason = new Error("cancel caller during fixture fetch setup");
  const gate = deferred<Response>();
  let requests = 0;
  let sharedSignal: AbortSignal | null | undefined;
  const auth = createOpenCodeConsoleSessionAuth(session(), {
    fetch: async (_input, init) => {
      requests++;
      sharedSignal = init?.signal;
      controller.abort(reason);
      return gate.promise;
    },
  });
  const cancelled = auth.refresh(controller.signal);
  const other = auth.refresh();
  await assert.rejects(cancelled, (error: unknown) => error === reason);
  assert.equal(sharedSignal?.aborted, false);
  gate.resolve(tokenResponse());
  assert.equal((await other).accessToken, "new-session-token");
  assert.equal(auth.getSession()?.accessToken, "new-session-token");
  assert.equal(requests, 1);
});

test("clearing during a refresh cannot resurrect an authenticated session", async () => {
  const gate = deferred<Response>();
  const entered = deferred<void>();
  const auth = createOpenCodeConsoleSessionAuth(session(), {
    fetch: async () => {
      entered.resolve();
      return gate.promise;
    },
  });
  const refreshing = auth.refresh();
  await entered.promise;
  auth.clear();
  gate.resolve(tokenResponse());
  await assert.rejects(refreshing, /cleared|abort/i);
  assert.equal(auth.getSession(), undefined);
  await assert.rejects(
    async () => auth(new AbortController().signal),
    /Sign in.*first/,
  );
});

test("a rejected refresh is not replaced by stale credentials and later explicit recovery works", async () => {
  const network = mockNetwork([
    Response.json({ error: "invalid_grant" }, { status: 401 }),
    tokenResponse(),
  ]);
  const auth = createOpenCodeConsoleSessionAuth(
    session({ expiresAt: Date.now() - 1 }),
    { fetch: network.fetch },
  );
  await assert.rejects(
    async () => auth(new AbortController().signal),
    /sign in again|refresh/i,
  );
  assert.equal(auth.getSession()?.accessToken, "session-token");
  assert.deepEqual(await auth(new AbortController().signal), {
    accessToken: "new-session-token",
    orgId: "org-a",
  });
  assert.equal(network.calls.length, 2);
});

test("session transport overrides ambient service keys and owns the organization headers", async () => {
  const previous = process.env.OPENCODE_API_KEY;
  process.env.OPENCODE_API_KEY = "ambient-service-key";
  try {
    const network = mockNetwork([Response.json({}), Response.json({})]);
    const selected = {
      accessToken: " session-access-token ",
      orgId: " org-a ",
    };
    const headers = new Headers({
      "X-Org-Id": "wrong-org",
      "X-OpenCode-Org-Id": "wrong-org",
      "X-Tenant": "first",
    });
    const config = {
      session: selected,
      defaultHeaders: headers,
      fetch: network.fetch,
    };
    const transport = createConsoleFetch(config);
    await transport("https://opencode.ai/inference/v1/models", {
      headers: {
        Authorization: "Bearer stale",
        "X-Org-Id": "caller-wrong-org",
        "x-api-key": "native-key",
      },
    });
    selected.accessToken = "mutated-session-token";
    selected.orgId = "org-b";
    headers.set("X-Tenant", "mutated");
    await transport("https://opencode.ai/inference/v1/models");
    for (const request of network.calls) {
      assert.equal(
        request.headers.get("authorization"),
        "Bearer session-access-token",
      );
      assert.equal(request.headers.get("x-org-id"), "org-a");
      assert.equal(request.headers.get("x-opencode-org-id"), "org-a");
      assert.equal(request.headers.get("x-api-key"), null);
      assert.equal(request.headers.get("x-tenant"), "first");
      assert.equal(request.redirect, "error");
    }
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = previous;
  }
});

test("mixed or incomplete authentication is rejected and invalid roots never resolve a session", async () => {
  const valid = { accessToken: "session-access-token", orgId: "org-a" };
  assert.throws(
    () =>
      opencodeConsoleText("big-pickle", {
        session: valid,
        apiKey: "service-key",
      }),
    /either apiKey or session/,
  );
  assert.throws(
    () => createConsoleFetch({ session: valid, apiKey: "" }),
    /either apiKey or session/,
  );
  for (const invalid of [
    { accessToken: "", orgId: "org-a" },
    { accessToken: "token", orgId: "" },
  ]) {
    let calls = 0;
    const transport = createConsoleFetch({
      session: invalid,
      fetch: async () => {
        calls++;
        return Response.json({});
      },
    });
    await assert.rejects(
      transport("https://opencode.ai/inference/v1/models"),
      /access token and organization/,
    );
    assert.equal(calls, 0);
  }
  let credentials = 0;
  let requests = 0;
  const transport = createConsoleFetch({
    session: () => {
      credentials++;
      return valid;
    },
    fetch: async () => {
      requests++;
      return Response.json({});
    },
  });
  await assert.rejects(
    transport("https://attacker.example/inference/v1/models"),
    /outside.*inference root/,
  );
  assert.equal(credentials, 0);
  assert.equal(requests, 0);
});

test("session suppliers receive cancellation and cannot hang beyond the transport timeout", async () => {
  let suppliedSignal: AbortSignal | undefined;
  let requests = 0;
  const transport = createConsoleFetch({
    timeout: 25,
    session: (signal) => {
      suppliedSignal = signal;
      return new Promise(() => {});
    },
    fetch: async () => {
      requests++;
      return Response.json({});
    },
  });
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    await assert.rejects(
      transport("https://opencode.ai/inference/v1/models"),
      (error: unknown) =>
        error instanceof Error && error.name === "TimeoutError",
    );
    assert.equal(suppliedSignal?.aborted, true);
    assert.equal(requests, 0);
  } finally {
    clearTimeout(keepAlive);
  }
});

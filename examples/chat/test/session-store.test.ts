import assert from "node:assert/strict";
import test from "node:test";
import {
  createRedisSessionStore,
  SessionStoreError,
} from "../session-store.js";

type Command = Array<string | number>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function redisFixture() {
  const entries = new Map<string, { value: string; expiresAt: number }>();
  const calls: Array<{ args: Command; request: Request }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const args = JSON.parse(await request.text()) as Command;
    calls.push({ args, request });
    const name = args[0];
    const key = String(name === "EVAL" ? args[3] : args[1]);
    const existing = entries.get(key);
    if (existing && existing.expiresAt <= Date.now()) entries.delete(key);
    let result: unknown;
    if (name === "GET") result = entries.get(key)?.value ?? null;
    else if (name === "SET") {
      if (args.includes("NX") && entries.has(key)) result = null;
      else {
        const ttl = Number(args[args.indexOf("EX") + 1]);
        entries.set(key, {
          value: String(args[2]),
          expiresAt: Date.now() + ttl * 1000,
        });
        result = "OK";
      }
    } else if (name === "DEL") result = entries.delete(key) ? 1 : 0;
    else if (name === "EVAL") {
      assert.equal(args[2], 1);
      if (args.length === 4) {
        assert.equal(args[1], 'return redis.call("GET", KEYS[1])');
        result = entries.get(key)?.value ?? null;
        return Response.json({ result });
      }
      assert.match(
        String(args[1]),
        /redis\.call\("GET", KEYS\[1\]\) == ARGV\[1\]/,
      );
      assert.match(String(args[1]), /redis\.call\("DEL", KEYS\[1\]\)/);
      result =
        entries.get(key)?.value === args[4] && entries.delete(key) ? 1 : 0;
    } else assert.fail("Unexpected fixture command");
    return Response.json({ result });
  };
  return { entries, calls, fetch: fetcher };
}

function store(
  fetcher: typeof fetch,
  options: { prefix?: string; lockWaitMs?: number } = {},
) {
  return createRedisSessionStore({
    url: "https://fixture.upstash.invalid/",
    token: "fixture-rest-token",
    prefix: "demo:preview",
    fetch: fetcher,
    ...options,
  });
}

test("opaque values use authenticated POST commands and bounded expiry", async () => {
  const network = redisFixture();
  const sessions = store(network.fetch);
  const ciphertext = 'opaque-encrypted-JSON:"quoted"\nvalue';
  assert.equal(await sessions.read("visitor-1"), undefined);
  await sessions.write("visitor-1", ciphertext, 3600);
  assert.equal(await sessions.read("visitor-1"), ciphertext);
  await sessions.delete("visitor-1");
  assert.equal(await sessions.read("visitor-1"), undefined);
  assert.deepEqual(network.calls[1]?.args, [
    "SET",
    "demo:preview:session:visitor-1",
    ciphertext,
    "EX",
    3600,
  ]);
  assert.deepEqual(network.calls[0]?.args, [
    "EVAL",
    'return redis.call("GET", KEYS[1])',
    1,
    "demo:preview:session:visitor-1",
  ]);
  for (const { request } of network.calls) {
    assert.equal(request.url, "https://fixture.upstash.invalid/");
    assert.equal(request.method, "POST");
    assert.equal(
      request.headers.get("authorization"),
      "Bearer fixture-rest-token",
    );
    assert.equal(request.headers.get("content-type"), "application/json");
    assert.equal(request.redirect, "error");
    assert.equal(request.cache, "no-store");
  }
  const before = network.calls.length;
  for (const ttl of [0, -1, 0.5, 43201, Number.NaN]) {
    await assert.rejects(
      sessions.write("visitor-1", ciphertext, ttl),
      SessionStoreError,
    );
  }
  await assert.rejects(sessions.read("../other-visitor"), SessionStoreError);
  assert.equal(network.calls.length, before);
});

test("Preview and Production namespaces never share a visitor record", async () => {
  const network = redisFixture();
  const preview = store(network.fetch);
  const production = store(network.fetch, { prefix: "demo:production" });
  await preview.write("same-id", "preview-ciphertext", 600);
  assert.equal(await production.read("same-id"), undefined);
  await production.write("same-id", "production-ciphertext", 600);
  assert.equal(await preview.read("same-id"), "preview-ciphertext");
  assert.equal(await production.read("same-id"), "production-ciphertext");
});

test("unsafe configuration fails without exposing URL or token values", () => {
  const sensitive = "fixture-sensitive-rest-token";
  for (const url of [
    "not-a-url",
    "http://fixture.upstash.invalid",
    `https://${sensitive}@fixture.upstash.invalid`,
    `https://fixture.upstash.invalid/?token=${sensitive}`,
    "https://fixture.upstash.invalid/path",
    "https://fixture.upstash.invalid/#fragment",
  ]) {
    assert.throws(
      () => createRedisSessionStore({ url, token: sensitive, prefix: "demo" }),
      (error: unknown) => {
        assert.ok(error instanceof SessionStoreError);
        assert.equal(error.code, "configuration");
        assert.equal(error.message.includes(sensitive), false);
        assert.equal("cause" in error, false);
        return true;
      },
    );
  }
  for (const token of ["", `${sensitive}\ninvalid`]) {
    assert.throws(
      () =>
        createRedisSessionStore({
          url: "https://fixture.upstash.invalid",
          token,
          prefix: "demo",
        }),
      (error: unknown) => {
        assert.ok(error instanceof SessionStoreError);
        assert.equal(error.message.includes(sensitive), false);
        return true;
      },
    );
  }
});

test("upstream HTTP, Redis, malformed payload and fetch errors are secret-safe", async () => {
  const sensitive = "fixture-rest-token";
  const outcomes = [
    async () => Response.json({ error: sensitive }, { status: 401 }),
    async () => Response.json({ error: `ERR ${sensitive}` }),
    async () => new Response(`malformed ${sensitive}`),
    async () => Response.json({ result: 42 }),
    async () => {
      throw new Error(`request failed with ${sensitive}`);
    },
  ];
  for (const fetcher of outcomes) {
    await assert.rejects(store(fetcher).read("visitor"), (error: unknown) => {
      assert.ok(error instanceof SessionStoreError);
      assert.equal(error.code, "unavailable");
      assert.equal(error.message.includes(sensitive), false);
      assert.equal("cause" in error, false);
      return true;
    });
  }
});

test("independent instances serialize one visitor through Redis NX locks", async () => {
  const network = redisFixture();
  const first = store(network.fetch);
  const second = store(network.fetch);
  const entered = deferred<void>();
  const gate = deferred<void>();
  let secondEntered = false;
  const one = first.withLock("visitor", undefined, async () => {
    entered.resolve();
    await gate.promise;
    return "first";
  });
  await entered.promise;
  const two = second.withLock("visitor", undefined, async () => {
    secondEntered = true;
    return "second";
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(secondEntered, false);
  gate.resolve();
  assert.deepEqual(await Promise.all([one, two]), ["first", "second"]);
  const acquisitions = network.calls.filter(
    ({ args }) => args[0] === "SET" && args.includes("NX"),
  );
  assert.ok(acquisitions.length >= 3);
  for (const { args } of acquisitions) {
    assert.deepEqual(args.slice(3), ["NX", "EX", 300]);
  }
  const releases = network.calls.filter(({ args }) => args[0] === "EVAL");
  assert.equal(releases.length, 2);
  assert.notEqual(releases[0]?.args[4], releases[1]?.args[4]);
  assert.equal(network.entries.has("demo:preview:lock:visitor"), false);
});

test("lock contention has a bounded wait and never deletes another owner", async () => {
  const network = redisFixture();
  network.entries.set("demo:preview:lock:visitor", {
    value: "another-owner",
    expiresAt: Date.now() + 300_000,
  });
  let entered = false;
  await assert.rejects(
    store(network.fetch, { lockWaitMs: 20 }).withLock(
      "visitor",
      undefined,
      async () => {
        entered = true;
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof SessionStoreError);
      assert.equal(error.code, "lock_timeout");
      return true;
    },
  );
  assert.equal(entered, false);
  assert.equal(
    network.entries.get("demo:preview:lock:visitor")?.value,
    "another-owner",
  );
  assert.equal(
    network.calls.some(({ args }) => args[0] === "DEL" || args[0] === "EVAL"),
    false,
  );
});

test("incoming cancellation stops acquisition before metadata operations run", async () => {
  const network = redisFixture();
  const controller = new AbortController();
  const reason = new Error("cancel fixture acquisition");
  controller.abort(reason);
  await assert.rejects(
    store(network.fetch).withLock("visitor", controller.signal, async () =>
      assert.fail("Must not run"),
    ),
    (error: unknown) => error === reason,
  );
  assert.equal(network.calls.length, 0);
});

test("cancelling a contended acquisition preserves the existing lock", async () => {
  const network = redisFixture();
  const entered = deferred<void>();
  network.entries.set("demo:preview:lock:visitor", {
    value: "another-owner",
    expiresAt: Date.now() + 300_000,
  });
  const controller = new AbortController();
  const reason = new Error("cancel contended fixture acquisition");
  const fetcher: typeof fetch = async (input, init) => {
    const response = await network.fetch(input, init);
    entered.resolve();
    return response;
  };
  const acquiring = store(fetcher).withLock(
    "visitor",
    controller.signal,
    async () => assert.fail("Must not run"),
  );
  const rejected = assert.rejects(
    acquiring,
    (error: unknown) => error === reason,
  );
  await entered.promise;
  controller.abort(reason);
  await rejected;
  assert.equal(
    network.entries.get("demo:preview:lock:visitor")?.value,
    "another-owner",
  );
});

test("refresh and persistence continue after browser disconnect once a lock is held", async () => {
  const network = redisFixture();
  const sessions = store(network.fetch);
  const controller = new AbortController();
  const entered = deferred<void>();
  const gate = deferred<void>();
  let operationSignal: AbortSignal | undefined;
  const refreshing = sessions.withLock(
    "visitor",
    controller.signal,
    async (signal) => {
      operationSignal = signal;
      entered.resolve();
      await gate.promise;
      await sessions.write("visitor", "rotated-encrypted-session", 600, signal);
      return "persisted";
    },
  );
  await entered.promise;
  controller.abort();
  assert.equal(operationSignal?.aborted, false);
  gate.resolve();
  assert.equal(await refreshing, "persisted");
  assert.equal(await sessions.read("visitor"), "rotated-encrypted-session");
  assert.equal(network.entries.has("demo:preview:lock:visitor"), false);
});

test("owner-safe Lua release cannot remove a replacement lock", async () => {
  const network = redisFixture();
  await assert.rejects(
    store(network.fetch).withLock("visitor", undefined, async () => {
      network.entries.set("demo:preview:lock:visitor", {
        value: "replacement-owner",
        expiresAt: Date.now() + 300_000,
      });
    }),
    (error: unknown) => {
      assert.ok(error instanceof SessionStoreError);
      assert.equal(error.code, "lease_lost");
      return true;
    },
  );
  assert.equal(
    network.entries.get("demo:preview:lock:visitor")?.value,
    "replacement-owner",
  );
});

test("operation failure releases the lock and preserves the original error", async () => {
  const network = redisFixture();
  const reason = new Error("fixture metadata failed");
  await assert.rejects(
    store(network.fetch).withLock("visitor", undefined, async () => {
      throw reason;
    }),
    (error: unknown) => error === reason,
  );
  assert.equal(network.entries.has("demo:preview:lock:visitor"), false);
});

test("an ambiguous acquisition acknowledgement triggers owner-safe cleanup", async () => {
  const network = redisFixture();
  let lost = false;
  const fetcher: typeof fetch = async (input, init) => {
    const response = await network.fetch(input, init);
    const args = network.calls.at(-1)?.args;
    if (!lost && args?.[0] === "SET" && args.includes("NX")) {
      lost = true;
      throw new Error("fixture acknowledgement lost");
    }
    return response;
  };
  await assert.rejects(
    store(fetcher).withLock("visitor", undefined, async () =>
      assert.fail("Must not run"),
    ),
    SessionStoreError,
  );
  assert.equal(network.entries.has("demo:preview:lock:visitor"), false);
  assert.equal(network.calls.at(-1)?.args[0], "EVAL");
});

test("release failures remain secret-safe and do not mask operation failures", async () => {
  for (const failOperation of [false, true]) {
    const network = redisFixture();
    const operationError = new Error("fixture operation failed");
    const sensitive = "fixture-sensitive-release-error";
    const fetcher: typeof fetch = async (input, init) => {
      const args = JSON.parse(String(init?.body)) as Command;
      if (args[0] === "EVAL" && args.length === 5) {
        return Response.json({ error: sensitive });
      }
      return network.fetch(input, init);
    };
    await assert.rejects(
      store(fetcher).withLock("visitor", undefined, async () => {
        if (failOperation) throw operationError;
        return "completed";
      }),
      (error: unknown) => {
        if (failOperation) assert.strictEqual(error, operationError);
        else {
          assert.ok(error instanceof SessionStoreError);
          assert.equal(error.message.includes(sensitive), false);
        }
        return true;
      },
    );
    assert.ok(network.entries.has("demo:preview:lock:visitor"));
  }
});

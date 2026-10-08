import {
  chat,
  chatParamsFromRequestBody,
  maxIterations,
  toServerSentEventsResponse,
} from "@tanstack/ai";
import {
  listOpenCodeConsoleModels,
  opencodeConsoleText,
} from "tanstack-ai-opencode-console";
import { createHostedAuth, sessionId } from "./hosted-auth.js";
import {
  createRedisSessionStore,
  SessionStoreError,
  type SessionStore,
} from "./session-store.js";
import {
  HttpError,
  MAX_REQUEST_BYTES,
  RUN_TIMEOUT_MS,
  currentTime,
  isRecord,
  outputLimit,
  safeStream,
  validateBody,
} from "./chat-core.js";

interface HostedOptions {
  store?: SessionStore;
  sessionSecret?: string;
  authServer?: string;
  baseURL?: string;
  defaultModel?: string;
  allowedModels?: string[];
  allowedOrigins?: string[];
  fetch?: typeof globalThis.fetch;
  runTimeoutMs?: number;
  watchIntervalMs?: number;
}

function origin(value: string): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      ))
  )
    throw new Error("Configure exact HTTPS origins for the hosted demo.");
  return url.origin;
}

export function deploymentOrigins(
  env: Record<string, string | undefined>,
): string[] {
  return [
    ...new Set([
      ...[
        env.VERCEL_URL,
        env.VERCEL_BRANCH_URL,
        env.VERCEL_PROJECT_PRODUCTION_URL,
      ]
        .filter((host): host is string => Boolean(host))
        .map((host) => origin(`https://${host}`)),
      ...(env.OPENCODE_ALLOWED_ORIGINS?.split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map(origin) ?? []),
    ]),
  ];
}

function json(status: number, body: unknown, headers?: HeadersInit): Response {
  const result = new Headers(headers);
  result.set("Cache-Control", "no-store");
  result.set("X-Content-Type-Options", "nosniff");
  return Response.json(body, { status, headers: result });
}

async function readBody(request: Request): Promise<unknown> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new HttpError(415, "Use Content-Type: application/json.");
  if (Number(request.headers.get("content-length") ?? 0) > MAX_REQUEST_BYTES)
    throw new HttpError(413, "Conversation too large. Start a new chat.");
  if (!request.body)
    throw new HttpError(400, "The request body must be valid JSON.");
  const reader = request.body.getReader();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      void reader.cancel(request.signal.reason).catch(() => {});
      reject(request.signal.reason);
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) onAbort();
  });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      request.signal.throwIfAborted();
      const part = await Promise.race([reader.read(), aborted]);
      request.signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new HttpError(413, "Conversation too large. Start a new chat.");
      }
      chunks.push(part.value);
    }
  } finally {
    request.signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "The request body must be valid JSON.");
  }
}

/** Per-visitor Console sessions persisted across Vercel instances. */
export function createVercelHandler(options: HostedOptions = {}) {
  const allowedOrigins = new Set(
    options.allowedOrigins?.map(origin) ?? deploymentOrigins(process.env),
  );
  const allowedModels =
    options.allowedModels ??
    process.env.OPENCODE_ALLOWED_MODELS?.split(",")
      .map((id) => id.trim())
      .filter(Boolean);
  const defaultModel =
    options.defaultModel ?? process.env.OPENCODE_MODEL ?? "gpt-5-nano";
  let auth: ReturnType<typeof createHostedAuth> | undefined;
  function getAuth() {
    if (auth) return auth;
    try {
      const useUpstashNames =
        process.env.UPSTASH_REDIS_REST_URL !== undefined ||
        process.env.UPSTASH_REDIS_REST_TOKEN !== undefined;
      const store =
        options.store ??
        createRedisSessionStore({
          url:
            (useUpstashNames
              ? process.env.UPSTASH_REDIS_REST_URL
              : process.env.KV_REST_API_URL) ?? "",
          token:
            (useUpstashNames
              ? process.env.UPSTASH_REDIS_REST_TOKEN
              : process.env.KV_REST_API_TOKEN) ?? "",
          prefix: process.env.OPENCODE_SESSION_PREFIX ?? "",
        });
      auth = createHostedAuth({
        store,
        secret:
          options.sessionSecret ?? process.env.OPENCODE_SESSION_SECRET ?? "",
        fetch: options.fetch,
        authServer: options.authServer,
      });
      return auth;
    } catch {
      throw new HttpError(
        503,
        "The deployment owner needs to configure shared Console session storage.",
      );
    }
  }
  function config(id: string, revision: string) {
    return {
      // A session supplier takes precedence over service-key environment fallback.
      session: (signal: AbortSignal) =>
        getAuth().credentials(id, revision, signal),
      baseURL: options.baseURL ?? process.env.OPENCODE_BASE_URL,
      fetch: options.fetch,
      timeout: 60_000,
      maxRetries: 1,
    };
  }
  async function models(id: string, revision: string, signal: AbortSignal) {
    const available = (
      await listOpenCodeConsoleModels(config(id, revision), { signal })
    ).filter(
      (model) =>
        model.supported &&
        model.api !== "systemone" &&
        (!allowedModels || allowedModels.includes(model.id)),
    );
    await getAuth().assertRevision(id, revision, signal);
    return available;
  }

  return async function handle(request: Request): Promise<Response> {
    let controller: AbortController | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let detach: (() => void) | undefined;
    try {
      const url = new URL(request.url);
      const host = request.headers.get("host");
      if (
        !allowedOrigins.has(url.origin) ||
        (host && host.toLowerCase() !== url.host.toLowerCase()) ||
        request.headers.get("sec-fetch-site") === "cross-site" ||
        (request.headers.has("origin") &&
          request.headers.get("origin") !== url.origin) ||
        (request.method === "POST" &&
          request.headers.get("origin") !== url.origin)
      )
        throw new HttpError(
          403,
          "This demo only accepts requests from its own browser origin.",
        );
      request.signal.throwIfAborted();
      const auth = getAuth();
      const id = sessionId(request);
      if (request.method === "GET" && url.pathname === "/api/auth/status") {
        const result = await auth.status(id, request.signal);
        return json(
          200,
          result.state,
          result.cookie ? { "Set-Cookie": result.cookie } : undefined,
        );
      }
      if (request.method === "POST" && url.pathname === "/api/auth/logout") {
        await auth.logout(id, request.signal);
        const next = await auth.status(undefined, request.signal);
        return json(200, next.state, { "Set-Cookie": next.cookie! });
      }
      const catalogRequest =
        request.method === "GET" && url.pathname === "/api/models";
      const emptyCatalog = () =>
        json(200, { models: [], authenticated: false, defaultModel: null });
      if (!id && catalogRequest) return emptyCatalog();
      if (!id)
        throw new HttpError(
          401,
          "Reload the demo and sign in to Console first.",
        );
      if (request.method === "POST" && url.pathname === "/api/auth/start") {
        await readBody(request);
        return json(200, await auth.start(id, request.signal));
      }
      if (request.method === "POST" && url.pathname === "/api/auth/mode") {
        const body = await readBody(request);
        if (!isRecord(body) || body.mode !== "session")
          throw new HttpError(
            400,
            "This hosted demo uses your own Console sign-in.",
          );
        return json(200, await auth.getState(id, request.signal));
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/auth/organization"
      ) {
        const body = await readBody(request);
        if (
          !isRecord(body) ||
          typeof body.orgId !== "string" ||
          !body.orgId ||
          body.orgId.length > 256
        )
          throw new HttpError(400, "Choose a valid workspace.");
        return json(
          200,
          await auth.selectOrganization(id, body.orgId, request.signal),
        );
      }
      const current = await auth.getState(id, request.signal);
      if (!current.canChat && catalogRequest) return emptyCatalog();
      if (!current.canChat)
        throw new HttpError(
          401,
          "Sign in to Console and choose a workspace first.",
        );
      if (catalogRequest) {
        const available = await models(
          id,
          current.connectionRevision,
          request.signal,
        );
        return json(200, {
          models: available.map(({ id, api }) => ({ id, api })),
          authenticated: true,
          defaultModel:
            available.find((model) => model.id === defaultModel)?.id ??
            available[0]?.id ??
            null,
        });
      }
      if (request.method !== "POST" || url.pathname !== "/api/chat")
        throw new HttpError(404, "No route here.");
      const body = await readBody(request);
      validateBody(body);
      const params = await chatParamsFromRequestBody(body).catch(() => {
        throw new HttpError(
          400,
          "The request is not a valid AG-UI chat payload.",
        );
      });
      if (
        params.forwardedProps.connectionRevision !== current.connectionRevision
      )
        throw new HttpError(
          409,
          "The demo connection changed. Wait for the connection panel to update, then try again.",
        );
      const available = await models(
        id,
        current.connectionRevision,
        request.signal,
      );
      const model = available.find(
        (candidate) => candidate.id === params.forwardedProps.model,
      );
      if (!model || model.api === "systemone")
        throw new HttpError(
          400,
          "Choose a supported model from the current catalog.",
        );
      request.signal.throwIfAborted();
      controller = new AbortController();
      const runController = controller;
      const abort = () => runController.abort(request.signal.reason);
      request.signal.addEventListener("abort", abort, { once: true });
      detach = () => request.signal.removeEventListener("abort", abort);
      if (request.signal.aborted) abort();
      deadline = setTimeout(
        () => runController.abort(),
        options.runTimeoutMs ?? RUN_TIMEOUT_MS,
      );
      deadline.unref();
      const stream = chat({
        adapter: opencodeConsoleText(model.id, {
          ...config(id, current.connectionRevision),
          api: model.api,
        }),
        messages: params.messages,
        threadId: params.threadId,
        runId: params.runId,
        systemPrompts: [
          "You are a helpful assistant. When asked for the current time and the getCurrentTime tool is available, use it. Display time in UTC.",
        ],
        tools: params.forwardedProps.toolsEnabled ? [currentTime] : [],
        modelOptions: outputLimit(model.api),
        agentLoopStrategy: maxIterations(3),
        abortController: runController,
        debug: false,
      });
      const watcher = new AbortController();
      const watchSignal = AbortSignal.any([
        watcher.signal,
        runController.signal,
      ]);
      const watching = (async () => {
        try {
          while (!watchSignal.aborted) {
            await new Promise<void>((resolve, reject) => {
              const onAbort = () => {
                clearTimeout(timer);
                reject(watchSignal.reason);
              };
              const timer = setTimeout(() => {
                watchSignal.removeEventListener("abort", onAbort);
                resolve();
              }, options.watchIntervalMs ?? 3000);
              timer.unref();
              watchSignal.addEventListener("abort", onAbort, { once: true });
              if (watchSignal.aborted) onAbort();
            });
            await auth.assertRevision(
              id,
              current.connectionRevision,
              watchSignal,
            );
          }
        } catch {
          if (!watchSignal.aborted) runController.abort();
        }
      })();
      const cleanup = () => {
        if (deadline) clearTimeout(deadline);
        detach?.();
        watcher.abort();
      };
      async function* managedStream() {
        try {
          yield* safeStream(stream);
        } finally {
          cleanup();
          await watching;
        }
      }
      const response = toServerSentEventsResponse(managedStream(), {
        abortController: runController,
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
      // Cleanup must follow consumption/cancellation of the response, not handler return.
      const reader = response.body!.getReader();
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(target) {
            try {
              const part = await reader.read();
              if (part.done) {
                cleanup();
                target.close();
              } else target.enqueue(part.value);
            } catch (error) {
              cleanup();
              target.error(error);
            }
          },
          async cancel(reason) {
            runController.abort(reason);
            cleanup();
            await reader.cancel(reason);
            await watching;
          },
        }),
        { status: response.status, headers: response.headers },
      );
    } catch (error) {
      if (deadline) clearTimeout(deadline);
      detach?.();
      controller?.abort();
      if (request.signal.aborted) throw request.signal.reason;
      if (error instanceof SessionStoreError) {
        return json(503, {
          error:
            error.code === "lock_timeout"
              ? "This session is busy completing sign-in or refresh. Try again shortly."
              : "Shared session storage is temporarily unavailable. Try again shortly.",
        });
      }
      return json(error instanceof HttpError ? error.status : 500, {
        error:
          error instanceof HttpError
            ? error.message
            : "The demo server could not complete this request.",
      });
    }
  };
}

import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
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
import type { IncomingMessage, ServerResponse } from "node:http";
import { createExampleAuth } from "./auth.js";
import {
  MAX_REQUEST_BYTES,
  RUN_TIMEOUT_MS,
  currentTime,
  HttpError,
  isRecord,
  shortString,
  validateBody,
  outputLimit,
  safeStream,
} from "./chat-core.js";

const MODEL_CACHE_MS = 30_000;
const DEFAULT_ORIGINS = [
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "http://127.0.0.1:4173",
  "http://localhost:4173",
];

export interface ExampleServerOptions {
  apiKey?: string;
  baseURL?: string;
  authServer?: string;
  defaultModel?: string;
  allowedModels?: string[];
  allowedOrigins?: string[];
  fetch?: typeof globalThis.fetch;
  runTimeoutMs?: number;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (
    !request.headers["content-type"]
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    throw new HttpError(415, "Use Content-Type: application/json.");
  }
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (declaredLength > MAX_REQUEST_BYTES) {
    throw new HttpError(413, "Conversation too large. Start a new chat.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      throw new HttpError(413, "Conversation too large. Start a new chat.");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "The request body must be valid JSON.");
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

/** A local demo backend: keys and provider configuration never enter the client. */
export function createExampleServer(options: ExampleServerOptions = {}) {
  const apiKey = options.apiKey ?? process.env.OPENCODE_API_KEY;
  const baseURL = options.baseURL ?? process.env.OPENCODE_BASE_URL;
  const defaultModel = options.defaultModel ?? process.env.OPENCODE_MODEL;
  const allowedModels =
    options.allowedModels ??
    process.env.OPENCODE_ALLOWED_MODELS?.split(",")
      .map((id) => id.trim())
      .filter(Boolean);
  const allowedOrigins = new Set(options.allowedOrigins ?? DEFAULT_ORIGINS);
  const providerConfig = {
    baseURL,
    fetch: options.fetch,
    maxRetries: 1,
    timeout: 60_000,
  };
  let models: Awaited<ReturnType<typeof listOpenCodeConsoleModels>> = [];
  let modelsUpdatedAt = 0;
  let modelCacheGeneration = 0;
  let pendingModels: Promise<typeof models> | undefined;
  const activeRuns = new Set<AbortController>();
  const auth = createExampleAuth({
    apiKey,
    fetch: options.fetch,
    authServer: options.authServer,
    onChange: () => {
      for (const run of activeRuns) run.abort();
      modelCacheGeneration++;
      models = [];
      modelsUpdatedAt = 0;
      pendingModels = undefined;
    },
  });

  async function getModels() {
    if (models.length > 0 && Date.now() - modelsUpdatedAt < MODEL_CACHE_MS)
      return models;
    const generation = modelCacheGeneration;
    pendingModels ??= listOpenCodeConsoleModels({
      ...providerConfig,
      ...auth.getProviderAuth(),
    })
      .then((catalog) => {
        const available = catalog.filter(
          (model) =>
            model.supported &&
            model.api !== "systemone" &&
            (!allowedModels || allowedModels.includes(model.id)),
        );
        if (generation === modelCacheGeneration) {
          models = available;
          modelsUpdatedAt = Date.now();
        }
        return available;
      })
      .finally(() => {
        if (generation === modelCacheGeneration) pendingModels = undefined;
      });
    return pendingModels;
  }

  const server = createServer(async (request, response) => {
    const abortController = new AbortController();
    const onDisconnect = () => {
      if (!response.writableEnded) abortController.abort();
    };
    request.once("aborted", onDisconnect);
    response.once("close", onDisconnect);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const address = server.address();
      const apiPort =
        typeof address === "object" && address ? address.port : 3001;
      const trustedOrigins = new Set([
        ...allowedOrigins,
        `http://127.0.0.1:${apiPort}`,
        `http://localhost:${apiPort}`,
      ]);
      const trustedHosts = new Set(
        [...trustedOrigins].map((origin) => new URL(origin).host),
      );
      const origin = request.headers.origin;
      if (
        !trustedHosts.has(request.headers.host?.toLowerCase() ?? "") ||
        (origin !== undefined && !trustedOrigins.has(origin)) ||
        request.headers["sec-fetch-site"] === "cross-site" ||
        (request.method === "POST" && !origin)
      ) {
        throw new HttpError(
          403,
          "This local demo only accepts requests from its own browser origin.",
        );
      }
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (request.method === "GET" && pathname === "/api/auth/status") {
        json(response, 200, auth.getState());
        return;
      }
      if (request.method === "POST" && pathname.startsWith("/api/auth/")) {
        const body = await readBody(request);
        if (!isRecord(body))
          throw new HttpError(400, "Auth requests must contain a JSON object.");
        if (pathname === "/api/auth/start") {
          json(response, 202, await auth.start(abortController.signal));
          return;
        }
        if (pathname === "/api/auth/logout") {
          json(response, 200, auth.logout());
          return;
        }
        if (pathname === "/api/auth/mode") {
          if (body.mode !== "session" && body.mode !== "api-key")
            throw new HttpError(
              400,
              "Choose Console sign-in or server key mode.",
            );
          json(response, 200, auth.setMode(body.mode));
          return;
        }
        if (pathname === "/api/auth/organization") {
          if (!shortString(body.orgId))
            throw new HttpError(400, "Choose a valid Console organization.");
          try {
            json(response, 200, auth.selectOrganization(body.orgId));
          } catch {
            throw new HttpError(
              400,
              "Sign in and select one of your Console organizations.",
            );
          }
          return;
        }
        throw new HttpError(404, "No auth route here.");
      }
      if (request.method === "GET" && pathname === "/api/models") {
        let available;
        try {
          available = await getModels();
        } catch {
          throw new HttpError(
            502,
            "Could not load the OpenCode model catalog. Check OPENCODE_BASE_URL and the server connection.",
          );
        }
        const authState = auth.getState();
        const authenticated =
          authState.mode === "api-key"
            ? Boolean(apiKey)
            : authState.phase === "signed-in";
        const preferredModel =
          defaultModel ?? (authenticated ? "gpt-5-nano" : undefined);
        json(response, 200, {
          models: available.map(({ id, api }) => ({ id, api })),
          authenticated,
          defaultModel:
            available.find((model) => model.id === preferredModel)?.id ??
            available[0]?.id ??
            null,
        });
        return;
      }
      if (request.method !== "POST" || pathname !== "/api/chat") {
        throw new HttpError(404, "No route here.");
      }
      const body = await readBody(request);
      validateBody(body);
      const requestAuthRevision = (
        body.forwardedProps as Record<string, unknown>
      ).connectionRevision;
      if (requestAuthRevision !== auth.getState().connectionRevision) {
        throw new HttpError(
          409,
          "Authentication changed. Wait for the connection panel to update, then send your message again.",
        );
      }
      if (!auth.canChat())
        throw new HttpError(
          401,
          "Sign in and choose a Console organization, or select Server key, before chatting.",
        );
      let params;
      try {
        params = await chatParamsFromRequestBody(body);
      } catch {
        throw new HttpError(
          400,
          "The request is not a valid AG-UI chat payload.",
        );
      }
      let available;
      try {
        available = await getModels();
      } catch {
        if (requestAuthRevision !== auth.getState().connectionRevision) {
          throw new HttpError(
            409,
            "Authentication changed. Send your message again.",
          );
        }
        throw new HttpError(
          502,
          "Could not load the OpenCode model catalog. Try reloading the models.",
        );
      }
      if (requestAuthRevision !== auth.getState().connectionRevision) {
        throw new HttpError(
          409,
          "Authentication changed. Send your message again.",
        );
      }
      const model = available.find(
        (candidate) => candidate.id === params.forwardedProps.model,
      );
      if (!model || model.api === "systemone") {
        throw new HttpError(
          400,
          "Choose a supported model from the current catalog.",
        );
      }
      if (abortController.signal.aborted) return;
      activeRuns.add(abortController);
      deadline = setTimeout(
        () => abortController.abort(),
        options.runTimeoutMs ?? RUN_TIMEOUT_MS,
      );
      deadline.unref();
      const stream = chat({
        adapter: opencodeConsoleText(model.id, {
          ...providerConfig,
          ...auth.getProviderAuth(),
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
        abortController,
        debug: false,
      });
      const streamResponse = toServerSentEventsResponse(safeStream(stream), {
        abortController,
        headers: {
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
        },
      });
      response.writeHead(
        streamResponse.status,
        Object.fromEntries(streamResponse.headers),
      );
      if (streamResponse.body) {
        await pipeline(Readable.from(streamResponse.body), response, {
          signal: abortController.signal,
        });
      } else {
        response.end();
      }
    } catch (error) {
      if (!response.headersSent && !response.destroyed) {
        const status = error instanceof HttpError ? error.status : 500;
        const message =
          error instanceof HttpError
            ? error.message
            : "The example server could not complete this request.";
        json(response, status, { error: message });
      }
    } finally {
      if (deadline) clearTimeout(deadline);
      activeRuns.delete(abortController);
      request.off("aborted", onDisconnect);
      response.off("close", onDisconnect);
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;

  return {
    server,
    async close() {
      auth.close();
      for (const controller of activeRuns) controller.abort();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const app = createExampleServer();
  app.server.listen(3001, "127.0.0.1", () => {
    console.log("OpenCode example API listening at http://127.0.0.1:3001");
  });
  const shutdown = () => {
    void app.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

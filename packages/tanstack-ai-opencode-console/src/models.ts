import {
  normalizeBaseURL,
  resolveOpenCodeConsoleApi,
  validateModelId,
} from "./routing.js";
import { createConsoleFetch, validateTransportConfig } from "./transport.js";
import type { OpenCodeConsoleConfig, OpenCodeConsoleModel } from "./types.js";
import type { Modality } from "@tanstack/ai";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parse availability, without manufacturing prices, token limits, or capabilities. */
export function parseOpenCodeConsoleModels(
  payload: unknown,
): OpenCodeConsoleModel[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error(
      "OpenCode returned an invalid model catalog: expected a data array.",
    );
  }
  const models = new Map<string, OpenCodeConsoleModel>();
  for (const row of payload.data) {
    const id =
      typeof row === "string" ? row : isRecord(row) ? row.id : undefined;
    if (typeof id !== "string") continue;
    try {
      validateModelId(id);
    } catch {
      continue;
    }
    const api = resolveOpenCodeConsoleApi(id);
    models.set(id, {
      id,
      api,
      supported: api !== "systemone",
      ...(isRecord(row) &&
      typeof row.created === "number" &&
      Number.isFinite(row.created)
        ? { created: row.created }
        : {}),
      ...(isRecord(row) && typeof row.owned_by === "string"
        ? { ownedBy: row.owned_by }
        : {}),
    });
  }
  return [...models.values()];
}

export async function listOpenCodeConsoleModels(
  config: OpenCodeConsoleConfig<ReadonlyArray<Modality>> = {},
  options: { signal?: AbortSignal } = {},
): Promise<OpenCodeConsoleModel[]> {
  validateTransportConfig(config);
  const fetcher = createConsoleFetch(config);
  const response = await fetcher(
    `${normalizeBaseURL(config.baseURL)}/v1/models`,
    {
      headers: { Accept: "application/json" },
      signal: options.signal,
    },
  );
  if (!response.ok) {
    throw new Error(
      `OpenCode model discovery failed (HTTP ${response.status}).`,
    );
  }
  return parseOpenCodeConsoleModels(await response.json());
}

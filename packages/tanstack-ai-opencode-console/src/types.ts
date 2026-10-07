import type { Modality } from "@tanstack/ai";

export type OpenCodeConsoleApi =
  "chat-completions" | "responses" | "messages" | "gemini";

/** A service account key, resolved again before each request. */
export type OpenCodeConsoleApiKey =
  string | (() => string | undefined | Promise<string | undefined>);

/** User session tokens require an explicitly selected Console organization. */
export interface OpenCodeConsoleSessionCredential {
  accessToken: string;
  orgId: string;
}

export type OpenCodeConsoleSessionSupplier = (
  signal: AbortSignal,
) =>
  OpenCodeConsoleSessionCredential | Promise<OpenCodeConsoleSessionCredential>;

export interface OpenCodeConsoleConfig<
  TInputModalities extends ReadonlyArray<Modality> = readonly ["text"],
> {
  /** Falls back to OPENCODE_API_KEY. Set "" explicitly for unauthenticated calls. */
  apiKey?: OpenCodeConsoleApiKey;
  /** User session auth. Overrides the environment key; cannot be combined with apiKey. */
  session?: OpenCodeConsoleSessionCredential | OpenCodeConsoleSessionSupplier;
  /** Inference root; defaults to https://opencode.ai/inference. */
  baseURL?: string;
  /** Explicit routing override for new models or custom gateways. */
  api?: OpenCodeConsoleApi;
  fetch?: typeof globalThis.fetch;
  defaultHeaders?: HeadersInit;
  /** Per-request timeout in milliseconds. Default: 600000. */
  timeout?: number;
  /** SDK retries before a successful response. Default: 0. */
  maxRetries?: number;
  /** Declare only modalities you have verified for this model. Default: text. */
  inputModalities?: TInputModalities;
}

/**
 * Protocol-specific values passed to chat({ modelOptions }). The gateway and
 * delegated protocol adapter validate supported options; model availability
 * does not imply support for a particular reasoning or structured-output mode.
 */
export type OpenCodeConsoleProviderOptions = Record<string, unknown>;

export interface OpenCodeConsoleModel {
  id: string;
  api: OpenCodeConsoleApi | "systemone";
  /** System One decision models are excluded from the text adapter. */
  supported: boolean;
  created?: number;
  ownedBy?: string;
}

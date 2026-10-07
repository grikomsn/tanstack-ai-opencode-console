import { BaseTextAdapter } from "@tanstack/ai/adapters";
import { openaiCompatibleText } from "@tanstack/ai-openai/compatible";
import { AnthropicTextAdapter } from "@tanstack/ai-anthropic";
import { GeminiTextAdapter } from "@tanstack/ai-gemini";
import type {
  AdapterYieldChunk,
  DefaultMessageMetadataByModality,
  Modality,
  TextOptions,
} from "@tanstack/ai";
import type {
  AnyTextAdapter,
  StructuredOutputOptions,
  StructuredOutputResult,
} from "@tanstack/ai/adapters";
import {
  normalizeBaseURL,
  protocolBaseURL,
  resolveOpenCodeConsoleApi,
  validateModelId,
} from "./routing.js";
import {
  createConsoleFetch,
  safeHeaders,
  SDK_PLACEHOLDER_KEY,
  validateTransportConfig,
} from "./transport.js";
import { listOpenCodeConsoleModels } from "./models.js";
import type {
  OpenCodeConsoleApi,
  OpenCodeConsoleConfig,
  OpenCodeConsoleProviderOptions,
} from "./types.js";

/**
 * Mirrors the pinned OpenAI o-series/codex predicate and includes gateway GPT-6:
 * docs/verification/go-2026-10-07.json records gpt-6-luna reasoning tokens.
 */
function isOpenAIReasoningModel(model: string): boolean {
  const id = model.toLowerCase();
  return (
    /^o\d/.test(id) ||
    (/^gpt-[56](?:[.-]|$)/.test(id) && !id.endsWith("-chat-latest")) ||
    id === "codex-mini-latest"
  );
}

/** A text adapter over the v2 inference service; it never starts an OpenCode process. */
export class OpenCodeConsoleTextAdapter<
  TModel extends string = string,
  TInputModalities extends ReadonlyArray<Modality> = readonly ["text"],
  TProviderOptions extends OpenCodeConsoleProviderOptions =
    OpenCodeConsoleProviderOptions,
> extends BaseTextAdapter<
  TModel,
  TProviderOptions,
  TInputModalities,
  DefaultMessageMetadataByModality,
  readonly []
> {
  readonly name = "opencode-console";
  readonly api: OpenCodeConsoleApi;
  private readonly delegate: AnyTextAdapter;
  readonly structuredOutputStream?: (
    options: StructuredOutputOptions<TProviderOptions>,
  ) => AsyncIterable<AdapterYieldChunk>;

  constructor(
    model: TModel,
    config: OpenCodeConsoleConfig<TInputModalities> = {},
  ) {
    super({}, validateModelId(model) as TModel);
    validateTransportConfig(config);
    const api = config.api ?? resolveOpenCodeConsoleApi(model);
    if (api === "systemone") {
      throw new Error(
        "Jev uses the System One decision API and cannot be used as a text adapter.",
      );
    }
    this.api = api;
    const baseURL = protocolBaseURL(normalizeBaseURL(config.baseURL), api);
    const fetcher = createConsoleFetch(config);
    const sdkConfig = {
      apiKey: SDK_PLACEHOLDER_KEY,
      baseURL,
      fetch: fetcher,
      timeout: config.timeout ?? 600_000,
      maxRetries: config.maxRetries ?? 0,
    };
    switch (api) {
      case "chat-completions":
      case "responses":
        this.delegate = openaiCompatibleText(model, {
          ...sdkConfig,
          name: this.name,
          api,
        });
        break;
      case "messages":
        // TanStack's static upstream model union does not include gateway aliases
        // (e.g. Qwen). The Messages adapter accepts the validated ID at runtime.
        this.delegate = new AnthropicTextAdapter(
          sdkConfig,
          model as ConstructorParameters<typeof AnthropicTextAdapter>[1],
        );
        break;
      case "gemini":
        this.delegate = new GeminiTextAdapter(
          {
            apiKey: SDK_PLACEHOLDER_KEY,
            baseURL,
            httpOptions: {
              apiVersion: "v1beta",
              fetch: fetcher,
              timeout: config.timeout ?? 600_000,
              retryOptions: { attempts: (config.maxRetries ?? 0) + 1 },
            },
          },
          model as ConstructorParameters<typeof GeminiTextAdapter>[1],
        );
        break;
    }
    if (this.delegate.structuredOutputStream) {
      this.structuredOutputStream = (options) =>
        this.delegate.structuredOutputStream!({
          ...options,
          chatOptions: this.prepareOptions(options.chatOptions),
        });
    }
  }

  private prepareOptions(
    options: TextOptions<TProviderOptions>,
  ): TextOptions<TProviderOptions> {
    const httpOptions = options.modelOptions?.httpOptions;
    if (
      this.api === "gemini" &&
      httpOptions !== null &&
      typeof httpOptions === "object" &&
      "headers" in httpOptions
    ) {
      // The SDK constructs headers before reaching our fetch wrapper. Validate
      // here so native constructor errors cannot echo rejected credentials.
      safeHeaders(httpOptions.headers as HeadersInit | undefined);
    }
    let include = options.modelOptions?.include;
    if (this.api === "responses" && isOpenAIReasoningModel(this.model)) {
      // Stateless tool continuations need the preceding reasoning item's
      // encrypted content. Keep caller includes and leave invalid values for
      // the delegated API to reject instead of silently replacing them.
      if (include === undefined) include = ["reasoning.encrypted_content"];
      else if (
        Array.isArray(include) &&
        include.every((item) => typeof item === "string") &&
        !include.includes("reasoning.encrypted_content")
      ) {
        include = [...include, "reasoning.encrypted_content"];
      }
    }
    return {
      ...options,
      model: this.model,
      // Stateless Responses requests, with an explicit per-call opt-in allowed.
      modelOptions: (this.api === "responses"
        ? {
            ...options.modelOptions,
            store: options.modelOptions?.store ?? false,
            ...(include !== undefined ? { include } : {}),
          }
        : this.api === "messages"
          ? {
              ...options.modelOptions,
              max_tokens: options.modelOptions?.max_tokens ?? 4096,
            }
          : options.modelOptions) as TProviderOptions,
    };
  }

  chatStream(
    options: TextOptions<TProviderOptions>,
  ): AsyncIterable<AdapterYieldChunk> {
    return this.delegate.chatStream(this.prepareOptions(options));
  }

  structuredOutput(
    options: StructuredOutputOptions<TProviderOptions>,
  ): Promise<StructuredOutputResult<unknown>> {
    return this.delegate.structuredOutput({
      ...options,
      chatOptions: this.prepareOptions(options.chatOptions),
    });
  }

  supportsCombinedToolsAndSchema(options?: TProviderOptions): boolean {
    return this.delegate.supportsCombinedToolsAndSchema?.(options) ?? false;
  }
}

export function opencodeConsoleText<
  const TModel extends string,
  const TInputModalities extends ReadonlyArray<Modality> = readonly ["text"],
>(
  model: TModel,
  config: OpenCodeConsoleConfig<TInputModalities> = {},
): OpenCodeConsoleTextAdapter<TModel, TInputModalities> {
  return new OpenCodeConsoleTextAdapter(model, config);
}

/** Configure transport once, select models per call, and discover the live catalog. */
export function createOpenCodeConsole<
  const TInputModalities extends ReadonlyArray<Modality> = readonly ["text"],
>(config: OpenCodeConsoleConfig<TInputModalities> = {}) {
  const provider = <
    const TModel extends string,
    const TOverrideModalities extends ReadonlyArray<Modality> =
      TInputModalities,
  >(
    model: TModel,
    overrides: OpenCodeConsoleConfig<TOverrideModalities> = {},
  ) =>
    opencodeConsoleText(model, {
      ...config,
      ...overrides,
    } as OpenCodeConsoleConfig<TOverrideModalities>);
  return Object.assign(provider, {
    listModels: (options: { signal?: AbortSignal } = {}) =>
      listOpenCodeConsoleModels(config, options),
  });
}

import { toolDefinition } from "@tanstack/ai";
import type { RunErrorEvent, StreamChunk } from "@tanstack/ai";
import type { OpenCodeConsoleApi } from "tanstack-ai-opencode-console";

export const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_MESSAGES = 40;
const MAX_CONTENT_LENGTH = 32_000;
export const RUN_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_TOKENS = 2048;
export const currentTime = toolDefinition({
  name: "getCurrentTime",
  description:
    "Get the current UTC date and time. This tool has no side effects.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      iso: { type: "string" },
      timeZone: { type: "string" },
    },
    required: ["iso", "timeZone"],
    additionalProperties: false,
  },
}).server(() => ({ iso: new Date().toISOString(), timeZone: "UTC" }));

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function shortString(value: unknown, maxLength = 200): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength
  );
}

/** Bound history and allow only the text/tool shapes this example displays. */
export function validateBody(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    throw new HttpError(
      400,
      "Send an AG-UI chat request with a messages array.",
    );
  }
  if (value.messages.length < 1 || value.messages.length > MAX_MESSAGES) {
    throw new HttpError(
      400,
      `A conversation must contain 1–${MAX_MESSAGES} messages. Start a new chat.`,
    );
  }
  if (!shortString(value.threadId) || !shortString(value.runId)) {
    throw new HttpError(400, "The request needs valid thread and run IDs.");
  }
  if (
    !Array.isArray(value.tools) ||
    value.tools.length !== 0 ||
    !Array.isArray(value.context) ||
    value.context.length !== 0
  ) {
    throw new HttpError(400, "This example accepts server-defined tools only.");
  }
  if (
    !isRecord(value.forwardedProps) ||
    !shortString(value.forwardedProps.model) ||
    !shortString(value.forwardedProps.connectionRevision) ||
    typeof value.forwardedProps.toolsEnabled !== "boolean"
  ) {
    throw new HttpError(
      400,
      "Choose a model and a tools setting with the current connection context.",
    );
  }
  for (const message of value.messages) {
    if (!isRecord(message) || !shortString(message.id)) {
      throw new HttpError(400, "Every message needs a valid ID.");
    }
    if (
      !["user", "assistant", "tool", "reasoning"].includes(String(message.role))
    ) {
      throw new HttpError(
        400,
        "This example accepts user, assistant, reasoning, and tool messages.",
      );
    }
    if (
      message.content !== undefined &&
      (typeof message.content !== "string" ||
        message.content.length > MAX_CONTENT_LENGTH)
    ) {
      throw new HttpError(
        400,
        "Messages must be text and no longer than 32,000 characters.",
      );
    }
    if (
      message.role === "user" &&
      (typeof message.content !== "string" || !message.content.trim())
    ) {
      throw new HttpError(400, "A user message must contain text.");
    }
    if (message.role === "tool" && !shortString(message.toolCallId)) {
      throw new HttpError(400, "Tool results need a valid call ID.");
    }
    if (message.toolCalls !== undefined) {
      if (
        message.role !== "assistant" ||
        !Array.isArray(message.toolCalls) ||
        message.toolCalls.length > 8
      ) {
        throw new HttpError(
          400,
          "Too many or invalid tool calls in the history.",
        );
      }
      for (const call of message.toolCalls) {
        if (
          !isRecord(call) ||
          !shortString(call.id) ||
          call.type !== "function" ||
          !isRecord(call.function) ||
          call.function.name !== "getCurrentTime" ||
          typeof call.function.arguments !== "string" ||
          call.function.arguments.length > 512
        ) {
          throw new HttpError(
            400,
            "Only getCurrentTime tool calls are supported in this example.",
          );
        }
      }
    }
  }
  if (
    !value.messages.some(
      (message: unknown) => isRecord(message) && message.role === "user",
    )
  ) {
    throw new HttpError(
      400,
      "Include a user message to start the conversation.",
    );
  }
}

function publicError(message: string): string {
  if (/free tier|within OpenCode/i.test(message)) {
    return "OpenCode restricted this model to its own app. Choose an available paid model using Console sign-in or a server service key.";
  }
  if (/401|unauthorized|authentication|api.?key/i.test(message)) {
    return "OpenCode rejected this authentication. Sign in to Console again or update the server API key.";
  }
  if (/429|rate.?limit/i.test(message)) {
    return "OpenCode rate limit reached. Try again in a moment.";
  }
  if (/balance|credits|payment|quota/i.test(message)) {
    return "OpenCode needs account credits for this request.";
  }
  return "OpenCode could not complete this request. Check the server configuration and try again.";
}

export function outputLimit(api: OpenCodeConsoleApi): Record<string, number> {
  switch (api) {
    case "chat-completions":
    case "messages":
      return { max_tokens: MAX_OUTPUT_TOKENS };
    case "responses":
      return { max_output_tokens: MAX_OUTPUT_TOKENS };
    case "gemini":
      return { maxOutputTokens: MAX_OUTPUT_TOKENS };
  }
}

/** Avoid forwarding raw upstream error bodies or credentials to the browser. */
export async function* safeStream(
  stream: AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  try {
    for await (const chunk of stream) {
      if (chunk.type === "RUN_ERROR") {
        yield {
          type: chunk.type,
          message: publicError(chunk.message),
          threadId: chunk.threadId,
          runId: chunk.runId,
        };
      } else {
        yield chunk;
      }
    }
  } catch (error) {
    yield {
      type: "RUN_ERROR" as RunErrorEvent["type"],
      message: publicError(error instanceof Error ? error.message : ""),
    };
  }
}

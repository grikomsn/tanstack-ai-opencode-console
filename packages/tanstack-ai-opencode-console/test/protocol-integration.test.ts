import assert from "node:assert/strict";
import test from "node:test";
import { chat, toolDefinition } from "@tanstack/ai";
import type { JSONSchema, TextOptions } from "@tanstack/ai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { createOpenCodeConsole, opencodeConsoleText } from "../src/index.js";
import type {
  OpenCodeConsoleApi,
  OpenCodeConsoleProviderOptions,
} from "../src/index.js";

type JsonObject = Record<string, unknown>;
type Frame = { event?: string; data: unknown };
type Call = {
  url: URL;
  headers: Headers;
  body: JsonObject;
  signal: AbortSignal | null | undefined;
};

const families = [
  {
    api: "chat-completions",
    model: "big-pickle",
    path: "/inference/openai/v1/chat/completions",
  },
  {
    api: "responses",
    model: "gpt-5.5",
    path: "/inference/openai/v1/responses",
  },
  {
    api: "messages",
    model: "qwen3.6-plus",
    path: "/inference/anthropic/v1/messages",
  },
  {
    api: "gemini",
    model: "gemini-3.1-pro",
    path: "/inference/google/v1beta/models/gemini-3.1-pro:streamGenerateContent",
  },
] as const;

const usage = { input: 10, output: 3, total: 13, cached: 2 };
const schema: JSONSchema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};
const logger = resolveDebugOption(false);

function read(value: unknown, ...path: (string | number)[]): unknown {
  return path.reduce<unknown>((current, key) => {
    if (current === null || typeof current !== "object") return undefined;
    return (current as Record<string | number, unknown>)[key];
  }, value);
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const chunks: T[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return chunks;
}

function sse(frames: Frame[], done = false): Response {
  const body =
    frames
      .map(
        ({ event, data }) =>
          `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`,
      )
      .join("") + (done ? "data: [DONE]\n\n" : "");
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

function recorder(responses: (() => Response)[]): {
  calls: Call[];
  fetch: typeof fetch;
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const text = await request.text();
      calls.push({
        url: new URL(request.url),
        headers: request.headers,
        body: text ? (JSON.parse(text) as JsonObject) : {},
        signal: init?.signal,
      });
      const response = responses[calls.length - 1];
      assert.ok(response, `Unexpected request number ${calls.length}`);
      return response();
    },
  };
}

function chatUsage() {
  return {
    prompt_tokens: usage.input,
    completion_tokens: usage.output,
    total_tokens: usage.total,
    prompt_tokens_details: { cached_tokens: usage.cached },
    completion_tokens_details: { reasoning_tokens: 1 },
  };
}

function responsesUsage() {
  return {
    input_tokens: usage.input,
    output_tokens: usage.output,
    total_tokens: usage.total,
    input_tokens_details: { cached_tokens: usage.cached },
    output_tokens_details: { reasoning_tokens: 1 },
  };
}

function messagesUsage() {
  return {
    input_tokens: usage.input,
    output_tokens: usage.output,
    cache_read_input_tokens: usage.cached,
    cache_creation_input_tokens: 1,
  };
}

function geminiUsage() {
  return {
    promptTokenCount: usage.input,
    candidatesTokenCount: usage.output,
    totalTokenCount: usage.total,
    cachedContentTokenCount: usage.cached,
    thoughtsTokenCount: 1,
  };
}

function textResponse(
  api: OpenCodeConsoleApi,
  model: string,
  answer = "Hello",
  reasoning = true,
): Response {
  switch (api) {
    case "chat-completions": {
      const chunk = (
        delta: JsonObject,
        finish_reason: string | null = null,
      ) => ({
        id: "chat-1",
        object: "chat.completion.chunk",
        created: 1,
        model,
        choices: [{ index: 0, delta, finish_reason }],
      });
      return sse(
        [
          {
            data: chunk({
              role: "assistant",
              ...(reasoning ? { reasoning_content: "Think carefully" } : {}),
            }),
          },
          { data: chunk({ content: answer.slice(0, 2) }) },
          { data: chunk({ content: answer.slice(2) }) },
          { data: chunk({}, "stop") },
          {
            data: {
              id: "chat-1",
              object: "chat.completion.chunk",
              created: 1,
              model,
              choices: [],
              usage: chatUsage(),
            },
          },
        ],
        true,
      );
    }
    case "responses": {
      const response = {
        id: "response-1",
        object: "response",
        model,
        status: "completed",
        output: [
          {
            type: "message",
            id: "msg-1",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: answer, annotations: [] }],
          },
        ],
        usage: responsesUsage(),
      };
      return sse([
        {
          event: "response.created",
          data: {
            type: "response.created",
            response: { ...response, status: "in_progress", output: [] },
          },
        },
        ...(reasoning
          ? [
              {
                event: "response.reasoning_summary_text.delta",
                data: {
                  type: "response.reasoning_summary_text.delta",
                  item_id: "reason-1",
                  output_index: 0,
                  summary_index: 0,
                  delta: "Think carefully",
                },
              },
            ]
          : []),
        {
          event: "response.output_text.delta",
          data: {
            type: "response.output_text.delta",
            item_id: "msg-1",
            output_index: 0,
            content_index: 0,
            delta: answer.slice(0, 2),
          },
        },
        {
          event: "response.output_text.delta",
          data: {
            type: "response.output_text.delta",
            item_id: "msg-1",
            output_index: 0,
            content_index: 0,
            delta: answer.slice(2),
          },
        },
        {
          event: "response.completed",
          data: { type: "response.completed", response },
        },
      ]);
    }
    case "messages": {
      const frames: Frame[] = [
        {
          event: "message_start",
          data: {
            type: "message_start",
            message: {
              id: "msg-1",
              type: "message",
              role: "assistant",
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: messagesUsage(),
            },
          },
        },
      ];
      if (reasoning)
        frames.push(
          {
            event: "content_block_start",
            data: {
              type: "content_block_start",
              index: 0,
              content_block: { type: "thinking", thinking: "", signature: "" },
            },
          },
          {
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "thinking_delta", thinking: "Think carefully" },
            },
          },
          {
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "signature_delta", signature: "signed-thinking" },
            },
          },
          {
            event: "content_block_stop",
            data: { type: "content_block_stop", index: 0 },
          },
        );
      const index = reasoning ? 1 : 0;
      frames.push(
        {
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index,
            content_block: { type: "text", text: "" },
          },
        },
        {
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: answer.slice(0, 2) },
          },
        },
        {
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: answer.slice(2) },
          },
        },
        {
          event: "content_block_stop",
          data: { type: "content_block_stop", index },
        },
        {
          event: "message_delta",
          data: {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: messagesUsage(),
          },
        },
        { event: "message_stop", data: { type: "message_stop" } },
      );
      return sse(frames);
    }
    case "gemini":
      return sse([
        ...(reasoning
          ? [
              {
                data: {
                  candidates: [
                    {
                      index: 0,
                      content: {
                        role: "model",
                        parts: [{ text: "Think carefully", thought: true }],
                      },
                    },
                  ],
                },
              },
            ]
          : []),
        {
          data: {
            candidates: [
              {
                index: 0,
                content: {
                  role: "model",
                  parts: [{ text: answer.slice(0, 2) }],
                },
              },
            ],
          },
        },
        {
          data: {
            candidates: [
              {
                index: 0,
                content: { role: "model", parts: [{ text: answer.slice(2) }] },
                finishReason: "STOP",
              },
            ],
            usageMetadata: geminiUsage(),
          },
        },
      ]);
  }
}

function toolResponse(api: OpenCodeConsoleApi, model: string): Response {
  switch (api) {
    case "chat-completions": {
      const chunk = (
        delta: JsonObject,
        finish_reason: string | null = null,
      ) => ({
        id: "chat-tool",
        object: "chat.completion.chunk",
        created: 1,
        model,
        choices: [{ index: 0, delta, finish_reason }],
      });
      return sse(
        [
          {
            data: chunk({
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  type: "function",
                  function: { name: "lookup", arguments: '{"city":' },
                },
              ],
            }),
          },
          {
            data: chunk({
              tool_calls: [{ index: 0, function: { arguments: '"Jakarta"}' } }],
            }),
          },
          { data: { ...chunk({}, "tool_calls"), usage: chatUsage() } },
        ],
        true,
      );
    }
    case "responses": {
      const call = {
        type: "function_call",
        id: "item-call",
        call_id: "call-1",
        name: "lookup",
        arguments: '{"city":"Jakarta"}',
        status: "completed",
      };
      return sse([
        {
          event: "response.created",
          data: {
            type: "response.created",
            response: {
              id: "response-tool",
              model,
              output: [],
              status: "in_progress",
            },
          },
        },
        {
          event: "response.output_item.added",
          data: {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...call, arguments: "", status: "in_progress" },
          },
        },
        {
          event: "response.function_call_arguments.delta",
          data: {
            type: "response.function_call_arguments.delta",
            item_id: "item-call",
            output_index: 0,
            delta: '{"city":',
          },
        },
        {
          event: "response.function_call_arguments.delta",
          data: {
            type: "response.function_call_arguments.delta",
            item_id: "item-call",
            output_index: 0,
            delta: '"Jakarta"}',
          },
        },
        {
          event: "response.function_call_arguments.done",
          data: {
            type: "response.function_call_arguments.done",
            item_id: "item-call",
            output_index: 0,
            arguments: call.arguments,
            name: call.name,
          },
        },
        {
          event: "response.output_item.done",
          data: {
            type: "response.output_item.done",
            output_index: 0,
            item: call,
          },
        },
        {
          event: "response.completed",
          data: {
            type: "response.completed",
            response: {
              id: "response-tool",
              model,
              output: [call],
              status: "completed",
              usage: responsesUsage(),
            },
          },
        },
      ]);
    }
    case "messages":
      return sse([
        {
          event: "message_start",
          data: {
            type: "message_start",
            message: {
              id: "msg-tool",
              type: "message",
              role: "assistant",
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: messagesUsage(),
            },
          },
        },
        {
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "call-1",
              name: "lookup",
              input: {},
            },
          },
        },
        {
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"city":' },
          },
        },
        {
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '"Jakarta"}' },
          },
        },
        {
          event: "content_block_stop",
          data: { type: "content_block_stop", index: 0 },
        },
        {
          event: "message_delta",
          data: {
            type: "message_delta",
            delta: { stop_reason: "tool_use", stop_sequence: null },
            usage: messagesUsage(),
          },
        },
        { event: "message_stop", data: { type: "message_stop" } },
      ]);
    case "gemini":
      return sse([
        {
          data: {
            candidates: [
              {
                index: 0,
                content: {
                  role: "model",
                  parts: [
                    {
                      functionCall: {
                        id: "call-1",
                        name: "lookup",
                        args: { city: "Jakarta" },
                      },
                      thoughtSignature: "signed-tool-call",
                    },
                  ],
                },
                finishReason: "STOP",
              },
            ],
            usageMetadata: geminiUsage(),
          },
        },
      ]);
  }
}

function structuredResponse(api: OpenCodeConsoleApi, model: string): Response {
  const answer = '{"answer":"yes"}';
  switch (api) {
    case "chat-completions":
      return Response.json({
        id: "structured",
        object: "chat.completion",
        created: 1,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: answer },
            finish_reason: "stop",
          },
        ],
        usage: chatUsage(),
      });
    case "responses":
      return Response.json({
        id: "structured",
        object: "response",
        model,
        status: "completed",
        output: [
          {
            type: "message",
            id: "msg-1",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: answer, annotations: [] }],
          },
        ],
        usage: responsesUsage(),
      });
    case "messages":
      return Response.json({
        id: "structured",
        type: "message",
        model,
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call-structured",
            name: "structured_output",
            input: { answer: "yes" },
          },
        ],
        stop_reason: "tool_use",
        usage: messagesUsage(),
      });
    case "gemini":
      return Response.json({
        candidates: [
          {
            index: 0,
            content: { role: "model", parts: [{ text: answer }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: geminiUsage(),
      });
  }
}

function options(
  model: string,
  modelOptions?: OpenCodeConsoleProviderOptions,
): TextOptions<OpenCodeConsoleProviderOptions> {
  return {
    model,
    messages: [{ role: "user", content: "Hello" }],
    logger,
    modelOptions,
  };
}

for (const family of families) {
  test(`${family.api}: user sessions preserve workspace auth through the native SDK`, async () => {
    const network = recorder([
      () => textResponse(family.api, family.model, "OK", false),
    ]);
    const events = await collect(
      chat({
        adapter: opencodeConsoleText(family.model, {
          session: { accessToken: "user-session", orgId: "selected-workspace" },
          defaultHeaders: {
            Authorization: "Bearer stale-key",
            "x-org-id": "wrong-workspace",
            "x-api-key": "native-key",
          },
          fetch: network.fetch,
        }),
        messages: [{ role: "user", content: "Hello" }],
      }),
    );
    assert.ok(events.some((event) => event.type === "RUN_FINISHED"));
    assert.equal(network.calls.length, 1);
    const call = network.calls[0]!;
    assert.equal(call.url.pathname, family.path);
    assert.equal(call.headers.get("authorization"), "Bearer user-session");
    assert.equal(call.headers.get("x-org-id"), "selected-workspace");
    assert.equal(call.headers.get("x-opencode-org-id"), "selected-workspace");
    assert.equal(call.headers.get("x-api-key"), null);
    assert.equal(call.headers.get("x-goog-api-key"), null);
    assert.equal(
      call.headers.get("x-opencode-client"),
      "tanstack-ai-opencode-console",
    );
  });

  test(`${family.api}: TanStack chat streams text, reasoning, lifecycle, and usage`, async () => {
    const network = recorder([() => textResponse(family.api, family.model)]);
    const adapter = opencodeConsoleText(family.model, {
      apiKey: "console-service-key",
      fetch: network.fetch,
      defaultHeaders: { "X-Workspace": "demo" },
    });
    assert.equal(adapter.name, "opencode-console");
    assert.equal(adapter.model, family.model);
    assert.equal(adapter.api, family.api);
    const chunks = await collect(
      chat({
        adapter,
        messages: [{ role: "user", content: "Hello" }],
        systemPrompts: ["Be concise"],
        debug: false,
      }),
    );
    assert.deepEqual(
      chunks.filter((chunk) => chunk.type === "RUN_ERROR"),
      [],
    );
    assert.equal(
      chunks
        .filter((chunk) => chunk.type === "TEXT_MESSAGE_CONTENT")
        .map((chunk) => chunk.delta)
        .join(""),
      "Hello",
    );
    assert.equal(
      chunks
        .filter((chunk) => chunk.type === "REASONING_MESSAGE_CONTENT")
        .map((chunk) => chunk.delta)
        .join(""),
      "Think carefully",
    );
    assert.equal(
      chunks.filter((chunk) => chunk.type === "RUN_STARTED").length,
      1,
    );
    assert.equal(
      chunks.filter((chunk) => chunk.type === "TEXT_MESSAGE_START").length,
      1,
    );
    assert.equal(
      chunks.filter((chunk) => chunk.type === "TEXT_MESSAGE_END").length,
      1,
    );
    assert.equal(
      chunks.filter((chunk) => chunk.type === "REASONING_MESSAGE_START").length,
      1,
    );
    assert.equal(
      chunks.filter((chunk) => chunk.type === "REASONING_MESSAGE_END").length,
      1,
    );
    const finished = chunks.find((chunk) => chunk.type === "RUN_FINISHED");
    assert.ok(finished);
    assert.equal(read(finished, "usage", "promptTokens"), usage.input);
    assert.equal(read(finished, "usage", "completionTokens"), usage.output);
    assert.equal(read(finished, "usage", "totalTokens"), usage.total);
    assert.equal(
      read(finished, "usage", "promptTokensDetails", "cachedTokens"),
      usage.cached,
    );
    assert.equal(network.calls.length, 1);
    const call = network.calls[0]!;
    assert.equal(call.url.origin, "https://opencode.ai");
    assert.equal(call.url.pathname, family.path);
    assert.equal(
      call.headers.get("authorization"),
      "Bearer console-service-key",
    );
    assert.equal(call.headers.get("x-api-key"), null);
    assert.equal(call.headers.get("x-goog-api-key"), null);
    assert.equal(call.headers.get("x-workspace"), "demo");
    assert.ok(call.signal);
    if (family.api === "responses") {
      assert.equal(call.body.store, false);
      assert.equal(call.body.instructions, "Be concise");
      assert.equal("previous_response_id" in call.body, false);
    } else if (family.api === "messages") {
      assert.equal(call.body.max_tokens, 4096);
      assert.equal(read(call.body, "system", 0, "text"), "Be concise");
    } else if (family.api === "gemini") {
      assert.equal(call.url.searchParams.get("alt"), "sse");
      assert.equal(
        read(call.body, "systemInstruction", "parts", 0, "text"),
        "Be concise",
      );
    } else {
      assert.equal(read(call.body, "messages", 0, "role"), "system");
      assert.equal(read(call.body, "stream_options", "include_usage"), true);
    }
  });

  test(`${family.api}: server tool execution and result replay survive the TanStack agent loop`, async () => {
    const network = recorder([
      () => toolResponse(family.api, family.model),
      () => textResponse(family.api, family.model, "Sunny", false),
    ]);
    const inputs: unknown[] = [];
    const lookup = toolDefinition({
      name: "lookup",
      description: "Read a forecast",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
        additionalProperties: false,
      },
    }).server(async (input) => {
      inputs.push(input);
      return { forecast: "sunny" };
    });
    const chunks = await collect(
      chat({
        adapter: opencodeConsoleText(family.model, {
          apiKey: "",
          fetch: network.fetch,
        }),
        messages: [{ role: "user", content: "Forecast?" }],
        tools: [lookup],
        debug: false,
      }),
    );
    assert.deepEqual(
      chunks.filter((chunk) => chunk.type === "RUN_ERROR"),
      [],
    );
    assert.deepEqual(inputs, [{ city: "Jakarta" }]);
    assert.equal(
      chunks
        .filter((chunk) => chunk.type === "TEXT_MESSAGE_CONTENT")
        .map((chunk) => chunk.delta)
        .join(""),
      "Sunny",
    );
    const start = chunks.find((chunk) => chunk.type === "TOOL_CALL_START");
    assert.equal(read(start, "toolCallId"), "call-1");
    assert.equal(read(start, "toolCallName"), "lookup");
    assert.equal(
      chunks.filter((chunk) => chunk.type === "TOOL_CALL_END").length,
      1,
    );
    assert.equal(
      chunks.filter((chunk) => chunk.type === "TOOL_CALL_RESULT").length,
      1,
    );
    assert.equal(network.calls.length, 2);
    for (const call of network.calls) {
      assert.equal(call.headers.get("authorization"), null);
      assert.equal(call.headers.get("x-api-key"), null);
      assert.equal(call.headers.get("x-goog-api-key"), null);
    }
    const second = network.calls[1]!.body;
    if (family.api === "chat-completions") {
      const messages = second.messages as JsonObject[];
      assert.equal(
        read(
          messages.find((message) => message.role === "assistant"),
          "tool_calls",
          0,
          "id",
        ),
        "call-1",
      );
      assert.equal(
        read(
          messages.find((message) => message.role === "tool"),
          "tool_call_id",
        ),
        "call-1",
      );
      assert.equal(
        read(
          messages.find((message) => message.role === "tool"),
          "content",
        ),
        '{"forecast":"sunny"}',
      );
    } else if (family.api === "responses") {
      const input = second.input as JsonObject[];
      assert.equal(
        read(
          input.find((item) => item.type === "function_call"),
          "call_id",
        ),
        "call-1",
      );
      assert.equal(
        read(
          input.find((item) => item.type === "function_call_output"),
          "call_id",
        ),
        "call-1",
      );
      assert.equal(
        read(
          input.find((item) => item.type === "function_call_output"),
          "output",
        ),
        '{"forecast":"sunny"}',
      );
      assert.equal(second.store, false);
    } else if (family.api === "messages") {
      const messages = second.messages as JsonObject[];
      assert.equal(
        read(
          messages.find((message) => message.role === "assistant"),
          "content",
          0,
          "id",
        ),
        "call-1",
      );
      assert.equal(
        read(messages.at(-1), "content", 0, "tool_use_id"),
        "call-1",
      );
      assert.equal(
        read(messages.at(-1), "content", 0, "content"),
        '{"forecast":"sunny"}',
      );
    } else {
      const contents = second.contents as JsonObject[];
      const model = contents.find((content) => content.role === "model");
      assert.equal(read(model, "parts", 0, "functionCall", "id"), "call-1");
      assert.equal(
        read(model, "parts", 0, "thoughtSignature"),
        "signed-tool-call",
      );
      assert.equal(
        read(contents.at(-1), "parts", 0, "functionResponse", "id"),
        "call-1",
      );
      assert.deepEqual(
        read(contents.at(-1), "parts", 0, "functionResponse", "response"),
        { content: '{"forecast":"sunny"}' },
      );
    }
  });

  test(`${family.api}: structuredOutput delegates a nonstreaming schema request and normalizes usage`, async () => {
    const network = recorder([
      () => structuredResponse(family.api, family.model),
    ]);
    const adapter = opencodeConsoleText(family.model, {
      apiKey: "key",
      fetch: network.fetch,
    });
    const result = await adapter.structuredOutput({
      chatOptions: options("mismatched-caller-model"),
      outputSchema: schema,
    });
    assert.deepEqual(result.data, { answer: "yes" });
    assert.equal(result.rawText, '{"answer":"yes"}');
    assert.equal(result.usage?.promptTokens, usage.input);
    assert.equal(result.usage?.completionTokens, usage.output);
    assert.equal(result.usage?.totalTokens, usage.total);
    const body = network.calls[0]!.body;
    if (family.api !== "gemini") assert.equal(body.model, family.model);
    if (family.api === "chat-completions") {
      assert.equal(body.stream, false);
      assert.equal(read(body, "response_format", "type"), "json_schema");
      assert.equal(
        read(body, "response_format", "json_schema", "strict"),
        true,
      );
      assert.equal("stream_options" in body, false);
    } else if (family.api === "responses") {
      assert.equal(read(body, "text", "format", "type"), "json_schema");
      assert.equal(body.store, false);
    } else if (family.api === "messages") {
      assert.equal(body.stream, false);
      assert.deepEqual(body.tool_choice, {
        type: "tool",
        name: "structured_output",
      });
      assert.equal(
        read(body, "tools", 0, "input_schema", "properties", "answer", "type"),
        "string",
      );
    } else {
      assert.equal(
        network.calls[0]!.url.pathname,
        "/inference/google/v1beta/models/gemini-3.1-pro:generateContent",
      );
      assert.equal(
        read(body, "generationConfig", "responseMimeType"),
        "application/json",
      );
      assert.equal(
        read(
          body,
          "generationConfig",
          "responseSchema",
          "properties",
          "answer",
          "type",
        ),
        "STRING",
      );
    }
  });

  test(`${family.api}: caller cancellation reaches injected fetch`, async () => {
    const controller = new AbortController();
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let requests = 0;
    let receivedSignal: AbortSignal | null | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      requests++;
      receivedSignal = init?.signal;
      entered();
      return new Promise<Response>((_resolve, reject) => {
        const fail = () =>
          reject(init?.signal?.reason ?? new Error("cancelled"));
        if (init?.signal?.aborted) fail();
        else init?.signal?.addEventListener("abort", fail, { once: true });
      });
    };
    const result = collect(
      opencodeConsoleText(family.model, {
        apiKey: "",
        fetch: fetcher,
      }).chatStream({
        ...options(family.model),
        request: { signal: controller.signal },
      }),
    );
    await pending;
    controller.abort(new Error("user cancelled"));
    const chunks = await result;
    assert.equal(requests, 1);
    assert.equal(receivedSignal?.aborted, true);
    assert.ok(
      chunks.some((chunk) => chunk.type === "RUN_ERROR"),
      "Cancellation must not look like success",
    );
    assert.equal(
      chunks.some((chunk) => chunk.type === "RUN_FINISHED"),
      false,
    );
  });

  test(`${family.api}: timeout bounds a pending network call`, async () => {
    let receivedSignal: AbortSignal | null | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      receivedSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      });
    };
    // AbortSignal.timeout timers do not themselves retain the Node event loop.
    const keepAlive = setTimeout(() => {}, 2000);
    try {
      const chunks = await collect(
        opencodeConsoleText(family.model, {
          apiKey: "",
          fetch: fetcher,
          timeout: 25,
        }).chatStream(options(family.model)),
      );
      assert.equal(receivedSignal?.aborted, true);
      assert.ok(chunks.some((chunk) => chunk.type === "RUN_ERROR"));
      assert.equal(
        chunks.some((chunk) => chunk.type === "RUN_FINISHED"),
        false,
      );
    } finally {
      clearTimeout(keepAlive);
    }
  });
}

for (const [model, api, path] of [
  ["glm-5.3-flash", "chat-completions", "openai/v1/chat/completions"],
  ["minimax-m2.7", "messages", "anthropic/v1/messages"],
  ["gpt-6-luna", "responses", "openai/v1/responses"],
  ["qwen3.8-max", "messages", "anthropic/v1/messages"],
] as const) {
  test(`Go ${model}: explicit gateway/protocol preserves subscription routing and session headers`, async () => {
    const network = recorder([() => textResponse(api, model, "OK", false)]);
    const events = await collect(
      chat({
        adapter: opencodeConsoleText(model, {
          baseURL: "https://opencode.ai/inference/go",
          api,
          session: { accessToken: "user-session", orgId: "selected-workspace" },
          defaultHeaders: {
            "User-Agent": "tanstack-ai-opencode-console/0.1.0",
            "x-opencode-session": "stable-conversation",
          },
          fetch: network.fetch,
        }),
        messages: [{ role: "user", content: "Hello" }],
      }),
    );
    assert.ok(events.some((event) => event.type === "RUN_FINISHED"));
    assert.equal(network.calls.length, 1);
    const call = network.calls[0]!;
    assert.equal(call.url.pathname, `/inference/go/${path}`);
    assert.equal(call.headers.get("authorization"), "Bearer user-session");
    assert.equal(call.headers.get("x-opencode-org-id"), "selected-workspace");
    assert.equal(
      call.headers.get("user-agent"),
      "tanstack-ai-opencode-console/0.1.0",
    );
    assert.equal(call.headers.get("x-opencode-session"), "stable-conversation");
  });
}

test("Responses remain stateless by default while explicit storage is preserved", async () => {
  const network = recorder([
    () => textResponse("responses", "gpt-5.5", "Hello", false),
    () => textResponse("responses", "gpt-5.5", "Hello", false),
  ]);
  const adapter = opencodeConsoleText("gpt-5.5", {
    apiKey: "",
    fetch: network.fetch,
  });
  await collect(adapter.chatStream(options("gpt-5.5")));
  await collect(
    adapter.chatStream(
      options("gpt-5.5", { store: true, max_output_tokens: 100 }),
    ),
  );
  assert.equal(network.calls[0]?.body.store, false);
  assert.equal(network.calls[1]?.body.store, true);
  assert.equal(network.calls[1]?.body.max_output_tokens, 100);
});

for (const model of ["gpt-5.5", "gpt-6-luna"]) {
  test(`${model}: reasoning tool continuations replay encrypted content requested on the first turn`, async () => {
    const calls: JsonObject[] = [];
    const encryptedContent = "encrypted-reasoning-fixture";
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const body = JSON.parse(await request.text()) as JsonObject;
      assert.equal(body.model, model);
      calls.push(body);
      if (calls.length === 1) {
        const requested =
          Array.isArray(body.include) &&
          body.include.includes("reasoning.encrypted_content");
        const reasoning = {
          id: "reasoning-tool",
          type: "reasoning",
          summary: [],
          ...(requested ? { encrypted_content: encryptedContent } : {}),
        };
        const call = {
          id: "item-call",
          type: "function_call",
          call_id: "call-1",
          name: "lookup",
          arguments: '{"city":"Jakarta"}',
          status: "completed",
        };
        return sse([
          {
            event: "response.created",
            data: {
              type: "response.created",
              response: {
                id: "response-tool",
                model,
                output: [],
                status: "in_progress",
              },
            },
          },
          {
            event: "response.output_item.added",
            data: {
              type: "response.output_item.added",
              output_index: 0,
              item: reasoning,
            },
          },
          {
            event: "response.output_item.done",
            data: {
              type: "response.output_item.done",
              output_index: 0,
              item: reasoning,
            },
          },
          {
            event: "response.output_item.added",
            data: {
              type: "response.output_item.added",
              output_index: 1,
              item: { ...call, arguments: "", status: "in_progress" },
            },
          },
          {
            event: "response.function_call_arguments.done",
            data: {
              type: "response.function_call_arguments.done",
              output_index: 1,
              item_id: call.id,
              arguments: call.arguments,
              name: call.name,
            },
          },
          {
            event: "response.output_item.done",
            data: {
              type: "response.output_item.done",
              output_index: 1,
              item: call,
            },
          },
          {
            event: "response.completed",
            data: {
              type: "response.completed",
              response: {
                id: "response-tool",
                model,
                output: [reasoning, call],
                status: "completed",
                usage: responsesUsage(),
              },
            },
          },
        ]);
      }
      assert.equal(calls.length, 2);
      const replay = body.input as JsonObject[];
      const reasoningIndex = replay.findIndex(
        (item) => item.type === "reasoning",
      );
      assert.ok(reasoningIndex >= 0);
      assert.equal(replay[reasoningIndex]?.id, "reasoning-tool");
      assert.equal(replay[reasoningIndex]?.encrypted_content, encryptedContent);
      assert.equal(replay[reasoningIndex + 1]?.type, "function_call");
      assert.equal(replay[reasoningIndex + 1]?.call_id, "call-1");
      assert.equal(
        replay.find((item) => item.type === "function_call_output")?.output,
        '{"forecast":"sunny"}',
      );
      return textResponse("responses", model, "Sunny", false);
    };
    const inputs: unknown[] = [];
    const lookup = toolDefinition({
      name: "lookup",
      description: "Read a forecast",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
        additionalProperties: false,
      },
    }).server(async (input) => {
      inputs.push(input);
      return { forecast: "sunny" };
    });
    const requestedIncludes = ["message.output_text.logprobs"];
    const chunks = await collect(
      chat({
        adapter: opencodeConsoleText(model, { apiKey: "", fetch: fetcher }),
        messages: [{ role: "user", content: "Forecast?" }],
        tools: [lookup],
        modelOptions: { include: requestedIncludes },
        debug: false,
      }),
    );
    assert.equal(calls.length, 2);
    assert.deepEqual(inputs, [{ city: "Jakarta" }]);
    assert.deepEqual(
      chunks.filter((chunk) => chunk.type === "RUN_ERROR"),
      [],
    );
    assert.equal(
      chunks
        .filter((chunk) => chunk.type === "TEXT_MESSAGE_CONTENT")
        .map((chunk) => chunk.delta)
        .join(""),
      "Sunny",
    );
    for (const call of calls) {
      assert.deepEqual(call.include, [
        "message.output_text.logprobs",
        "reasoning.encrypted_content",
      ]);
      assert.equal(call.store, false);
    }
    assert.deepEqual(
      requestedIncludes,
      ["message.output_text.logprobs"],
      "Caller options remain unchanged",
    );
  });
}

test("encrypted reasoning covers verified GPT-5 and GPT-6 gateway families without changing ordinary or speculative models", async () => {
  const reasoningModels = [
    "gpt-5",
    "gpt-5.5",
    "gpt-5.3-codex",
    "gpt-6-luna",
    "gpt-6.1-sol",
    "GPT-6-LUNA",
    "GPT-5.5",
    "o1",
    "o3-mini",
    "o4-mini",
    "codex-mini-latest",
  ];
  const ordinaryModels = [
    "gpt-4o",
    "gpt-4.1",
    "gpt-5-chat-latest",
    "gpt-5.2-chat-latest",
    "gpt-6-chat-latest",
    "gpt-6.1-chat-latest",
    "GPT-6-CHAT-LATEST",
    "gpt-7",
    "gpt-50",
    "gpt-60-luna",
    "grok-4.5",
    "muse-spark-1.3",
  ];
  for (const model of [...reasoningModels, ...ordinaryModels]) {
    const network = recorder([
      () => textResponse("responses", model, "Hello", false),
    ]);
    await collect(
      opencodeConsoleText(model, {
        api: "responses",
        apiKey: "",
        fetch: network.fetch,
      }).chatStream(options(model)),
    );
    assert.deepEqual(
      network.calls[0]?.body.include,
      reasoningModels.includes(model)
        ? ["reasoning.encrypted_content"]
        : undefined,
      model,
    );
  }
});

test("required reasoning includes preserve explicit storage and avoid duplicate or replaced caller values", async () => {
  const explicit = [
    "reasoning.encrypted_content",
    "message.output_text.logprobs",
  ];
  const network = recorder([
    () => textResponse("responses", "gpt-5.5", "Hello", false),
    () => textResponse("responses", "gpt-5.5", "Hello", false),
  ]);
  const adapter = opencodeConsoleText("gpt-5.5", {
    apiKey: "",
    fetch: network.fetch,
  });
  await collect(
    adapter.chatStream(options("gpt-5.5", { include: explicit, store: true })),
  );
  await collect(
    adapter.chatStream(
      options("gpt-5.5", { include: "invalid-include", store: true }),
    ),
  );
  assert.deepEqual(network.calls[0]?.body.include, explicit);
  assert.equal(network.calls[0]?.body.store, true);
  assert.equal(network.calls[1]?.body.include, "invalid-include");
  assert.equal(network.calls[1]?.body.store, true);
  assert.deepEqual(explicit, [
    "reasoning.encrypted_content",
    "message.output_text.logprobs",
  ]);
});

test("Messages respect the explicit token ceiling", async () => {
  const network = recorder([
    () => textResponse("messages", "qwen3.6-plus", "Hello", false),
  ]);
  await collect(
    opencodeConsoleText("qwen3.6-plus", {
      apiKey: "",
      fetch: network.fetch,
    }).chatStream(options("qwen3.6-plus", { max_tokens: 123 })),
  );
  assert.equal(network.calls[0]?.body.max_tokens, 123);
});

test("a failed stream is not retried after an emitted delta", async () => {
  let requests = 0;
  const fetcher: typeof fetch = async () => {
    requests++;
    let reads = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (reads++ === 0) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ id: "partial", object: "chat.completion.chunk", created: 1, model: "big-pickle", choices: [{ index: 0, delta: { role: "assistant", content: "Partial" }, finish_reason: null }] })}\n\n`,
              ),
            );
          } else controller.error(new Error("connection interrupted"));
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  };
  const chunks = await collect(
    opencodeConsoleText("big-pickle", {
      apiKey: "",
      fetch: fetcher,
      maxRetries: 3,
    }).chatStream(options("big-pickle")),
  );
  assert.equal(requests, 1);
  assert.equal(
    chunks
      .filter((chunk) => chunk.type === "TEXT_MESSAGE_CONTENT")
      .map((chunk) => chunk.delta)
      .join(""),
    "Partial",
  );
  assert.ok(chunks.some((chunk) => chunk.type === "RUN_ERROR"));
  assert.equal(
    chunks.some((chunk) => chunk.type === "RUN_FINISHED"),
    false,
  );
});

test("Gemini request options cannot redirect Console credentials to another origin", async () => {
  let requests = 0;
  const fetcher: typeof fetch = async () => {
    requests++;
    return structuredResponse("gemini", "gemini-3.1-pro");
  };
  const adapter = opencodeConsoleText("gemini-3.1-pro", {
    apiKey: "sensitive-key",
    fetch: fetcher,
  });
  await assert.rejects(
    adapter.structuredOutput({
      chatOptions: options("gemini-3.1-pro", {
        httpOptions: { baseUrl: "https://attacker.example", apiVersion: "" },
      }),
      outputSchema: schema,
    }),
    /inference|endpoint|origin|root/,
  );
  assert.equal(requests, 0);
});

test("Gemini rejects malformed per-call headers before the SDK can expose credentials", async () => {
  const sensitive = "private-model-options-token";
  let requests = 0;
  const adapter = opencodeConsoleText("gemini-3.1-pro", {
    apiKey: "",
    fetch: async () => {
      requests++;
      return structuredResponse("gemini", "gemini-3.1-pro");
    },
  });
  const modelOptions = {
    httpOptions: {
      headers: { Authorization: `Bearer ${sensitive}\nInjected: header` },
    },
  };
  for (const activity of ["chat", "structuredOutput"] as const) {
    await assert.rejects(
      async () => {
        if (activity === "chat") {
          await collect(
            adapter.chatStream(options("gemini-3.1-pro", modelOptions)),
          );
        } else {
          await adapter.structuredOutput({
            chatOptions: options("gemini-3.1-pro", modelOptions),
            outputSchema: schema,
          });
        }
      },
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          "OpenCode HTTP headers contain an invalid name or value.",
        );
        assert.equal(error.message.includes(sensitive), false);
        assert.equal(error.stack?.includes(sensitive), false);
        return true;
      },
    );
  }
  assert.equal(requests, 0);
});

test("Gemini retains valid per-call headers and other HTTP options", async () => {
  const network = recorder([
    () => textResponse("gemini", "gemini-3.1-pro", "Hello", false),
  ]);
  const httpOptions = {
    headers: { "X-Request-Tag": "fixture" },
    apiVersion: "v1beta",
    timeout: 1000,
  };
  const chunks = await collect(
    opencodeConsoleText("gemini-3.1-pro", {
      apiKey: "",
      fetch: network.fetch,
    }).chatStream(options("gemini-3.1-pro", { httpOptions })),
  );
  assert.deepEqual(
    chunks.filter((chunk) => chunk.type === "RUN_ERROR"),
    [],
  );
  assert.equal(network.calls.length, 1);
  assert.equal(network.calls[0]?.headers.get("x-request-tag"), "fixture");
  assert.equal(
    network.calls[0]?.url.pathname,
    "/inference/google/v1beta/models/gemini-3.1-pro:streamGenerateContent",
  );
  assert.deepEqual(httpOptions, {
    headers: { "X-Request-Tag": "fixture" },
    apiVersion: "v1beta",
    timeout: 1000,
  });
});

// The phantom ~types field does not exist at runtime. Typecheck this function,
// but do not call it: node:test exercises the actual public adapter elsewhere.
function verifyTypeSurface(): void {
  const typedModel = opencodeConsoleText("custom-gateway-model");
  const literalModel: "custom-gateway-model" = typedModel.model;
  const textOnly: readonly ["text"] = typedModel["~types"].inputModalities;
  const vision = opencodeConsoleText("verified-vision-model", {
    inputModalities: ["text", "image"] as const,
  });
  const visionModalities: readonly ["text", "image"] =
    vision["~types"].inputModalities;
  const provider = createOpenCodeConsole({
    inputModalities: ["text", "image"] as const,
  });
  const selected = provider("verified-vision-model");
  const selectedModalities: readonly ["text", "image"] =
    selected["~types"].inputModalities;
  const textOverride = provider("text-model", {
    inputModalities: ["text"] as const,
  });
  const overriddenModalities: readonly ["text"] =
    textOverride["~types"].inputModalities;
  // @ts-expect-error The default adapter does not promise verified vision input.
  const unverifiedVision: readonly ["text", "image"] =
    typedModel["~types"].inputModalities;
  void literalModel;
  void textOnly;
  void visionModalities;
  void selectedModalities;
  void overriddenModalities;
  void unverifiedVision;
}
void verifyTypeSurface;

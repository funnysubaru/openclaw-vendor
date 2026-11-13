import type { AssistantMessage, Model } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { createZeroUsage } from "../usage.test-support.js";
import {
  RESPONSES_WEB_SEARCH_SOURCES_INCLUDE,
  recordResponsesHostedToolCall,
  withResponsesWebSearchSourcesInclude,
} from "./openai-responses-hosted-tool-calls-internal.js";
import {
  processResponsesStream,
  type OpenAIResponsesStreamEvent,
} from "./openai-responses-stream-internal.js";

const model = {
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
} satisfies Model<"openai-responses">;

function createOutput(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createZeroUsage(),
    stopReason: "stop",
    timestamp: 0,
  };
}

async function* eventStream(
  events: readonly Record<string, unknown>[],
): AsyncGenerator<OpenAIResponsesStreamEvent> {
  for (const event of events) {
    yield event as OpenAIResponsesStreamEvent;
  }
}

async function run(events: readonly Record<string, unknown>[]): Promise<AssistantMessage> {
  const output = createOutput();
  await processResponsesStream(eventStream(events), output, { push: () => {} }, model);
  return output;
}

const searchItem = (overrides: Record<string, unknown> = {}) => ({
  type: "web_search_call",
  id: "ws_1",
  status: "completed",
  action: {
    type: "search",
    query: "kawaguchi yakiniku",
    queries: ["kawaguchi yakiniku", "nishikawaguchi bbq"],
    sources: [
      { type: "url", url: "https://example.com/a" },
      { type: "url", url: "https://example.com/b" },
    ],
  },
  ...overrides,
});

const completed = (output: unknown[] = []) => ({
  type: "response.completed",
  sequence_number: 99,
  response: { id: "resp_1", status: "completed", output },
});

describe("Responses provider-hosted tool calls", () => {
  it("records a streamed web_search_call done item even when terminal output is empty", async () => {
    const output = await run([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "web_search_call", id: "ws_1", status: "in_progress" },
      },
      { type: "response.output_item.done", output_index: 0, item: searchItem() },
      completed([]),
    ]);
    expect(output.hostedToolCalls).toEqual([
      {
        type: "web_search",
        id: "ws_1",
        status: "completed",
        action: {
          type: "search",
          query: "kawaguchi yakiniku",
          queries: ["kawaguchi yakiniku", "nishikawaguchi bbq"],
        },
        sources: ["https://example.com/a", "https://example.com/b"],
      },
    ]);
    expect(output.content).toEqual([]);
  });

  it("does not duplicate a call that is repeated in terminal output", async () => {
    const output = await run([
      { type: "response.output_item.done", output_index: 0, item: searchItem() },
      completed([searchItem()]),
    ]);
    expect(output.hostedToolCalls?.map((call) => call.id)).toEqual(["ws_1"]);
  });

  it("keeps earlier sources and action facts when a sparse terminal copy arrives", async () => {
    const output = await run([
      { type: "response.output_item.done", output_index: 0, item: searchItem() },
      completed([{ type: "web_search_call", id: "ws_1", status: "completed" }]),
    ]);
    expect(output.hostedToolCalls).toEqual([
      {
        type: "web_search",
        id: "ws_1",
        status: "completed",
        action: {
          type: "search",
          query: "kawaguchi yakiniku",
          queries: ["kawaguchi yakiniku", "nishikawaguchi bbq"],
        },
        sources: ["https://example.com/a", "https://example.com/b"],
      },
    ]);
  });

  it("lets a later copy update only the status and fields it carries", () => {
    const output = createOutput();
    recordResponsesHostedToolCall(output, searchItem({ status: "in_progress" }));
    recordResponsesHostedToolCall(output, {
      type: "web_search_call",
      id: "ws_1",
      status: "failed",
      action: { query: "kawaguchi bbq" },
    });
    recordResponsesHostedToolCall(output, { type: "web_search_call", id: "ws_1" });
    expect(output.hostedToolCalls).toEqual([
      {
        type: "web_search",
        id: "ws_1",
        status: "failed",
        action: {
          type: "search",
          query: "kawaguchi bbq",
          queries: ["kawaguchi yakiniku", "nishikawaguchi bbq"],
        },
        sources: ["https://example.com/a", "https://example.com/b"],
      },
    ]);
  });

  it("collects hosted calls from a failed terminal response before rethrowing", async () => {
    const output = createOutput();
    await expect(
      processResponsesStream(
        eventStream([
          {
            type: "response.failed",
            sequence_number: 99,
            response: {
              id: "resp_failed",
              status: "failed",
              error: { code: "server_error", message: "boom" },
              output: [searchItem({ id: "ws_failed" })],
            },
          },
        ]),
        output,
        { push: () => {} },
        model,
      ),
    ).rejects.toMatchObject({ name: "ResponsesStreamFailure" });
    expect(output.hostedToolCalls).toEqual([
      expect.objectContaining({
        id: "ws_failed",
        status: "completed",
        action: expect.objectContaining({ query: "kawaguchi yakiniku" }),
        sources: ["https://example.com/a", "https://example.com/b"],
      }),
    ]);
  });

  it("records calls that only appear in terminal output", async () => {
    const output = await run([completed([searchItem({ id: "ws_2", status: "failed" })])]);
    expect(output.hostedToolCalls).toMatchObject([{ id: "ws_2", status: "failed" }]);
  });

  it("leaves messages without hosted calls unchanged", async () => {
    const output = await run([completed([])]);
    expect(output.hostedToolCalls).toBeUndefined();
  });

  it("ignores other item types and web_search_call items without an id", () => {
    const output = createOutput();
    recordResponsesHostedToolCall(output, { type: "function_call", id: "fc_1" });
    recordResponsesHostedToolCall(output, searchItem({ id: undefined }));
    recordResponsesHostedToolCall(output, "not an item");
    expect(output.hostedToolCalls).toBeUndefined();
  });

  it("keeps only string facts from the provider item", () => {
    const output = createOutput();
    recordResponsesHostedToolCall(output, {
      type: "web_search_call",
      id: "ws_3",
      action: {
        type: "open_page",
        url: "https://example.com/page",
        queries: [1, ""],
        sources: [{}],
      },
      extra: "dropped",
    });
    expect(output.hostedToolCalls).toEqual([
      {
        type: "web_search",
        id: "ws_3",
        status: "unknown",
        action: { type: "open_page", url: "https://example.com/page" },
      },
    ]);
  });
});

describe("withResponsesWebSearchSourcesInclude", () => {
  it("asks for source URLs only when the hosted web_search tool is present", () => {
    const body = { tools: [{ type: "web_search" }], include: ["reasoning.encrypted_content"] };
    expect(withResponsesWebSearchSourcesInclude(body)).toEqual({
      tools: [{ type: "web_search" }],
      include: ["reasoning.encrypted_content", RESPONSES_WEB_SEARCH_SOURCES_INCLUDE],
    });
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
  });

  it("leaves requests without the hosted tool unchanged", () => {
    const body = { tools: [{ type: "function", name: "web_search" }] };
    expect(withResponsesWebSearchSourcesInclude(body)).toBe(body);
    const noTools = { input: [] };
    expect(withResponsesWebSearchSourcesInclude(noTools)).toBe(noTools);
  });

  it("does not repeat an include that is already present", () => {
    const body = {
      tools: [{ type: "web_search" }],
      include: [RESPONSES_WEB_SEARCH_SOURCES_INCLUDE],
    };
    expect(withResponsesWebSearchSourcesInclude(body)).toBe(body);
  });
});

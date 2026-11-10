import { describe, expect, it } from "vitest";
import { buildOpenAICompletionsParams } from "./openai-completions-params.js";
import { processCompletionsStream } from "./openai-completions-stream.js";
import {
  createAssistantOutput,
  makeCompletionsChunk,
  makeCompletionsModel,
} from "./openai-completions.test-support.js";

// ADR-0033 任务 150：Gemini（含 OpenRouter 的 google/gemini-*）遇到 Python 保留字参数名
// （automations 的 `in`、memory_get 的 `from`）会回 MALFORMED_FUNCTION_CALL。
// openai-completions 传输层要像上游 #191561 在 Google 原生传输层那样：发出前改名、回包后还原。

const keywordTool = {
  name: "automations",
  description: "Schedule an automation",
  parameters: {
    type: "object",
    properties: {
      in: { type: "string" },
      in_: { type: "string" },
      from: { type: "string" },
      data: { type: "object" },
    },
    required: ["in", "from"],
  },
};

const geminiModel = () =>
  makeCompletionsModel({
    id: "google/gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash Lite",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
  });

type ParamsShape = {
  tools?: Array<{ function: { parameters: { properties: object; required?: string[] } } }>;
  messages: Array<{ role: string; tool_calls?: Array<{ function: { arguments: string } }> }>;
};

describe("openai completions Gemini keyword parameter aliases", () => {
  it("renames keyword parameters on the way out without mutating the tool", () => {
    const original = JSON.stringify(keywordTool);
    const params = buildOpenAICompletionsParams(
      geminiModel(),
      { systemPrompt: "s", messages: [], tools: [keywordTool] } as never,
      undefined,
    ) as unknown as ParamsShape;
    const schema = params.tools?.[0]?.function.parameters;
    expect(Object.keys(schema?.properties ?? {}).toSorted()).toEqual(
      ["data", "from_", "in_", "in__"].toSorted(),
    );
    expect(schema?.required).toEqual(["in__", "from_"]);
    expect(JSON.stringify(keywordTool)).toBe(original);
  });

  it("leaves non-Gemini models untouched", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({ id: "gpt-5", name: "GPT-5" }),
      { systemPrompt: "s", messages: [], tools: [keywordTool] } as never,
      undefined,
    ) as unknown as ParamsShape;
    expect(Object.keys(params.tools?.[0]?.function.parameters.properties ?? {})).toContain("in");
  });

  it("encodes keyword arguments in replayed assistant tool calls", () => {
    const params = buildOpenAICompletionsParams(
      geminiModel(),
      {
        systemPrompt: "s",
        tools: [keywordTool],
        messages: [
          { role: "user", content: "schedule it", timestamp: 1 },
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call_1",
                name: "automations",
                arguments: { in: "5m", in_: "literal", data: { in: "opaque" } },
              },
            ],
            api: "openai-completions",
            provider: "openrouter",
            model: "google/gemini-2.5-flash-lite",
            stopReason: "toolUse",
            timestamp: 2,
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "automations",
            content: [{ type: "text", text: "ok" }],
            isError: false,
            timestamp: 3,
          },
        ],
      } as never,
      undefined,
    ) as unknown as ParamsShape;
    const call = params.messages.find((m) => m.role === "assistant")?.tool_calls?.[0];
    expect(JSON.parse(call?.function.arguments ?? "{}")).toEqual({
      in__: "5m",
      in_: "literal",
      data: { in: "opaque" },
    });
  });

  it("restores keyword arguments from the streamed tool call before execution", async () => {
    const model = geminiModel();
    const output = createAssistantOutput(model);
    const events: Array<{ type: string; toolCall?: unknown }> = [];
    async function* chunks() {
      yield makeCompletionsChunk({
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            function: {
              name: "automations",
              arguments: '{"in__":"5m","in_":"literal","from_":"now","data":{"in__":"opaque"}}',
            },
          },
        ],
      }) as never;
      yield makeCompletionsChunk({}, "tool_calls") as never;
    }
    await processCompletionsStream(
      chunks(),
      output,
      model,
      { push: (e) => events.push(e) },
      {
        tools: [keywordTool] as never,
        sawStreamDONE: () => true,
      },
    );
    const expected = { in: "5m", in_: "literal", from: "now", data: { in__: "opaque" } };
    expect(output.stopReason).toBe("toolUse");
    expect((output.content[0] as { arguments: unknown }).arguments).toEqual(expected);
    expect(events.find((e) => e.type === "toolcall_end")?.toolCall).toMatchObject({
      arguments: expected,
    });
  });

  it("keeps OpenRouter native_finish_reason in the error message", async () => {
    const model = geminiModel();
    const output = createAssistantOutput(model);
    async function* chunks() {
      const chunk = makeCompletionsChunk({}, "error");
      (chunk.choices[0] as unknown as Record<string, unknown>).native_finish_reason =
        "MALFORMED_FUNCTION_CALL";
      yield chunk as never;
    }
    await processCompletionsStream(
      chunks(),
      output,
      model,
      { push: () => {} },
      {
        sawStreamDONE: () => true,
      },
    );
    expect(output.stopReason).toBe("error");
    expect(output.errorMessage).toBe(
      "Provider finish_reason: error (native_finish_reason: MALFORMED_FUNCTION_CALL)",
    );
  });
});

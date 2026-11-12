import { describe, expect, it } from "vitest";
import {
  buildOpenAICompletionsParams,
  getCompletionsToolArgumentAliases,
} from "./openai-completions-params.js";
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
    const params = buildOpenAICompletionsParams(
      model,
      { systemPrompt: "s", messages: [], tools: [keywordTool] } as never,
      undefined,
    );
    await processCompletionsStream(
      chunks(),
      output,
      model,
      { push: (e) => events.push(e) },
      {
        toolArgumentAliases: getCompletionsToolArgumentAliases(params),
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

  it.each([
    [
      "trailing usage chunk repeating finish_reason without native_finish_reason",
      () => {
        const first = makeCompletionsChunk({}, "error");
        (first.choices[0] as unknown as Record<string, unknown>).native_finish_reason =
          "MALFORMED_FUNCTION_CALL";
        const usageTail = makeCompletionsChunk({}, "error");
        return [first, usageTail];
      },
    ],
    [
      "finish_reason and native_finish_reason split across consecutive chunks",
      () => {
        const first = makeCompletionsChunk({}, "error");
        const second = makeCompletionsChunk({}, null);
        (second.choices[0] as unknown as Record<string, unknown>).native_finish_reason =
          "MALFORMED_FUNCTION_CALL";
        return [first, second];
      },
    ],
  ])("preserves native_finish_reason across multi-chunk streams (%s)", async (_label, build) => {
    const model = geminiModel();
    const output = createAssistantOutput(model);
    async function* chunks() {
      for (const item of build()) {
        yield item as never;
      }
    }
    await processCompletionsStream(
      chunks(),
      output,
      model,
      { push: () => {} },
      { sawStreamDONE: () => true },
    );
    expect(output.stopReason).toBe("error");
    expect(output.errorMessage).toBe(
      "Provider finish_reason: error (native_finish_reason: MALFORMED_FUNCTION_CALL)",
    );
  });

  it("skips aliasing in managed mode when an array-nested subschema defines its own $id", () => {
    const nestedIdTool = {
      name: "complex_tool",
      description: "Nested $id inside anyOf",
      parameters: {
        type: "object",
        properties: {
          in: { type: "string" },
          items: {
            anyOf: [
              {
                $id: "urn:inner",
                type: "object",
                properties: { in: { type: "number" }, ref: { $ref: "#/properties/in" } },
              },
            ],
          },
        },
        required: ["in"],
      },
    };
    const params = buildOpenAICompletionsParams(
      geminiModel(),
      { systemPrompt: "s", messages: [], tools: [nestedIdTool] } as never,
      undefined,
    );
    const shaped = params as unknown as ParamsShape;
    const outbound = shaped.tools?.[0]?.function.parameters;
    expect(Object.keys(outbound?.properties ?? {})).toContain("in");
    expect(JSON.stringify(outbound)).not.toContain("in_");
    expect(getCompletionsToolArgumentAliases(params)?.size).toBe(0);
  });

  it("registers an empty alias map when no tools are aliased and clears duplicate-name entries", () => {
    const plainTool = {
      name: "plain",
      description: "No Python keywords",
      parameters: { type: "object", properties: { in_: { type: "string" } } },
    };
    const noAliasParams = buildOpenAICompletionsParams(
      geminiModel(),
      { systemPrompt: "s", messages: [], tools: [plainTool] } as never,
      undefined,
    );
    expect(getCompletionsToolArgumentAliases(noAliasParams)).toEqual(new Map());

    const duplicateTools = [
      {
        name: "dup",
        description: "First has keyword",
        parameters: { type: "object", properties: { in: { type: "string" } } },
      },
      {
        name: "dup",
        description: "Second has no keyword",
        parameters: { type: "object", properties: { in_: { type: "string" } } },
      },
    ];
    const dupParams = buildOpenAICompletionsParams(
      geminiModel(),
      { systemPrompt: "s", messages: [], tools: duplicateTools } as never,
      undefined,
    );
    expect(getCompletionsToolArgumentAliases(dupParams)?.has("dup")).toBe(false);
  });

  // vendor PR #153 review：映射必须来自「最终出站 schema」，并被出站、历史编码、回包还原三处共用。
  describe("aliases derived from the final outbound schema", () => {
    const keywordNames = new Set(["in", "from"]);
    // 收集函数顶层字段名：根 properties + allOf/anyOf/oneOf 分支里的 properties。
    const topLevelNames = (schema: Record<string, unknown>): string[] => [
      ...Object.keys((schema.properties as object | undefined) ?? {}),
      ...["allOf", "anyOf", "oneOf"].flatMap((key) =>
        ((schema[key] as Record<string, unknown>[] | undefined) ?? []).flatMap(topLevelNames),
      ),
    ];
    const roundTrip = async (parameters: unknown, history: Record<string, unknown>) => {
      const model = geminiModel();
      const tool = { name: "lookup", description: "Look up", parameters };
      const params = buildOpenAICompletionsParams(
        model,
        {
          systemPrompt: "s",
          tools: [tool],
          messages: [
            { role: "user", content: "go", timestamp: 1 },
            {
              role: "assistant",
              content: [{ type: "toolCall", id: "call_0", name: "lookup", arguments: history }],
              api: "openai-completions",
              provider: "openrouter",
              model: model.id,
              stopReason: "toolUse",
              timestamp: 2,
            },
            {
              role: "toolResult",
              toolCallId: "call_0",
              toolName: "lookup",
              content: [{ type: "text", text: "ok" }],
              isError: false,
              timestamp: 3,
            },
          ],
        } as never,
        undefined,
      );
      const shaped = params as unknown as ParamsShape;
      const outbound = shaped.tools?.[0]?.function.parameters as unknown as Record<string, unknown>;
      const wireHistory = JSON.parse(
        shaped.messages.find((m) => m.role === "assistant")?.tool_calls?.[0]?.function.arguments ??
          "{}",
      ) as Record<string, unknown>;
      // 模型照着出站 schema、用历史里同样的参数名回一次工具调用，收尾后应还原成原名。
      const output = createAssistantOutput(model);
      async function* chunks() {
        yield makeCompletionsChunk({
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              function: { name: "lookup", arguments: JSON.stringify(wireHistory) },
            },
          ],
        }) as never;
        yield makeCompletionsChunk({}, "tool_calls") as never;
      }
      await processCompletionsStream(
        chunks(),
        output,
        model,
        { push: () => {} },
        {
          toolArgumentAliases: getCompletionsToolArgumentAliases(params),
          sawStreamDONE: () => true,
        },
      );
      return {
        outboundNames: topLevelNames(outbound),
        wireHistory,
        decoded: (output.content[0] as { arguments: unknown }).arguments,
      };
    };

    it("renames keyword parameters behind a root $ref", async () => {
      const result = await roundTrip(
        {
          $ref: "#/$defs/Args",
          $defs: {
            Args: { type: "object", properties: { in: { type: "string" } }, required: ["in"] },
          },
        },
        { in: "5m" },
      );
      expect(result.outboundNames.filter((name) => keywordNames.has(name))).toEqual([]);
      expect(result.wireHistory).toEqual({ in_: "5m" });
      expect(result.decoded).toEqual({ in: "5m" });
    });

    it("renames keyword parameters declared in root anyOf branches", async () => {
      const result = await roundTrip(
        {
          anyOf: [
            { type: "object", properties: { in: { type: "string" } }, required: ["in"] },
            { type: "object", properties: { from: { type: "string" } }, required: ["from"] },
          ],
        },
        { in: "5m", from: "now" },
      );
      expect(result.outboundNames.filter((name) => keywordNames.has(name))).toEqual([]);
      expect(result.decoded).toEqual({ in: "5m", from: "now" });
    });

    it("avoids aliases that collide with top-level fields from allOf branches", async () => {
      const result = await roundTrip(
        {
          type: "object",
          properties: { in: { type: "string" } },
          allOf: [{ type: "object", properties: { in_: { type: "number" } } }],
        },
        { in: "5m", in_: 7 },
      );
      expect(result.outboundNames.filter((name) => keywordNames.has(name))).toEqual([]);
      expect(Object.keys(result.wireHistory)).toHaveLength(2);
      expect(result.decoded).toEqual({ in: "5m", in_: 7 });
    });

    it("restores arguments for schemas serialized through toJSON", async () => {
      const parameters = {
        toJSON: () => ({
          type: "object",
          properties: { in: { type: "string" } },
          required: ["in"],
        }),
      };
      const result = await roundTrip(parameters, { in: "5m" });
      expect(result.outboundNames).toEqual(["in_"]);
      expect(result.decoded).toEqual({ in: "5m" });
    });
  });
});

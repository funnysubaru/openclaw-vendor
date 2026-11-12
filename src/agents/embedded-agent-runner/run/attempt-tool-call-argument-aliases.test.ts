import { createServer } from "node:http";
import { createOpenAICompletionsTransportStreamFn } from "@openclaw/ai/transports";
import { describe, expect, it } from "vitest";
import { buildOpenAICompletionsParams } from "../../../../packages/ai/src/transports/openai-completions-params.js";
import { makeCompletionsModel } from "../../../../packages/ai/src/transports/openai-completions.test-support.js";
import { wrapStreamFnDecodeToolArgumentAliases } from "./attempt-tool-call-argument-aliases.js";
import { wrapStreamFnTrimToolCallNames } from "./attempt-tool-call-stream-normalization.js";
import { wrapStreamFnPromoteStandaloneTextToolCalls } from "./attempt-tool-call-text-promotion.js";
import { wrapStreamFnRepairMalformedToolCallArguments } from "./attempt.tool-call-argument-repair.js";

// ADR-0033 任务 150 / vendor PR #153 合并前自检：Gemini 保留字参数在传输层改名（`in` → `in_`）。
// 传输层只按模型回包里的原始工具名还原；runner 之后还会纠正工具名（`default_api.automations` →
// `automations`）、把文本形式的工具调用提升成工具调用块。这里按 attempt-stream.ts 的顺序串起真实包装器，
// 验证工具最终拿到的都是原名。

const chunk = (delta: unknown, finishReason: string | null = null) =>
  `data: ${JSON.stringify({
    id: "c",
    object: "chat.completion.chunk",
    created: 1,
    model: "google/gemini-2.5-flash-lite",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;

async function runChain(sseChunks: string[]) {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      for (const part of sseChunks) {
        res.write(part);
      }
      res.end();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing loopback server address");
    }
    const allowed = new Set(["automations"]);
    let streamFn = createOpenAICompletionsTransportStreamFn() as never;
    streamFn = wrapStreamFnPromoteStandaloneTextToolCalls(streamFn, allowed) as never;
    streamFn = wrapStreamFnTrimToolCallNames(streamFn, allowed) as never;
    streamFn = wrapStreamFnDecodeToolArgumentAliases(streamFn) as never;
    streamFn = wrapStreamFnRepairMalformedToolCallArguments(streamFn) as never;
    const stream = (await (streamFn as (...args: unknown[]) => unknown)(
      {
        id: "google/gemini-2.5-flash-lite",
        name: "Gemini 2.5 Flash Lite",
        api: "openai-completions",
        provider: "openrouter",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 8192,
      },
      {
        systemPrompt: "system",
        messages: [{ role: "user", content: "remind me in 5 minutes", timestamp: 1 }],
        tools: [
          {
            name: "automations",
            description: "Schedule",
            parameters: {
              type: "object",
              properties: { action: { type: "string" }, in: { type: "string" } },
              required: ["action"],
            },
          },
        ],
      },
      { apiKey: "test-key" },
    )) as AsyncIterable<{ type: string; toolCall?: { name?: string; arguments?: unknown } }> & {
      result: () => Promise<{
        content: Array<{ type: string; name?: string; arguments?: unknown }>;
      }>;
    };
    const ends: unknown[] = [];
    for await (const event of stream) {
      if (event.type === "toolcall_end") {
        ends.push({ name: event.toolCall?.name, arguments: event.toolCall?.arguments });
      }
    }
    const message = await stream.result();
    return {
      ends,
      final: message.content
        .filter((block) => block.type === "toolCall")
        .map((block) => ({ name: block.name, arguments: block.arguments })),
    };
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

const expected = [{ name: "automations", arguments: { action: "add", in: "5m" } }];

describe("Gemini keyword aliases after runner tool-call normalization", () => {
  it.each(["default_api.automations", " automations ", "Automations"])(
    "restores original names when the model calls %j",
    async (name) => {
      const result = await runChain([
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name, arguments: '{"action":"add","in_":"5m"}' },
            },
          ],
        }),
        chunk({}, "tool_calls"),
        "data: [DONE]\n\n",
      ]);
      expect(result.final).toEqual(expected);
      expect(result.ends).toEqual(expected);
    },
  );

  it("restores original names on a text tool call promoted by the runner", async () => {
    const result = await runChain([
      chunk({ content: '[tool:automations] {"action":"add","in_":"5m"}' }),
      chunk({}, "stop"),
      "data: [DONE]\n\n",
    ]);
    expect(result.final).toEqual(expected);
    expect(result.ends).toEqual(expected);
  });

  it("decodes distinct event.partial and event.error messages and clears stale aliases across payload retries", async () => {
    const gemini = makeCompletionsModel({
      id: "google/gemini-2.5-flash-lite",
      name: "Gemini 2.5 Flash Lite",
      provider: "openrouter",
    });
    const aliasedPayload = buildOpenAICompletionsParams(
      gemini,
      {
        systemPrompt: "s",
        messages: [],
        tools: [
          {
            name: "automations",
            description: "Schedule",
            parameters: { type: "object", properties: { in: { type: "string" } } },
          },
        ],
      } as never,
      undefined,
    );
    const unaliasedPayload = buildOpenAICompletionsParams(
      gemini,
      {
        systemPrompt: "s",
        messages: [],
        tools: [
          {
            name: "automations",
            description: "Literal underscore param",
            parameters: { type: "object", properties: { in_: { type: "string" } } },
          },
        ],
      } as never,
      undefined,
    );

    const partialCall = { type: "toolCall", name: "automations", arguments: { in_: "5m" } };
    const endCall = { type: "toolCall", name: "automations", arguments: { in_: "5m" } };
    const errorCall = { type: "toolCall", name: "automations", arguments: { in_: "5m" } };
    const retryCall = { type: "toolCall", name: "automations", arguments: { in_: "literal" } };

    let attempt = 0;
    const baseFn: Parameters<typeof wrapStreamFnDecodeToolArgumentAliases>[0] = (
      _model,
      _ctx,
      options,
    ) => {
      attempt += 1;
      const firstAttempt = attempt === 1;
      const activePayload = firstAttempt ? aliasedPayload : unaliasedPayload;
      options?.onPayload?.(activePayload, gemini as never);
      // Inner wrapper cloning payload on the same attempt must not wipe the registered aliases.
      options?.onPayload?.({ ...activePayload }, gemini as never);
      const events = firstAttempt
        ? [
            {
              type: "toolcall_end",
              toolCall: endCall,
              partial: { role: "assistant", content: [partialCall] },
            },
            {
              type: "error",
              error: { role: "assistant", content: [errorCall] },
            },
          ]
        : [];
      const resultMessage = {
        role: "assistant",
        content: [firstAttempt ? endCall : retryCall],
      };
      return {
        async result() {
          return resultMessage;
        },
        [Symbol.asyncIterator]() {
          return (async function* () {
            for (const event of events) {
              yield event;
            }
          })();
        },
      } as never;
    };
    const wrapped = wrapStreamFnDecodeToolArgumentAliases(baseFn);

    const stream1 = await Promise.resolve(wrapped(gemini as never, {} as never, {} as never));
    for await (const ignored of stream1 as AsyncIterable<unknown>) {
      void ignored;
    }
    await stream1.result();
    expect(partialCall.arguments).toEqual({ in: "5m" });
    expect(endCall.arguments).toEqual({ in: "5m" });
    expect(errorCall.arguments).toEqual({ in: "5m" });

    // Second invocation on the same StreamFn with a 0-alias completions payload must NOT decode literal `in_`.
    const stream2 = await Promise.resolve(wrapped(gemini as never, {} as never, {} as never));
    await stream2.result();
    expect(retryCall.arguments).toEqual({ in_: "literal" });
  });
});

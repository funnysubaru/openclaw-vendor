import { createServer } from "node:http";
import { createOpenAICompletionsTransportStreamFn } from "@openclaw/ai/transports";
import { describe, expect, it } from "vitest";
import { wrapStreamFnRepairMalformedToolCallArguments } from "./attempt.tool-call-argument-repair.js";

// ADR-0033 任务 150 / vendor PR #153 自检：Gemini 走 openai-completions 时保留字参数会被改成别名
// （`in` → `in_`）。runner 对 openai-completions 一律套「工具参数修复」包装器，它会拿原始 delta 文本
// （别名键）重新解析并写回。这里用真实 completions 传输层 + 包装器端到端验证：工具最终拿到的是原名。

const chunk = (delta: unknown, finishReason: string | null = null) =>
  `data: ${JSON.stringify({
    id: "c",
    object: "chat.completion.chunk",
    created: 1,
    model: "google/gemini-2.5-flash-lite",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;

describe("openai-completions Gemini keyword aliases through the tool-call repair wrapper", () => {
  it("delivers original parameter names on toolcall_end and the final message", async () => {
    let requestBody = "";
    const server = createServer((req, res) => {
      req.setEncoding("utf8");
      req.on("data", (part) => {
        requestBody += part;
      });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        // 参数分两片发，最后一片带 `}`，会触发包装器的重新解析。
        res.write(
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "automations", arguments: '{"action":"add","in_":' },
              },
            ],
          }),
        );
        res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: '"5m"}' } }] }));
        res.write(chunk({}, "tool_calls"));
        res.write("data: [DONE]\n\n");
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
      const model = {
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
      };
      const streamFn = wrapStreamFnRepairMalformedToolCallArguments(
        createOpenAICompletionsTransportStreamFn() as never,
      );
      const stream = (await streamFn(
        model as never,
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
        } as never,
        // onPayload 换成新对象：别名必须在它之前取出，仍能还原。
        { apiKey: "test-key", onPayload: (payload: object) => ({ ...payload }) } as never,
      )) as AsyncIterable<{ type: string; toolCall?: { arguments?: unknown } }> & {
        result: () => Promise<{ content: Array<{ type: string; arguments?: unknown }> }>;
      };
      const ends: unknown[] = [];
      for await (const event of stream) {
        if (event.type === "toolcall_end") {
          ends.push(event.toolCall?.arguments);
        }
      }
      const message = await stream.result();

      const sentTool = (
        JSON.parse(requestBody) as {
          tools: Array<{ function: { parameters: { properties: object } } }>;
        }
      ).tools[0];
      expect(Object.keys(sentTool?.function.parameters.properties ?? {})).toEqual([
        "action",
        "in_",
      ]);
      expect(ends).toEqual([{ action: "add", in: "5m" }]);
      expect(message.content.find((block) => block.type === "toolCall")?.arguments).toEqual({
        action: "add",
        in: "5m",
      });
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});

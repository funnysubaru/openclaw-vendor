import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { streamOpenAICompletions } from "./openai-completions.js";

// ADR-0033 任务 150 / vendor PR #153 自检：direct 路径（streamOpenAICompletions）同样要做到
// 出站改名、历史编码、toolcall_end 与最终消息还原原名。direct 不做 schema 规范化，别名按实际发送的 schema 算。

const sse = (delta: unknown, finishReason: string | null = null) =>
  `data: ${JSON.stringify({
    id: "c",
    object: "chat.completion.chunk",
    created: 1,
    model: "google/gemini-2.5-flash-lite",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;

describe("direct openai-completions Gemini keyword aliases", () => {
  it("renames outbound, encodes history and restores the streamed call", async () => {
    let requestBody = "";
    const server = createServer((req, res) => {
      req.setEncoding("utf8");
      req.on("data", (part) => {
        requestBody += part;
      });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        res.write(
          sse({
            tool_calls: [
              {
                index: 0,
                id: "call_2",
                type: "function",
                function: { name: "memory_get", arguments: '{"path":"a.md","from_":3}' },
              },
            ],
          }),
        );
        res.write(sse({}, "tool_calls"));
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
      const tool = {
        name: "memory_get",
        description: "Read memory",
        parameters: {
          type: "object",
          properties: { path: { type: "string" }, from: { type: "number" } },
          required: ["path"],
        },
      };
      const stream = streamOpenAICompletions(
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
          systemPrompt: "s",
          tools: [tool],
          messages: [
            { role: "user", content: "read it", timestamp: 1 },
            {
              role: "assistant",
              content: [
                { type: "toolCall", id: "call_1", name: "memory_get", arguments: { from: 1 } },
              ],
              api: "openai-completions",
              provider: "openrouter",
              model: "google/gemini-2.5-flash-lite",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "toolUse",
              timestamp: 2,
            },
            {
              role: "toolResult",
              toolCallId: "call_1",
              toolName: "memory_get",
              content: [{ type: "text", text: "ok" }],
              isError: false,
              timestamp: 3,
            },
          ],
        } as never,
        { apiKey: "test-key", onPayload: (payload: unknown) => ({ ...(payload as object) }) },
      );
      const ends: unknown[] = [];
      for await (const event of stream) {
        if (event.type === "toolcall_end") {
          ends.push(event.toolCall.arguments);
        }
      }
      const message = await stream.result();

      const body = JSON.parse(requestBody) as {
        tools: Array<{ function: { parameters: { properties: object } } }>;
        messages: Array<{ role: string; tool_calls?: Array<{ function: { arguments: string } }> }>;
      };
      expect(Object.keys(body.tools[0]?.function.parameters.properties ?? {})).toEqual([
        "path",
        "from_",
      ]);
      const history = body.messages.find((m) => m.role === "assistant")?.tool_calls?.[0];
      expect(JSON.parse(history?.function.arguments ?? "{}")).toEqual({ from_: 1 });
      expect(ends).toEqual([{ path: "a.md", from: 3 }]);
      expect(message.content.find((block) => block.type === "toolCall")).toMatchObject({
        arguments: { path: "a.md", from: 3 },
      });
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});

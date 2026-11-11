import {
  decodeToolCallBlockByName,
  getCompletionsToolArgumentAliases,
} from "@openclaw/ai/internal/openai";
import type { StreamFn } from "../../runtime/index.js";
import type { MutableAssistantMessageEventStream } from "../../stream-compat.js";
import { isRunnerToolCallBlockType } from "./attempt-tool-call-block-type.js";
import { wrapStreamObjectEvents } from "./stream-wrapper.js";

// ADR-0033 任务 150 / vendor PR #153 合并前自检：Gemini 走 openai-completions 时保留字参数被改成别名
// （`in` → `in_`）。传输层只按模型回包里的原始工具名还原，而 runner 之后还会：
// - 纠正工具名（`default_api.automations`、` automations ` → `automations`）；当前靠名字修剪包装器在流式过程中
//   原地改名、恰好早于传输层收尾，属于时序巧合；
// - 把文本形式的工具调用（`[tool:automations] {...}`）提升成新块，这些块从没经过传输层收尾。
// 这一层放在名字纠正和文本提升之后，按块最终的名字再还原一次（幂等），并登记给外层的参数修复包装器。

type AliasesByTool = Parameters<typeof decodeToolCallBlockByName>[1];

function decodeMessageToolCalls(message: unknown, aliasesByTool: AliasesByTool): void {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return;
  }
  for (const block of content) {
    if (block && typeof block === "object" && isRunnerToolCallBlockType(block.type)) {
      decodeToolCallBlockByName(block, aliasesByTool);
    }
  }
}

function wrapStream(
  stream: MutableAssistantMessageEventStream,
  readAliases: () => AliasesByTool | undefined,
): MutableAssistantMessageEventStream {
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    const aliasesByTool = readAliases();
    if (aliasesByTool) {
      decodeMessageToolCalls(message, aliasesByTool);
    }
    return message;
  };
  wrapStreamObjectEvents(stream, (event) => {
    const aliasesByTool = readAliases();
    if (!aliasesByTool) {
      return;
    }
    // 只在工具调用确认（toolcall_end）和整条消息收尾（done / error 的 message）时还原；
    // 流式中途的 partial 参数还不完整，交给收尾时处理。
    if (event.type === "toolcall_end" && event.toolCall && typeof event.toolCall === "object") {
      decodeToolCallBlockByName(event.toolCall, aliasesByTool);
    }
    decodeMessageToolCalls(event.message, aliasesByTool);
  });
  return stream;
}

/** 在 runner 纠正工具名、提升文本工具调用之后，按最终工具名还原 Gemini 保留字参数别名。 */
export function wrapStreamFnDecodeToolArgumentAliases(baseFn: StreamFn): StreamFn {
  return (model, context, options) => {
    // 别名表登记在传输层生成的请求体上；onPayload 是每层包装器都会原样往下传的回调，
    // 传输层调用它时传入的正是那个请求体。不是 openai-completions 的请求体查不到，整层就是空操作。
    let aliasesByTool: AliasesByTool | undefined;
    const onPayload = options?.onPayload;
    const nextOptions = {
      ...options,
      onPayload: (payload: unknown, payloadModel: Parameters<NonNullable<typeof onPayload>>[1]) => {
        if (payload && typeof payload === "object") {
          aliasesByTool = getCompletionsToolArgumentAliases(payload) ?? aliasesByTool;
        }
        return onPayload?.(payload, payloadModel);
      },
    } as typeof options;
    const maybeStream = baseFn(model, context, nextOptions);
    const readAliases = () => aliasesByTool;
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        wrapStream(stream as MutableAssistantMessageEventStream, readAliases),
      );
    }
    return wrapStream(maybeStream as MutableAssistantMessageEventStream, readAliases);
  };
}

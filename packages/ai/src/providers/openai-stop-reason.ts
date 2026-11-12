import type { StopReason } from "../types.js";

export type OpenAIStopReasonResult = {
  stopReason: StopReason;
  errorMessage?: string;
};

export function mapOpenAIStopReason(
  reason: string | null,
  options?: { allowSingularToolCall?: boolean },
): OpenAIStopReasonResult {
  if (reason === null) {
    return { stopReason: "stop" };
  }

  switch (reason) {
    case "stop":
    case "end":
      return { stopReason: "stop" };
    case "length":
      return { stopReason: "length" };
    case "function_call":
    case "tool_calls":
      return { stopReason: "toolUse" };
    case "tool_call":
      if (options?.allowSingularToolCall) {
        return { stopReason: "toolUse" };
      }
      break;
    case "content_filter":
      return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
    case "network_error":
      return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" };
  }

  return {
    stopReason: "error",
    errorMessage: `Provider finish_reason: ${reason}`,
  };
}

/**
 * 按 chat completions 的 choice 映射结束原因，并保留 OpenRouter 的 native_finish_reason。
 * OpenRouter 把厂家原始原因（如 Gemini 的 MALFORMED_FUNCTION_CALL）放在 native_finish_reason，
 * 统一后的 finish_reason 只剩 "error"。拼进错误信息后，日志才看得出真因，failover 也能据此判断
 * 「同样请求必然再失败，不要同型号重试」（ADR-0033 任务 150）。
 */
export function mapOpenAIChoiceStopReason(
  choice: { finish_reason: string | null; native_finish_reason?: unknown },
  options?: { allowSingularToolCall?: boolean },
): OpenAIStopReasonResult {
  const result = mapOpenAIStopReason(choice.finish_reason, options);
  const native = choice.native_finish_reason;
  if (
    !result.errorMessage ||
    typeof native !== "string" ||
    // 远端字段原样进日志和错误信息：只收常见的枚举形态，防止换行或超长内容污染日志。
    !/^[A-Za-z0-9_.-]{1,64}$/.test(native) ||
    native === choice.finish_reason
  ) {
    return result;
  }
  return { ...result, errorMessage: `${result.errorMessage} (native_finish_reason: ${native})` };
}

/**
 * 流式 SSE 下跨多个 chunk 累积 choice 的 finish_reason 与 native_finish_reason：
 * OpenRouter 开启 include_usage 时，常在结束块带 `{ finish_reason: "error", native_finish_reason: "MALFORMED_FUNCTION_CALL" }`，
 * 随后在末尾 usage 块重复 `{ finish_reason: "error" }`（不含 native_finish_reason），或把两个字段拆在相邻块里。
 * 逐块独立映射会把已拿到的 native_finish_reason 覆盖回裸 `Provider finish_reason: error` 或漏掉。
 */
export function createOpenAIChoiceStopReasonTracker(allowSingularToolCall = false) {
  let finishReason: string | null = null;
  let nativeFinishReason: unknown;
  return (
    choice: { finish_reason?: string | null; native_finish_reason?: unknown },
    output: { stopReason: StopReason; errorMessage?: string },
  ): StopReason | undefined => {
    const hasFinish = typeof choice.finish_reason === "string" && choice.finish_reason.length > 0;
    const hasNative =
      typeof choice.native_finish_reason === "string" && choice.native_finish_reason.length > 0;
    if (hasFinish) {
      if (finishReason !== null && finishReason !== choice.finish_reason && !hasNative) {
        nativeFinishReason = undefined;
      }
      finishReason = choice.finish_reason ?? null;
    }
    if (hasNative) {
      nativeFinishReason = choice.native_finish_reason;
    }
    if (!finishReason || (!hasFinish && !hasNative)) {
      return undefined;
    }
    const result = mapOpenAIChoiceStopReason(
      { finish_reason: finishReason, native_finish_reason: nativeFinishReason },
      { allowSingularToolCall },
    );
    output.stopReason = result.stopReason;
    if (result.errorMessage) {
      output.errorMessage = result.errorMessage;
    } else {
      delete output.errorMessage;
    }
    return result.stopReason;
  };
}

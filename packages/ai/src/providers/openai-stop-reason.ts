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
    native.length === 0 ||
    native === choice.finish_reason
  ) {
    return result;
  }
  return { ...result, errorMessage: `${result.errorMessage} (native_finish_reason: ${native})` };
}

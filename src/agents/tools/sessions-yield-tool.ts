import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const SessionsYieldToolSchema = Type.Object({
  message: Type.Optional(Type.String()),
});

export function createSessionsYieldTool(opts?: {
  sessionId?: string;
  onYield?: (message: string) => Promise<void> | void;
  /**
   * 死锁守卫（Yuiclaw 团队编排）：在真正挂起前调用。返回非 null 的字符串表示「本轮 spawn 全败、
   * 无活跃子代理，挂起必死锁」，此时拒绝 yield、把该文案作为错误回传模型；返回 null 表示放行（原行为）。
   * 见 subagent-yield-guard.ts。
   */
  guardDeadlockYield?: () => string | null;
}): AnyAgentTool {
  return {
    label: "Yield",
    name: "sessions_yield",
    description:
      "End your current turn. Use after spawning subagents to receive their results as the next message.",
    parameters: SessionsYieldToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const message = readStringParam(params, "message") || "Turn yielded.";
      if (!opts?.sessionId) {
        return jsonResult({ status: "error", error: "No session context" });
      }
      if (!opts?.onYield) {
        return jsonResult({ status: "error", error: "Yield not supported in this context" });
      }
      // 死锁守卫：本轮 spawn 全败且无活跃子代理时拒绝挂起。关键是【不调用 onYield】——
      // onYield 才会触发 runAbortController.abort("sessions_yield") + 落 yield 上下文把会话钉进挂起态。
      // 直接返回 error tool result，引擎的串行工具循环会把它喂回模型，模型可用真实 agentId 重试或直接作答。
      const refusal = opts.guardDeadlockYield?.();
      if (refusal) {
        return jsonResult({ status: "error", error: refusal });
      }
      await opts.onYield(message);
      return jsonResult({ status: "yielded", message });
    },
  };
}

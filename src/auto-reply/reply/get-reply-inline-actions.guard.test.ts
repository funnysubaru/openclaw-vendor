// src/auto-reply/reply/get-reply-inline-actions.guard.test.ts
//
// 单测：shouldClearAbortGuardForInbound 判定函数。
//
// 业务意图：abort 闸的解除只应由真实用户消息触发，子 agent announce 注入
// （inter_session）和系统注入（internal_system）不得解除，避免内部管道
// 误将已 abort 的 controller 会话重新激活。
//
// 未标注 provenance（裸入站）= 来自外部渠道、没有经过 inter_session/internal_system
// 标注的消息，视同 external_user 处理。

import { describe, it, expect } from "vitest";
import { shouldClearAbortGuardForInbound } from "./get-reply-inline-actions.js";

describe("shouldClearAbortGuardForInbound", () => {
  it("clears for external_user", () => {
    // 外部用户正常发消息，应解除 abort 闸恢复正常
    expect(shouldClearAbortGuardForInbound({ kind: "external_user" })).toBe(true);
  });

  it("clears for untagged inbound (no provenance)", () => {
    // 裸入站：没有 provenance 标注，默认视为用户主动发消息
    expect(shouldClearAbortGuardForInbound(undefined)).toBe(true);
  });

  it("does NOT clear for inter_session (subagent announce)", () => {
    // 子 agent announce 注入：不解除，避免 controller 被自我再生循环重激活
    expect(shouldClearAbortGuardForInbound({ kind: "inter_session" })).toBe(false);
  });

  it("does NOT clear for internal_system", () => {
    // 系统内部注入：不解除，非用户主动行为
    expect(shouldClearAbortGuardForInbound({ kind: "internal_system" })).toBe(false);
  });
});

// src/agents/subagent-spawn.guard.test.ts
//
// Task 4 TDD 测试：验证 spawnSubagentDirect 在父(controller)会话处于 abort 态时，
// 返回 no-op 成功壳（不建子 agent、不报 error、不带 childSessionKey/runId）。
//
// 业务背景：
//   拦截①（announce 层）已切断 orchestrator 唤醒路径；但 orchestrator 可能已在跑
//   并尝试 spawn 新子 agent。本闸（拦截②）兜住这条残留路径：检测到父会话 abort 态
//   就直接返回 no-op accepted 壳，不建子 agent，orchestrator 不会傻等一个永不完成的子。
//
// 重要：no-op 壳不带 childSessionKey → orchestrator 没有 expected 子可追踪，不会傻等。
// 这与正常成功路径（带 childSessionKey + runId）明显区分，安全可用。
//
// mock 说明：
//   abort 闸在函数体最前面（比所有现有闸早），走 abort 分支时不触达重型运行时模块。
//   但 ESM 顶层 import 在模块加载时就执行，需要 mock 那些有顶层副作用的依赖，
//   以防 import 阶段抛错（参照 subagent-spawn.attachments.test.ts 的 mock 集合）。

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------- vi.hoisted：在 vi.mock 工厂执行前先创建 mock 函数实例 ----------
const { isSessionAborted } = vi.hoisted(() => ({
  isSessionAborted: vi.fn(() => false),
}));

// ---------- mock session-abort-guard（abort 态查标） ----------
vi.mock("./session-abort-guard.js", () => ({
  isSessionAborted,
  markSessionAborted: vi.fn(),
  noteDroppedAnnounce: vi.fn(),
  clearSessionAbort: vi.fn(),
  __testing: { reset: vi.fn() },
}));

// ---------- mock config（loadConfig 在函数体内被调用以传给 isSessionAborted） ----------
vi.mock("../config/config.js", () => ({
  loadConfig: () => ({
    session: { mainKey: "main", scope: "per-sender" },
  }),
}));

// ---------- 以下 mock 用于阻断 import 阶段的重型副作用 ----------
// （参照 subagent-spawn.attachments.test.ts，这些依赖在 ESM 加载时有顶层执行）

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(),
}));

vi.mock("./subagent-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent-registry.js")>();
  return {
    ...actual,
    countActiveRunsForSession: () => 0,
    registerSubagentRun: () => {},
  };
});

vi.mock("./subagent-announce.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent-announce.js")>();
  return {
    ...actual,
    buildSubagentSystemPrompt: () => "system-prompt",
  };
});

vi.mock("./subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: () => 0,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({ hasHooks: () => false }),
}));

// mock openclaw-tools 本身，阻断它在 import 阶段对 sessions-spawn-tool.ts 的顶层副作用
// （sessions-spawn-tool 在 typebox.ts 的 optionalStringEnum 调用时会抛错，因为 Type.StringEnum
//  被调用时 values 参数不可迭代——可能是 TDZ 或 Type mock 缺失问题）
vi.mock("./openclaw-tools.js", () => ({
  createOpenClawTools: vi.fn(() => []),
}));

import { spawnSubagentDirect } from "./subagent-spawn.js";

describe("spawnSubagentDirect abort guard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a no-op shell (no child) when parent session is aborted", async () => {
    // 模拟父(controller)会话处于 abort 态
    isSessionAborted.mockReturnValueOnce(true);

    const res = await spawnSubagentDirect(
      { task: "analyze NVDA" } as never,
      { agentSessionKey: "agent:orch-1:user:u:panel" } as never,
    );

    // 核心断言：
    // 1. status=accepted → 不报 error，orchestrator 不会重试或认为 spawn 失败
    // 2. childSessionKey=undefined → orchestrator 没有 expected 子可追踪，不会傻等
    // 3. runId=undefined → 同上，无 run 追踪
    // 4. error=undefined → 明确成功壳，不触发错误处理路径
    // 5. note 含 "abort" → 可观察性：日志/调试可识别这是 abort 路径返回
    expect(res.status).toBe("accepted");
    expect(res.childSessionKey).toBeUndefined();
    expect(res.runId).toBeUndefined();
    expect(res.error).toBeUndefined();
    expect(res.note).toMatch(/abort/i);
  });
});

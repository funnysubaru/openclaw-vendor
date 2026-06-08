import { describe, expect, it } from "vitest";
import {
  buildDeadlockYieldRefusalMessage,
  createTurnSpawnTally,
  recordSpawnOutcome,
  shouldRefuseDeadlockYield,
} from "./subagent-yield-guard.js";

// 业务背景：团队 orchestrator 一轮里"派活(sessions_spawn) + 挂起(sessions_yield)等结果"。
// 若本轮所有 spawn 都被引擎拒(如 agentId 非法)，子代理一个都没建出来，yield 仍把会话钉在挂起态
// → 永远没人唤醒 → 死锁。本模块判定这种"空挂起"。窄 guard：三判据全满足才拒。

describe("subagent yield deadlock guard", () => {
  describe("shouldRefuseDeadlockYield", () => {
    it("拒绝：本轮发起过 spawn、无一成功、且当前无活跃子代理", () => {
      expect(
        shouldRefuseDeadlockYield({ spawnAttempted: 3, spawnSucceeded: 0, activeSubagents: 0 }),
      ).toBe(true);
    });

    it("放行：纯空 yield（本轮没发起过 spawn）—— 不属于本次修复范围", () => {
      expect(
        shouldRefuseDeadlockYield({ spawnAttempted: 0, spawnSucceeded: 0, activeSubagents: 0 }),
      ).toBe(false);
    });

    it("放行：本轮有 spawn 成功（哪怕只有一个）", () => {
      expect(
        shouldRefuseDeadlockYield({ spawnAttempted: 3, spawnSucceeded: 1, activeSubagents: 1 }),
      ).toBe(false);
    });

    it("放行：本轮 spawn 全败，但前轮子代理仍在跑（有真实唤醒源，不能误杀）", () => {
      expect(
        shouldRefuseDeadlockYield({ spawnAttempted: 1, spawnSucceeded: 0, activeSubagents: 2 }),
      ).toBe(false);
    });
  });

  describe("recordSpawnOutcome / createTurnSpawnTally", () => {
    it("成功结算：attempted +1、succeeded +1、不收错误", () => {
      const tally = createTurnSpawnTally();
      recordSpawnOutcome(tally, { ok: true });
      expect(tally).toEqual({ attempted: 1, succeeded: 1, errors: [] });
    });

    it("失败结算：attempted +1、succeeded 不变、收录错误文案", () => {
      const tally = createTurnSpawnTally();
      recordSpawnOutcome(tally, {
        ok: false,
        error: "agentId is not allowed for sessions_spawn (allowed: x)",
      });
      expect(tally).toEqual({
        attempted: 1,
        succeeded: 0,
        errors: ["agentId is not allowed for sessions_spawn (allowed: x)"],
      });
    });

    it("失败但无 error 文案：attempted +1，errors 收兜底文案（保证拒绝时有可操作细节）", () => {
      const tally = createTurnSpawnTally();
      recordSpawnOutcome(tally, { ok: false });
      expect(tally).toEqual({
        attempted: 1,
        succeeded: 0,
        errors: ["sessions_spawn failed (no detail)"],
      });
    });

    it("多次混合结算累计正确", () => {
      const tally = createTurnSpawnTally();
      recordSpawnOutcome(tally, { ok: false, error: "e1" });
      recordSpawnOutcome(tally, { ok: false, error: "e2" });
      recordSpawnOutcome(tally, { ok: true });
      expect(tally).toEqual({ attempted: 3, succeeded: 1, errors: ["e1", "e2"] });
    });
  });

  describe("buildDeadlockYieldRefusalMessage", () => {
    it("把本轮 spawn 失败原因拼进回传文案，引导模型用真实 agentId 重试", () => {
      const msg = buildDeadlockYieldRefusalMessage([
        "agentId is not allowed (allowed: stock-analyst-bdcc7cf0)",
      ]);
      expect(msg).toContain("sessions_yield refused");
      expect(msg).toContain("agentId is not allowed (allowed: stock-analyst-bdcc7cf0)");
    });

    it("无错误明细时仍给出可操作指引", () => {
      const msg = buildDeadlockYieldRefusalMessage([]);
      expect(msg).toContain("sessions_yield refused");
      expect(msg.length).toBeGreaterThan(0);
    });
  });
});

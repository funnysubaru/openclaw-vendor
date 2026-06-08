import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";
import {
  callGatewayMock,
  resetSubagentsConfigOverride,
  setSubagentsConfigOverride,
} from "./openclaw-tools.subagents.test-harness.js";
import { addSubagentRunForTests, resetSubagentRegistryForTests } from "./subagent-registry.js";
import "./test-helpers/fast-core-tools.js";
import { createPerSenderSessionConfig } from "./test-helpers/session-config.js";
import type { AnyAgentTool } from "./tools/common.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./tools/sessions-helpers.js";

// 死锁守卫的【确定性复现】集成测试 —— 用真实 createOpenClawTools 工具集，真正执行 sessions_spawn
// (填非法 agentId → 引擎在 allowlist 处拒，不碰 gateway) 再执行 sessions_yield，端到端验证接线：
// per-attempt tally 在两个工具间共享、session-key 解析、countActiveRunsForSession 实时查活跃子代理。
//
// 背景见 subagent-yield-guard.ts：orchestrator 本轮 spawn 全败、无活跃子代理时，旧行为会让 yield
// 把会话钉进永等挂起态 → 死锁；修复后 yield 在工具边界被拒、原因回传模型让其用真实 id 重试。
//
// 注：harness 的 vi.mock(config/gateway) 由 vitest 自动 hoist，静态 import 工具模块即生效（同 scope 测试）。

function getTool(tools: AnyAgentTool[], name: string): AnyAgentTool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`tool ${name} not found`);
  }
  return tool;
}

function writeStore(storePath: string, store: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
}

describe("openclaw-tools: sessions_yield deadlock guard (integration)", () => {
  let storePath = "";
  let config: Parameters<typeof setSubagentsConfigOverride>[0];

  beforeEach(() => {
    resetSubagentRegistryForTests();
    resetSubagentsConfigOverride();
    callGatewayMock.mockReset();
    storePath = path.join(
      os.tmpdir(),
      `openclaw-yield-guard-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );
    config = {
      session: createPerSenderSessionConfig({ store: storePath }),
    } as Parameters<typeof setSubagentsConfigOverride>[0];
    setSubagentsConfigOverride(config);
    writeStore(storePath, {});
  });

  it("核心复现：本轮 spawn 全败 + 无活跃子代理 → yield 被拒、onYield 绝不触发", async () => {
    const onYield = vi.fn();
    const tools = createOpenClawTools({
      agentSessionKey: "agent:main:main",
      sessionId: "test-session",
      config,
      onYield,
    });
    const spawn = getTool(tools, "sessions_spawn");
    const yieldTool = getTool(tools, "sessions_yield");

    // 1) orchestrator(agent:main:main) 用模板名而非真实带哈希 id 派活 → 跨 agent 且不在 allowAgents
    //    → 引擎在 allowlist 处直接拒（forbidden），不触发 gateway。
    const spawnResult = await spawn.execute("call-spawn", {
      task: "analyze the stock",
      agentId: "stock-analyst-agent-id",
    });
    expect(spawnResult.details).toMatchObject({ status: "forbidden" });
    expect(callGatewayMock).not.toHaveBeenCalled();

    // 2) 紧接着 yield：旧行为会挂起永等；修复后守卫拒绝、回传 spawn 错误、不调 onYield。
    const yieldResult = await yieldTool.execute("call-yield", { message: "waiting for analysts" });
    expect(yieldResult.details).toMatchObject({ status: "error" });
    expect((yieldResult.details as { error?: string }).error).toContain("sessions_yield refused");
    expect(onYield).not.toHaveBeenCalled();
  });

  it("对照：前轮子代理仍在跑（有真实唤醒源）→ 本轮 spawn 失败也照常 yield，不误杀", async () => {
    // 注册一个属于本 orchestrator、未结束（active）的子代理，模拟「上一轮 spawn 成功、还在干活」。
    const { mainKey, alias } = resolveMainSessionAlias(config);
    const internalKey = resolveInternalSessionKey({ key: "agent:main:main", alias, mainKey });
    addSubagentRunForTests({
      runId: "run-prior-child",
      childSessionKey: "agent:main:subagent:prior",
      controllerSessionKey: internalKey,
      requesterSessionKey: internalKey,
      requesterDisplayKey: "main",
      task: "still running",
      cleanup: "keep",
      createdAt: Date.now() - 10_000,
      startedAt: Date.now() - 10_000,
      // 无 endedAt → 仍活跃，是合法的唤醒源
    });

    const onYield = vi.fn();
    const tools = createOpenClawTools({
      agentSessionKey: "agent:main:main",
      sessionId: "test-session",
      config,
      onYield,
    });
    const spawn = getTool(tools, "sessions_spawn");
    const yieldTool = getTool(tools, "sessions_yield");

    const spawnResult = await spawn.execute("call-spawn", {
      task: "analyze",
      agentId: "stock-analyst-agent-id",
    });
    expect(spawnResult.details).toMatchObject({ status: "forbidden" });

    // activeSubagents>0 → 守卫放行，照常挂起等那个还在跑的子代理。
    const yieldResult = await yieldTool.execute("call-yield", {});
    expect(yieldResult.details).toMatchObject({ status: "yielded" });
    expect(onYield).toHaveBeenCalledOnce();
  });

  it("参数校验失败的 spawn 也算本轮失败尝试 → 随后 yield 同样被拒（[中] early-return tally）", async () => {
    const onYield = vi.fn();
    const tools = createOpenClawTools({
      agentSessionKey: "agent:main:main",
      sessionId: "test-session",
      config,
      onYield,
    });
    const spawn = getTool(tools, "sessions_spawn");
    const yieldTool = getTool(tools, "sessions_yield");

    // streamTo 只对 runtime=acp 合法；这里 runtime 默认 subagent → 在 spawnSubagentDirect 之前 early-return error。
    // 这仍是「本轮发起过一次 spawn 且失败」，必须计入 tally，否则随后 yield 会被当纯空 yield 放行 → 仍可能死锁。
    const spawnResult = await spawn.execute("call-spawn", {
      task: "x",
      agentId: "stock-analyst-bdcc7cf0",
      streamTo: "parent",
    });
    expect(spawnResult.details).toMatchObject({ status: "error" });

    const yieldResult = await yieldTool.execute("call-yield", {});
    expect(yieldResult.details).toMatchObject({ status: "error" });
    expect((yieldResult.details as { error?: string }).error).toContain("sessions_yield refused");
    expect(onYield).not.toHaveBeenCalled();
  });

  it("对照：纯空 yield（本轮没发起过 spawn）照常挂起，不属于本次保护范围", async () => {
    const onYield = vi.fn();
    const tools = createOpenClawTools({
      agentSessionKey: "agent:main:main",
      sessionId: "test-session",
      config,
      onYield,
    });
    const yieldTool = getTool(tools, "sessions_yield");

    const yieldResult = await yieldTool.execute("call-yield", {});
    expect(yieldResult.details).toMatchObject({ status: "yielded" });
    expect(onYield).toHaveBeenCalledOnce();
  });
});

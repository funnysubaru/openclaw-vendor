import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import { SsrFBlockedError } from "../infra/net/ssrf.js";

const enqueueSystemEventMock = vi.fn();
const requestHeartbeatNowMock = vi.fn();
const loadConfigMock = vi.fn();
const fetchWithSsrFGuardMock = vi.fn();
const runCronIsolatedAgentTurnMock = vi.fn();
// PR #41 follow-up review (#3)：捕获 cronLogger.warn 让 divergence 测试能断言
// "warn 日志被打出"（之前测试只看传参,删掉 warn 块也照样绿）。
// 用 vi.hoisted 让 vi.mock 的工厂能引用到这些 mock（vi.mock 在文件顶部被提升，
// 早于 const 初始化）。
const { cronWarnMock, cronInfoMock, cronErrorMock, cronDebugMock } = vi.hoisted(() => ({
  cronWarnMock: vi.fn(),
  cronInfoMock: vi.fn(),
  cronErrorMock: vi.fn(),
  cronDebugMock: vi.fn(),
}));

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
}));

vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow: (...args: unknown[]) => requestHeartbeatNowMock(...args),
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: () => loadConfigMock(),
  };
});

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
}));

// Mock runCronIsolatedAgentTurn 让 isolated job 路径在测试里不真的拉 agent runtime,
// 仅断言传入的 agentId / sessionKey 与 divergence 行为 (PR #40 follow-up review Medium 3)。
vi.mock("../cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: (...args: unknown[]) => runCronIsolatedAgentTurnMock(...args),
}));

// PR #41 follow-up review (#3)：mock getChildLogger 返回 vi.fn(),让 divergence 测试能
// 断言 warn 真的被调用 (不只是断言传给 runCronIsolatedAgentTurn 的参数)。
vi.mock("../logging.js", async () => {
  const actual = await vi.importActual<typeof import("../logging.js")>("../logging.js");
  return {
    ...actual,
    getChildLogger: () => ({
      warn: cronWarnMock,
      info: cronInfoMock,
      error: cronErrorMock,
      debug: cronDebugMock,
    }),
  };
});

import { buildGatewayCronService } from "./server-cron.js";

describe("buildGatewayCronService", () => {
  beforeEach(() => {
    enqueueSystemEventMock.mockClear();
    requestHeartbeatNowMock.mockClear();
    loadConfigMock.mockClear();
    fetchWithSsrFGuardMock.mockClear();
    runCronIsolatedAgentTurnMock.mockClear();
    runCronIsolatedAgentTurnMock.mockResolvedValue({ ok: true });
    cronWarnMock.mockClear();
    cronInfoMock.mockClear();
    cronErrorMock.mockClear();
    cronDebugMock.mockClear();
  });

  it("routes main-target jobs to the scoped session for enqueue + wake", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-${Date.now()}`);
    const cfg = {
      session: {
        mainKey: "main",
      },
      cron: {
        store: path.join(tmpDir, "cron.json"),
      },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "canonicalize-session-key",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        sessionKey: "discord:channel:ops",
        payload: { kind: "systemEvent", text: "hello" },
      });

      await state.cron.run(job.id, "force");

      expect(enqueueSystemEventMock).toHaveBeenCalledWith(
        "hello",
        expect.objectContaining({
          sessionKey: "agent:main:discord:channel:ops",
        }),
      );
      expect(requestHeartbeatNowMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:discord:channel:ops",
        }),
      );
    } finally {
      state.cron.stop();
    }
  });

  it("preserves the requested agentId even when not in cfg.agents.list (no silent main fallback)", async () => {
    // Medium 2 (PR #39 review)：resolveCronAgent 移除 hasAgent 检查后，
    // host (Yuiclaw) 把 SOUL/IDENTITY 写在 ~/.openclaw/agents/<id>/ 目录但未同步到
    // openclaw.json.agents.list 的动态 agent (custom-* / orch-*) 不再被静默兜底成 main。
    // 这条用例锁定该行为：cfg.agents.list 为空时，jobCreate.agentId 仍被原样保留并用于
    // session key 派生。
    const tmpDir = path.join(os.tmpdir(), `server-cron-ghost-${Date.now()}`);
    const cfg = {
      session: { mainKey: "main" },
      // 故意不配置 agents.list —— 模拟 Yuiclaw 动态 agent 未同步到 openclaw.json 的情况
      cron: { store: path.join(tmpDir, "cron.json") },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      // 用 systemEvent + sessionTarget:isolated 来观察 resolveCronAgent 的取值——
      // sessionTarget:main 会被 cron.add 层 (assertMainSessionAgentId) 提前拒绝
      // "main 仅默认 agent 可用"，触达不到 resolveCronAgent。
      const job = await state.cron.add({
        name: "ghost-agent-job",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        agentId: "custom-cbd0fe4a", // 不在 cfg.agents.list 里
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "ping" },
      });

      // 关键断言：job 实际落库后 job.agentId 原样保留 custom-cbd0fe4a（resolveCronAgent
      // 不再把它兜底成 main）。这是 Yuiclaw 5/14 12:07 Ralph Lauren cron 跑错 agent 的
      // 根因修复对应的断言。
      expect(job.agentId).toBe("custom-cbd0fe4a");
    } finally {
      state.cron.stop();
    }
  });

  it("falls back to default main agent only when no agentId is requested", async () => {
    // Medium 2 (PR #39 review) 配对用例：requested agentId 缺省 (undefined/empty/whitespace) 才
    // 走 resolveDefaultAgentId → main，避免回归。
    const tmpDir = path.join(os.tmpdir(), `server-cron-default-${Date.now()}`);
    const cfg = {
      session: { mainKey: "main" },
      cron: { store: path.join(tmpDir, "cron.json") },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "default-main-job",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        // agentId 留空 → resolveDefaultAgentId 兜底 main
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        sessionKey: "discord:channel:ops",
        payload: { kind: "systemEvent", text: "ping" },
      });

      await state.cron.run(job.id, "force");

      expect(enqueueSystemEventMock).toHaveBeenCalledWith(
        "ping",
        expect.objectContaining({
          sessionKey: "agent:main:discord:channel:ops",
        }),
      );
    } finally {
      state.cron.stop();
    }
  });

  // PR #40 follow-up review Medium 3 —— handler 集成测：isolated agent turn 用
  // sessionKey 嵌入的 agentId 跑、divergence 时 log warning。
  describe("runIsolatedAgentJob agentId / sessionKey divergence", () => {
    it("uses sessionKey-embedded agentId when job.agentId differs (sessionKey 是真相之源)", async () => {
      const tmpDir = path.join(os.tmpdir(), `server-cron-divergence-${Date.now()}`);
      const cfg = {
        session: { mainKey: "main" },
        cron: { store: path.join(tmpDir, "cron.json") },
      } as OpenClawConfig;
      loadConfigMock.mockReturnValue(cfg);

      const state = buildGatewayCronService({
        cfg,
        deps: {} as CliDeps,
        broadcast: () => {},
      });
      try {
        // job.agentId = "main" 但 sessionKey 指向 custom-cbd0fe4a → divergence。
        // 修复后 runCronIsolatedAgentTurn 应收到 agentId="custom-cbd0fe4a"（sessionKey 嵌入），
        // 而不是 "main"。
        const job = await state.cron.add({
          name: "divergence-job",
          enabled: true,
          schedule: { kind: "at", at: new Date(1).toISOString() },
          agentId: "main",
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          sessionKey: "agent:custom-cbd0fe4a:user:abc:panel-xyz",
          payload: { kind: "agentTurn", message: "ping" },
        });

        await state.cron.run(job.id, "force");

        expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledOnce();
        const [callArgs] = runCronIsolatedAgentTurnMock.mock.calls[0];
        // sessionKey 嵌入的 agentId（custom-cbd0fe4a）压倒 job.agentId（main）
        expect(callArgs.agentId).toBe("custom-cbd0fe4a");
        // sessionKey 透传给运行,canonical lowercase
        expect(callArgs.sessionKey).toBe("agent:custom-cbd0fe4a:user:abc:panel-xyz");

        // PR #43 follow-up review (#1)：按内容断言而非"调用次数",防止 cron.run 路径
        // 同时打出别的 warn (如过期 schedule / failure / run log) 让测试假阳。
        // 之后有人删掉 divergence warn 块,这条 toHaveBeenCalledWith 仍会红。
        expect(cronWarnMock).toHaveBeenCalledWith(
          expect.stringContaining("differs from sessionKey-embedded agentId"),
          expect.objectContaining({
            jobId: job.id,
            jobAgentId: "main",
            sessionKeyAgentId: "custom-cbd0fe4a",
            sessionKey: "agent:custom-cbd0fe4a:user:abc:panel-xyz",
          }),
        );
      } finally {
        state.cron.stop();
      }
    });

    it("uses job.agentId verbatim when sessionKey is not canonical agent: prefix", async () => {
      const tmpDir = path.join(os.tmpdir(), `server-cron-no-divergence-${Date.now()}`);
      const cfg = {
        session: { mainKey: "main" },
        cron: { store: path.join(tmpDir, "cron.json") },
      } as OpenClawConfig;
      loadConfigMock.mockReturnValue(cfg);

      const state = buildGatewayCronService({
        cfg,
        deps: {} as CliDeps,
        broadcast: () => {},
      });
      try {
        const job = await state.cron.add({
          name: "no-divergence-job",
          enabled: true,
          schedule: { kind: "at", at: new Date(1).toISOString() },
          agentId: "custom-cbd0fe4a",
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          // 不设 sessionKey,vendor 会用 cron:<jobId> 派生
          payload: { kind: "agentTurn", message: "ping" },
        });

        await state.cron.run(job.id, "force");

        expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledOnce();
        const [callArgs] = runCronIsolatedAgentTurnMock.mock.calls[0];
        expect(callArgs.agentId).toBe("custom-cbd0fe4a");
        expect(callArgs.sessionKey).toBe(`cron:${job.id}`);

        // 非 canonical sessionKey 走 cron:<jobId> 派生 —— **不** 应该 log divergence
        // warning。按内容断言以容忍同路径里的其它无关 warn (PR #43 follow-up review #1)。
        expect(cronWarnMock).not.toHaveBeenCalledWith(
          expect.stringContaining("differs from sessionKey-embedded agentId"),
          expect.anything(),
        );
      } finally {
        state.cron.stop();
      }
    });
  });

  it("blocks private webhook URLs via SSRF-guarded fetch", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-ssrf-${Date.now()}`);
    const cfg = {
      session: {
        mainKey: "main",
      },
      cron: {
        store: path.join(tmpDir, "cron.json"),
      },
    } as OpenClawConfig;

    loadConfigMock.mockReturnValue(cfg);
    fetchWithSsrFGuardMock.mockRejectedValue(
      new SsrFBlockedError("Blocked: resolves to private/internal/special-use IP address"),
    );

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "ssrf-webhook-blocked",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello" },
        delivery: {
          mode: "webhook",
          to: "http://127.0.0.1:8080/cron-finished",
        },
      });

      await state.cron.run(job.id, "force");

      expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
        url: "http://127.0.0.1:8080/cron-finished",
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: expect.stringContaining('"action":"finished"'),
          signal: expect.any(AbortSignal),
        },
      });
    } finally {
      state.cron.stop();
    }
  });
});

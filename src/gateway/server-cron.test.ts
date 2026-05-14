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

import { buildGatewayCronService } from "./server-cron.js";

describe("buildGatewayCronService", () => {
  beforeEach(() => {
    enqueueSystemEventMock.mockClear();
    requestHeartbeatNowMock.mockClear();
    loadConfigMock.mockClear();
    fetchWithSsrFGuardMock.mockClear();
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

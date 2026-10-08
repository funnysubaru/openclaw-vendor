// ADR-0033 任务84(c) 方案 B 回归：员工库后台启动准入未完成时，请求在入口透明等待，
// 而不是撞上同步开库入口的可重试错误；等待能被关闭 / 热重启打断，失败的员工立即返回
// 同一原因。走真实分发层 handleGatewayRequest + 真实 handler + 真实临时 SQLite。
import type { ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { scheduleBackgroundSessionStartupMigration } from "../config/sessions/startup-migration.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import * as integrityWorker from "../infra/sqlite-integrity-worker.js";
import {
  cancelAgentStartupAdmission,
  resetAgentStartupAdmissionForTest,
  scheduleAgentStartupAdmission,
  waitForAgentStartupAdmission,
} from "../state/agent-startup-admission.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { RespondFn } from "./server-methods/types.js";
import { GatewayRequestEntryLifetime } from "./server-request-entry.js";
import { runWithGatewayHttpWorkAdmission } from "./server/http-work-admission.js";

afterEach(() => {
  resetAgentStartupAdmissionForTest();
});

const cfg = { agents: { entries: { main: {} } } } satisfies OpenClawConfig;
const scope = { agentId: "main", sessionKey: "agent:main:main", sessionId: "main-1" };

/** 准入里的 open 阶段卡在 gate 上，但会响应调度器 abort（模拟真实工作在关闭时收尾）。 */
function scheduleGatedAdmission(agentIds: string[], options: { narrow?: boolean } = {}) {
  const gate = createDeferred<void>();
  scheduleAgentStartupAdmission({
    agentIds,
    openAgent: async (_agentId, signal) => await racePromiseWithAbortSignal(gate.promise, signal),
    migrateAgent: async () => {},
    narrowRequestsToAgent: options.narrow,
  });
  return gate;
}

function dispatch(
  method: string,
  params: Record<string, unknown>,
  context = createDirectChatContext({ getRuntimeConfig: () => cfg }),
) {
  const respond = vi.fn<RespondFn>();
  const request = handleGatewayRequest({
    req: { type: "req", id: `startup-admission-${method}`, method, params },
    respond,
    client: { connect: { scopes: ["operator.admin"] } } as never,
    isWebchatConnect: () => false,
    context,
  });
  return { request, respond };
}

async function tick(ms = 20) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("gateway request entry waits for agent startup admission", () => {
  it.each([
    ["sessions.list", {}],
    ["chat.history", { sessionKey: scope.sessionKey }],
    ["sessions.usage", { key: scope.sessionKey }],
  ] as const)("%s 在准入进行中发出 → 等待后正常返回", async (method, params) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await state.writeConfig(cfg);
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const gate = scheduleGatedAdmission(["main"]);
      try {
        const { request, respond } = dispatch(method, params);
        // 给足时间让"不等待"的实现跑完整个 handler（这些 handler 冷启动要几百毫秒），
        // 确认请求是真被挡住，而不是只是还没跑到 respond。
        await Promise.race([request, tick(3_000)]);
        expect(respond).not.toHaveBeenCalled();

        gate.resolve();
        await request;
        expect(respond).toHaveBeenCalledOnce();
        expect(respond.mock.calls[0]?.[0]).toBe(true);
      } finally {
        gate.resolve();
        await cancelAgentStartupAdmission();
      }
    });
  });

  it("等待中触发 cancel（关闭 / 热重启）→ 请求立即以可重试 UNAVAILABLE 结束，cancel 不卡", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await state.writeConfig(cfg);
      scheduleGatedAdmission(["main"]);
      const { request, respond } = dispatch("sessions.list", {});
      await tick();
      expect(respond).not.toHaveBeenCalled();

      await cancelAgentStartupAdmission();
      await request;
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
      );
    });
  });

  it("关闭前奏关掉请求入口租约 → 等待中的请求立即结束，入口排空不必等准入", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await state.writeConfig(cfg);
      const gate = scheduleGatedAdmission(["main"]);
      const requestEntryLifetime = new GatewayRequestEntryLifetime();
      try {
        const { request, respond } = dispatch(
          "sessions.list",
          {},
          createDirectChatContext({ getRuntimeConfig: () => cfg, requestEntryLifetime }),
        );
        await tick();
        expect(respond).not.toHaveBeenCalled();

        requestEntryLifetime.beginClose();
        await request;
        await requestEntryLifetime.waitForPendingEntries();
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
        );
      } finally {
        gate.resolve();
        await cancelAgentStartupAdmission();
      }
    });
  });

  it("目标员工准入已失败 → 立即返回同一失败原因，不陪其它员工等", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await state.writeConfig(cfg);
      scheduleAgentStartupAdmission({
        agentIds: ["main"],
        openAgent: async () => {
          throw new Error("main integrity failed");
        },
        migrateAgent: async () => {},
        // 每员工默认库布局（调度方证明了逻辑员工 = 物理 owner）才允许按员工收窄。
        narrowRequestsToAgent: true,
      });
      const otherGate = scheduleGatedAdmission(["ops"], { narrow: true });
      try {
        await tick();
        const { request, respond } = dispatch("chat.history", { sessionKey: scope.sessionKey });
        await request;
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: "UNAVAILABLE",
            retryable: false,
            message: expect.stringContaining("main integrity failed"),
          }),
        );
      } finally {
        otherGate.resolve();
        await cancelAgentStartupAdmission();
      }
    });
  });

  it("HTTP 用户路由在准入进行中先等待，cancel 时返回 503", async () => {
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn(),
      req: { socket: {} },
    } as unknown as ServerResponse;
    const gate = scheduleGatedAdmission(["main"]);
    const run = vi.fn(async () => true);
    const waited = runWithGatewayHttpWorkAdmission(res, run);
    await tick();
    expect(run).not.toHaveBeenCalled();
    gate.resolve();
    await waited;
    expect(run).toHaveBeenCalledOnce();

    scheduleGatedAdmission(["ops"]);
    const cancelled = runWithGatewayHttpWorkAdmission(res, run);
    await tick();
    await cancelAgentStartupAdmission();
    await expect(cancelled).resolves.toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(503);
  });

  it("免等白名单：心跳方法 last-heartbeat 在准入中立即返回，白名单外的方法仍等待", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await state.writeConfig(cfg);
      const gate = scheduleGatedAdmission(["main"]);
      try {
        const heartbeat = dispatch("last-heartbeat", {});
        const presence = dispatch("system-presence", {});
        await Promise.race([heartbeat.request, tick(2_000)]);
        expect(heartbeat.respond).toHaveBeenCalledOnce();
        expect(heartbeat.respond.mock.calls[0]?.[0]).toBe(true);
        // 白名单外（即便同样只读内存）也照常等待：防止白名单被写成全放行。
        await Promise.race([presence.request, tick(500)]);
        expect(presence.respond).not.toHaveBeenCalled();

        gate.resolve();
        await presence.request;
        expect(presence.respond.mock.calls[0]?.[0]).toBe(true);
      } finally {
        gate.resolve();
        await cancelAgentStartupAdmission();
      }
    });
  });

  // review2 P2-1：准入按数据库物理 owner 登记。共享库里 agent:ops:shared 的会话存在 main
  // 的库里，main 准入中时请求必须等 main，而不是只看逻辑员工 ops。走真实目标解析和真实
  // 后台迁移调度（完整性检查卡住让 main 停在准入的 open 阶段）。
  it("共享库：按物理 owner 等待，main 准入完成前不读 ops 所在的共享库", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sharedCfg = {
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "main" } },
          entries: { main: {}, ops: {} },
        },
        session: { store: path.join(state.root, "custom", "shared.sqlite") },
      } satisfies OpenClawConfig;
      await state.writeConfig(sharedCfg);
      const sharedScope = {
        agentId: "ops",
        sessionKey: "agent:ops:shared",
        sessionId: "ops-shared",
        storePath: sharedCfg.session.store,
      };
      await upsertSessionEntryCore(sharedScope, { sessionId: sharedScope.sessionId, updatedAt: 1 });
      // 前置条件自证：这条会话的物理库 owner 是 main。
      expect(toDatabaseOptions(resolveSqliteReadScope(sharedScope)).agentId).toBe("main");
      closeOpenClawAgentDatabasesForTest();

      // 让 main 停在 open 阶段的完整性检查里（库此时是冷的，同步开库会撞兜底）。
      const workerEntered = createDeferred<void>();
      const releaseWorker = createDeferred<void>();
      const actualCheck = integrityWorker.assertSqliteIntegrityInWorker;
      vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker").mockImplementation(
        async (pathname, busyTimeoutMs, signal) => {
          workerEntered.resolve();
          await releaseWorker.promise;
          return await actualCheck(pathname, busyTimeoutMs, signal);
        },
      );
      await scheduleBackgroundSessionStartupMigration({
        cfg: { ...sharedCfg, session: { ...sharedCfg.session, mainKey: "work" } },
        log: { info: vi.fn(), warn: vi.fn() },
      });
      await workerEntered.promise;
      try {
        // sessions.list 的读取不经过同步开库兜底：修前它只看逻辑员工 ops（不在准入中）就直接
        // 读了 main 名下、仍在准入中的共享库。
        const { request, respond } = dispatch(
          "sessions.list",
          { agentId: "ops" },
          createDirectChatContext({ getRuntimeConfig: () => sharedCfg }),
        );
        await Promise.race([request, tick(2_000)]);
        expect(respond).not.toHaveBeenCalled();

        releaseWorker.resolve();
        await request;
        expect(respond).toHaveBeenCalledOnce();
        expect(respond.mock.calls[0]?.[0]).toBe(true);
      } finally {
        releaseWorker.resolve();
        vi.restoreAllMocks();
        await cancelAgentStartupAdmission();
      }
    });
  });

  // review3 / review4 P2：共享库 + ops 自有旧库同时存在。让 ops 旧库先完成、main（shared.sqlite）
  // 仍在准入时，ops 的共享库历史请求必须继续等 main。review4 的变体：ops 已从配置移出，但它在
  // 共享库里的历史会话仍可读（普通 agent:ops:... sessionKey 可达，未走员工删除流程）。
  async function expectOpsSharedHistoryWaitsForMain(params: { removeOpsFromConfig: boolean }) {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const store = path.join(state.root, "custom", "shared.sqlite");
      const withOpsCfg = {
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "main" } },
          entries: { main: {}, ops: {} },
        },
        session: { store },
      } satisfies OpenClawConfig;
      await state.writeConfig(withOpsCfg);
      const sharedScope = {
        agentId: "ops",
        sessionKey: "agent:ops:shared",
        sessionId: "ops-shared",
        storePath: store,
      };
      await upsertSessionEntryCore(sharedScope, { sessionId: sharedScope.sessionId, updatedAt: 1 });
      const sharedOptions = toDatabaseOptions(resolveSqliteReadScope(sharedScope));
      expect(sharedOptions.agentId).toBe("main");
      const sharedPath = resolveOpenClawAgentSqlitePath(sharedOptions);
      // ops 名下仍保留的默认旧库（真实文件）。
      const opsRetainedPath = openOpenClawAgentDatabase({ agentId: "ops" }).path;
      expect(opsRetainedPath).not.toBe(sharedPath);
      const scenarioCfg: OpenClawConfig = params.removeOpsFromConfig
        ? { ...withOpsCfg, agents: { ...withOpsCfg.agents, entries: { main: {} } } }
        : withOpsCfg;
      await state.writeConfig(scenarioCfg);
      // 准入前先正常请求一次：确认会话可读，同时让 chat.history 的惰性 handler 模块加载完，
      // 否则冷加载本身就要数秒，"窗口内没响应"会被误当成在等待。
      const warmup = dispatch(
        "chat.history",
        { sessionKey: sharedScope.sessionKey },
        createDirectChatContext({ getRuntimeConfig: () => scenarioCfg }),
      );
      await warmup.request;
      expect(warmup.respond.mock.calls[0]?.[0]).toBe(true);
      closeOpenClawAgentDatabasesForTest();

      // 只卡住 shared.sqlite 的完整性检查，让 ops 旧库先完成准入。
      const releaseShared = createDeferred<void>();
      const actualCheck = integrityWorker.assertSqliteIntegrityInWorker;
      vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker").mockImplementation(
        async (pathname, busyTimeoutMs, signal) => {
          if (pathname === sharedPath) {
            await releaseShared.promise;
          }
          return await actualCheck(pathname, busyTimeoutMs, signal);
        },
      );
      await scheduleBackgroundSessionStartupMigration({
        cfg: { ...scenarioCfg, session: { ...scenarioCfg.session, mainKey: "work" } },
        log: { info: vi.fn(), warn: vi.fn() },
      });
      try {
        await waitForAgentStartupAdmission("ops");
        expect(waitForAgentStartupAdmission("main")).toBeDefined();

        const { request, respond } = dispatch(
          "chat.history",
          { sessionKey: sharedScope.sessionKey },
          createDirectChatContext({ getRuntimeConfig: () => scenarioCfg }),
        );
        let early: unknown;
        await Promise.race([request, tick(2_000)]).catch((error: unknown) => {
          early = error;
        });
        expect(early).toBeUndefined();
        expect(respond).not.toHaveBeenCalled();

        releaseShared.resolve();
        await request;
        expect(respond).toHaveBeenCalledOnce();
        expect(respond.mock.calls[0]?.[0]).toBe(true);
      } finally {
        releaseShared.resolve();
        vi.restoreAllMocks();
        await cancelAgentStartupAdmission();
      }
    });
  }

  it("共享库 + ops 自有旧库：ops 旧库先完成时，ops 的共享库历史请求仍等 main", async () => {
    await expectOpsSharedHistoryWaitsForMain({ removeOpsFromConfig: false });
  });

  it("ops 已移出配置 + 共享库历史 + 自有旧库：历史请求仍等 main", async () => {
    await expectOpsSharedHistoryWaitsForMain({ removeOpsFromConfig: true });
  });

  // 收口规则的正向检查：最常见的每员工默认库布局下，调度方能证明逻辑员工 = 物理 owner，
  // 仍按员工收窄——ops 还在准入时，main 的请求不陪着等（防止证明函数恒为 false、悄悄退化）。
  it("每员工默认库布局：按员工收窄，ops 准入中 main 的请求不等", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const perAgentCfg = {
        agents: { ownership: "explicit", entries: { main: {}, ops: {} } },
      } satisfies OpenClawConfig;
      await state.writeConfig(perAgentCfg);
      for (const agentId of ["main", "ops"]) {
        await upsertSessionEntryCore(
          { agentId, sessionKey: `agent:${agentId}:main`, sessionId: `${agentId}-1` },
          { sessionId: `${agentId}-1`, updatedAt: 1 },
        );
      }
      const opsPath = openOpenClawAgentDatabase({ agentId: "ops" }).path;
      const warmup = dispatch(
        "chat.history",
        { sessionKey: "agent:main:main" },
        createDirectChatContext({ getRuntimeConfig: () => perAgentCfg }),
      );
      await warmup.request;
      expect(warmup.respond.mock.calls[0]?.[0]).toBe(true);
      closeOpenClawAgentDatabasesForTest();

      const releaseOps = createDeferred<void>();
      const actualCheck = integrityWorker.assertSqliteIntegrityInWorker;
      vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker").mockImplementation(
        async (pathname, busyTimeoutMs, signal) => {
          if (pathname === opsPath) {
            await releaseOps.promise;
          }
          return await actualCheck(pathname, busyTimeoutMs, signal);
        },
      );
      await scheduleBackgroundSessionStartupMigration({
        cfg: { ...perAgentCfg, session: { mainKey: "work" } },
        log: { info: vi.fn(), warn: vi.fn() },
      });
      try {
        await waitForAgentStartupAdmission("main");
        expect(waitForAgentStartupAdmission("ops")).toBeDefined();
        const { request, respond } = dispatch(
          "chat.history",
          { sessionKey: "agent:main:main" },
          createDirectChatContext({ getRuntimeConfig: () => perAgentCfg }),
        );
        await Promise.race([request, tick(2_000)]);
        expect(respond).toHaveBeenCalledOnce();
        expect(respond.mock.calls[0]?.[0]).toBe(true);
      } finally {
        releaseOps.resolve();
        vi.restoreAllMocks();
        await cancelAgentStartupAdmission();
      }
    });
  });

  // 请求参数指向两个不同员工（agentId 是 main、会话键却是 ops 的）时不收窄：只等 main 会漏掉
  // 真正要读的 ops 库。用一个记录调用时刻的测试方法观察分发层是否放行。
  it("参数里出现多个员工时不收窄，等全部在途准入", async () => {
    const gate = scheduleGatedAdmission(["ops"], { narrow: true });
    scheduleAgentStartupAdmission({
      agentIds: ["main"],
      openAgent: async () => {},
      migrateAgent: async () => {},
      narrowRequestsToAgent: true,
    });
    try {
      await waitForAgentStartupAdmission("main");
      const invoked = vi.fn();
      const respond = vi.fn<RespondFn>();
      const request = handleGatewayRequest({
        req: {
          type: "req",
          id: "mixed-agents",
          method: "test.mixed-agents",
          params: { agentId: "main", target: { sessionKey: "agent:ops:main" } },
        },
        respond,
        client: { connect: { scopes: ["operator.admin"] } } as never,
        isWebchatConnect: () => false,
        context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
        extraHandlers: {
          "test.mixed-agents": ({ respond: reply }) => {
            invoked();
            reply(true, {}, undefined);
          },
        },
      });
      await Promise.race([request, tick(300)]);
      expect(invoked).not.toHaveBeenCalled();

      gate.resolve();
      await request;
      expect(invoked).toHaveBeenCalledOnce();
    } finally {
      gate.resolve();
      await cancelAgentStartupAdmission();
    }
  });
});

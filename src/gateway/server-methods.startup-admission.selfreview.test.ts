// PR #132 独立审查（selfreview）发现的问题的回归测试：A1/A2（P2-2 参数线索带偏收窄）、
// A3/W3（P2-3 同步兜底错误的协议形态）、U2/U3（P2-1 关停打不断进行中的准入）。U1 是观察项，
// 只记录现状（启动孤儿会话标记会等准入），不改行为。
// 写法仿照 server-methods.startup-admission.test.ts：真实分发层 + 真实 handler + 真实临时 SQLite
// + 真实后台迁移调度，只用 gate 卡住某个库的完整性 worker。
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { markStartupOrphanedMainSessionsForRecovery } from "../agents/main-session-recovery/main-session-restart-recovery-marking.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { scheduleBackgroundSessionStartupMigration } from "../config/sessions/startup-migration.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as integrityWorker from "../infra/sqlite-integrity-worker.js";
import {
  cancelAgentStartupAdmission,
  resetAgentStartupAdmissionForTest,
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
import {
  runStartupSessionMigration,
  scheduleBackgroundStartupSessionMigration,
} from "./server-startup-session-migration.js";

afterEach(() => {
  resetAgentStartupAdmissionForTest();
});

function dispatch(
  method: string,
  params: Record<string, unknown>,
  cfg: OpenClawConfig,
  extraHandlers?: Parameters<typeof handleGatewayRequest>[0]["extraHandlers"],
) {
  const respond = vi.fn<RespondFn>();
  const request = handleGatewayRequest({
    req: { type: "req", id: `selfreview-${method}`, method, params },
    respond,
    client: { connect: { scopes: ["operator.admin"] } } as never,
    isWebchatConnect: () => false,
    context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
    ...(extraHandlers ? { extraHandlers } : {}),
  });
  return { request, respond };
}

async function tick(ms = 20) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 每员工默认库（S1，收窄证明成立）：main / ops 各一个会话；只卡住 gatedAgent 的完整性检查。 */
async function withPerAgentLayoutGated(
  gatedAgent: "main" | "ops",
  run: (cfg: OpenClawConfig, releaseGate: () => void) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = {
      // 多员工时无前缀键需要兼容 owner：非 explicit 归属 + 恰好一个 default:true（旧版 agents 配置形态）。
      agents: { entries: { main: { default: true }, ops: {} } },
      // 运行期与调度用同一份 mainKey；库里的 session_key_contract 仍是建库时的 "main"，
      // 所以准入 open 阶段会真实地设置 mainKey 并触发完整性检查（与现有回归同一手法）。
      session: { mainKey: "work" },
    } satisfies OpenClawConfig;
    await state.writeConfig(cfg);
    for (const agentId of ["main", "ops"]) {
      await upsertSessionEntryCore(
        { agentId, sessionKey: `agent:${agentId}:chat1`, sessionId: `${agentId}-1` },
        { sessionId: `${agentId}-1`, updatedAt: 1 },
      );
    }
    const gatedPath = openOpenClawAgentDatabase({ agentId: gatedAgent }).path;
    // 预热：确认请求在准入前能正常完成，并加载惰性 handler 模块。
    const warm = dispatch("sessions.preview", { keys: ["chat1", "agent:ops:chat1"] }, cfg);
    await warm.request;
    console.log("[warm]", JSON.stringify(warm.respond.mock.calls[0]));
    expect(warm.respond.mock.calls[0]?.[0]).toBe(true);
    expect(
      (
        warm.respond.mock.calls[0]?.[1] as { previews: { status: string }[] } | undefined
      )?.previews.map((p) => p.status),
    ).toEqual(["empty", "empty"]);
    closeOpenClawAgentDatabasesForTest();

    const release = createDeferred<void>();
    const actualCheck = integrityWorker.assertSqliteIntegrityInWorker;
    vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker").mockImplementation(
      async (pathname, busyTimeoutMs, signal) => {
        if (pathname === gatedPath) {
          await release.promise;
        }
        return await actualCheck(pathname, busyTimeoutMs, signal);
      },
    );
    // 与运行期同一份配置（不改 mainKey）：冷库在 handoff 的 reconcile 开库时触发完整性检查。
    await scheduleBackgroundSessionStartupMigration({
      cfg,
      log: { info: vi.fn(), warn: vi.fn() },
    });
    const other = gatedAgent === "main" ? "ops" : "main";
    try {
      await waitForAgentStartupAdmission(other);
      expect(waitForAgentStartupAdmission(gatedAgent)).toBeDefined();
      await run(cfg, () => release.resolve());
    } finally {
      release.resolve();
      vi.restoreAllMocks();
      await cancelAgentStartupAdmission();
    }
  });
}

describe("PR #132 selfreview repro", () => {
  // 缺陷 A：参数里"恰好一个"带前缀的员工线索就收窄，但请求真正的目标可能是无前缀键（默认员工）。
  // keys = ["main", "agent:ops:main"]：扫描只看到 ops → 收窄到 ops；"main" 实际解析为默认员工 main，
  // main 仍在准入中。期望：请求等 main 准入完成（或等全部），两条预览都正常。
  it("A1 sessions.preview：无前缀键 + 另一员工前缀键 → 不收窄到 ops，等 main 准入完成", async () => {
    let inWindow: unknown;
    let afterAdmission: unknown;
    await withPerAgentLayoutGated("main", async (cfg, releaseGate) => {
      const { request, respond } = dispatch(
        "sessions.preview",
        { keys: ["chat1", "agent:ops:chat1"] },
        cfg,
      );
      await Promise.race([request, tick(2_000)]);
      inWindow = respond.mock.calls[0] ?? "still-waiting";
      releaseGate();
      await request;
      await waitForAgentStartupAdmission("main");
      const again = dispatch("sessions.preview", { keys: ["chat1", "agent:ops:chat1"] }, cfg);
      await again.request;
      afterAdmission = again.respond.mock.calls[0];
    });
    console.log("[A1] respond-in-window:", JSON.stringify(inWindow));
    console.log("[A1] respond-after-admission:", JSON.stringify(afterAdmission));
    // 期望：窗口内请求应等待（不应已回包），或至少不应把 main 的预览报成 error。
    expect(inWindow).toBe("still-waiting");
  });

  // A3：薄弱点 2 的兜底形态——请求被收窄到 ops，handler 内部同步开 main 的库（跨员工读），
  // 撞上 AgentStartupAdmissionPendingError。修前 handleGatewayRequest 直接 reject，外层
  // authenticated-request-dispatch 转成不带 retryable 的 UNAVAILABLE 并记 error 日志。
  it("A3 收窄到 ops 的请求在 handler 内同步读 main → 回可重试的 UNAVAILABLE", async () => {
    await withPerAgentLayoutGated("main", async (cfg) => {
      // chat.history 声明了按 sessionKey 收窄；这里借它的名字注册一个会跨员工读库的测试 handler。
      const { request, respond } = dispatch(
        "chat.history",
        { sessionKey: "agent:ops:chat1" },
        cfg,
        {
          "chat.history": ({ respond: reply }) => {
            openOpenClawAgentDatabase({ agentId: "main" });
            reply(true, {}, undefined);
          },
        },
      );
      const outcome = await Promise.race([
        request.then(
          () => "resolved",
          (error: unknown) => `rejected: ${String(error)}`,
        ),
        tick(2_000).then(() => "still-waiting"),
      ]);
      console.log(
        "[A3] outcome:",
        outcome,
        "respond:",
        JSON.stringify(respond.mock.calls[0] ?? null),
      );
      // 收窄后 handler 内跨员工同步读库撞上兜底：由分发层集中分类成可重试的 UNAVAILABLE 回包，
      // 不再原样抛出（外层会转成不可重试并记 error 日志）。
      expect(outcome).toBe("resolved");
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
      );
    });
  });

  // A2：同一机制在分发层的最小形态——目标字段是无前缀键，另一个自由文本字段恰好长得像会话键。
  it("A2 分发层：sessionKey 无前缀 + 文本字段含 agent:ops:… → main 准入完成前不进 handler", async () => {
    await withPerAgentLayoutGated("main", async (cfg) => {
      const invoked = vi.fn();
      const { request } = dispatch(
        "test.bare-key",
        { sessionKey: "chat1", message: "agent:ops:chat1 帮我看看这个会话" },
        cfg,
        {
          "test.bare-key": ({ respond: reply }) => {
            invoked();
            reply(true, {}, undefined);
          },
        },
      );
      await Promise.race([request, tick(500)]);
      console.log("[A2] handler invoked while main pending:", invoked.mock.calls.length);
      expect(invoked).not.toHaveBeenCalled();
    });
  });

  // 薄弱点 3 观察：共享库布局（等待全部），共享库 owner main 准入失败后，ops 的共享库请求怎么结束。
  it("W3 等全部模式：共享库 owner 准入失败 → ops 请求回不可重试的 UNAVAILABLE（同一原因）", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const store = path.join(state.root, "custom", "shared.sqlite");
      const sharedCfg = {
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "main" } },
          entries: { main: {}, ops: {} },
        },
        session: { store },
      } satisfies OpenClawConfig;
      await state.writeConfig(sharedCfg);
      const sharedScope = {
        agentId: "ops",
        sessionKey: "agent:ops:shared",
        sessionId: "ops-shared",
        storePath: store,
      };
      await upsertSessionEntryCore(sharedScope, { sessionId: sharedScope.sessionId, updatedAt: 1 });
      const sharedPath = resolveOpenClawAgentSqlitePath(
        toDatabaseOptions(resolveSqliteReadScope(sharedScope)),
      );
      const warm = dispatch("chat.history", { sessionKey: sharedScope.sessionKey }, sharedCfg);
      await warm.request;
      expect(warm.respond.mock.calls[0]?.[0]).toBe(true);
      closeOpenClawAgentDatabasesForTest();

      vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker").mockImplementation(
        async (pathname) => {
          if (pathname === sharedPath) {
            throw new Error("shared integrity failed");
          }
        },
      );
      await scheduleBackgroundSessionStartupMigration({
        cfg: { ...sharedCfg, session: { ...sharedCfg.session, mainKey: "work" } },
        log: { info: vi.fn(), warn: vi.fn() },
      });
      try {
        const settled = waitForAgentStartupAdmission("main");
        console.log("[W3] main wait:", settled === undefined ? "undefined" : "promise");
        await settled?.catch((error: unknown) => console.log("[W3] main failed:", String(error)));
        const { request, respond } = dispatch(
          "chat.history",
          { sessionKey: sharedScope.sessionKey },
          sharedCfg,
        );
        let rejected: unknown;
        await request.catch((error: unknown) => {
          rejected = error;
        });
        console.log("[W3] handleGatewayRequest rejected:", String(rejected));
        console.log("[W3] respond calls:", JSON.stringify(respond.mock.calls));
        // 等全部模式下共享库 owner 准入失败：handler 内同步开库撞上兜底，由分发层集中分类成
        // 不可重试的 UNAVAILABLE（失败原因原样），不再原样抛出、不记 error 日志。
        expect(rejected).toBeUndefined();
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: "UNAVAILABLE",
            retryable: false,
            message: expect.stringContaining("shared integrity failed"),
          }),
        );
      } finally {
        vi.restoreAllMocks();
        await cancelAgentStartupAdmission();
      }
    });
  });

  // 未接 helper 的启动后台任务：上次生命周期中断的 running 会话要在 post-attach 阶段（监听之后、
  // 渠道启动之前）被标记为待恢复。准入期间它对还在准入的员工库怎么表现？
  it("U1（观察，记录现状）启动孤儿会话标记会等准入完成，恢复语义不丢", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = {
        agents: { ownership: "explicit", entries: { main: {}, ops: {} } },
        session: { mainKey: "work" },
      } satisfies OpenClawConfig;
      await state.writeConfig(cfg);
      const target = { agentId: "main", sessionKey: "agent:main:chat1", sessionId: "main-run" };
      await upsertSessionEntryCore(target, {
        sessionId: target.sessionId,
        updatedAt: Date.now() - 10_000,
        status: "running",
      });
      await upsertSessionEntryCore(
        { agentId: "ops", sessionKey: "agent:ops:chat1", sessionId: "ops-1" },
        { sessionId: "ops-1", updatedAt: 1 },
      );
      const mainPath = openOpenClawAgentDatabase({ agentId: "main" }).path;
      closeOpenClawAgentDatabasesForTest();
      const release = createDeferred<void>();
      const actualCheck = integrityWorker.assertSqliteIntegrityInWorker;
      vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker").mockImplementation(
        async (pathname, busyTimeoutMs, signal) => {
          if (pathname === mainPath) {
            await release.promise;
          }
          return await actualCheck(pathname, busyTimeoutMs, signal);
        },
      );
      await scheduleBackgroundSessionStartupMigration({
        cfg,
        log: { info: vi.fn(), warn: vi.fn() },
      });
      try {
        await waitForAgentStartupAdmission("ops");
        expect(waitForAgentStartupAdmission("main")).toBeDefined();
        const startedAt = Date.now();
        const marking = markStartupOrphanedMainSessionsForRecovery({
          cfg,
          startupCheckedStorePaths: new Set<string>(),
        }).then(
          (value) => ({ kind: "resolved" as const, value }),
          (error: unknown) => ({ kind: "threw" as const, error: String(error) }),
        );
        const inWindow = await Promise.race([
          marking,
          tick(2_000).then(() => ({ kind: "blocked" as const })),
        ]);
        console.log("[U1] marking in admission window:", JSON.stringify(inWindow));
        release.resolve();
        const final = await marking;
        console.log(
          "[U1] marking final:",
          JSON.stringify(final),
          "elapsedMs=",
          Date.now() - startedAt,
        );
        console.log(
          "[U1] main entry abortedLastRun after:",
          loadSessionEntry(target)?.abortedLastRun,
        );
        // 观察项，只记录现状（owner 尚未决定是否改）：标记会等 main 准入完成（窗口内 blocked），
        // 但恢复语义不丢——准入完成后照常标记、abortedLastRun=true。
        expect(inWindow.kind).toBe("blocked");
        expect(final).toEqual({ kind: "resolved", value: expect.anything() });
        expect(loadSessionEntry(target)?.abortedLastRun).toBe(true);
      } finally {
        release.resolve();
        vi.restoreAllMocks();
        await cancelAgentStartupAdmission();
      }
    });
  });

  // 关停顺序：准入 open 阶段正在跑完整性检查时 gateway 关闭。mock 的检查与真实 worker 一样会响应
  // 传进来的 abort signal——看调度器 cancel 能否打断它，还是只能干等检查自然结束。
  it("U2 cancelAgentStartupAdmission 立即打断 open 阶段进行中的完整性检查", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = {
        agents: { ownership: "explicit", entries: { main: {} } },
        session: { mainKey: "work" },
      } satisfies OpenClawConfig;
      await state.writeConfig(cfg);
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:chat1", sessionId: "main-1" },
        { sessionId: "main-1", updatedAt: 1 },
      );
      const mainPath = openOpenClawAgentDatabase({ agentId: "main" }).path;
      closeOpenClawAgentDatabasesForTest();
      const entered = createDeferred<void>();
      const slowCheckDone = createDeferred<void>();
      let checkAborted = false;
      vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker").mockImplementation(
        async (pathname, _busyTimeoutMs, signal) => {
          if (pathname !== mainPath) {
            return;
          }
          entered.resolve();
          // 模拟一个大库的慢检查：10 秒，或被 signal 打断。
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 10_000);
            signal?.addEventListener("abort", () => {
              checkAborted = true;
              clearTimeout(timer);
              reject(signal.reason);
            });
          });
          slowCheckDone.resolve();
        },
      );
      await scheduleBackgroundSessionStartupMigration({
        cfg,
        log: { info: vi.fn(), warn: vi.fn() },
      });
      await entered.promise;
      const startedAt = Date.now();
      const cancelled = cancelAgentStartupAdmission().then(() => "cancelled");
      const outcome = await Promise.race([cancelled, tick(2_000).then(() => "still-waiting")]);
      console.log("[U2] cancel within 2s:", outcome, "checkAborted=", checkAborted);
      await cancelled;
      console.log("[U2] cancel finished after ms:", Date.now() - startedAt);
      vi.restoreAllMocks();
      expect(outcome).toBe("cancelled");
      expect(checkAborted).toBe(true);
    });
  }, 30_000);

  // P2-1 的 migrate 阶段：库已登记且 mainKey 已是当前值时 open 阶段跳过开库，冷库在 handoff
  // （真实 reconcileSessionTranscriptIndexes → runProjectionWrite）里才开、才做完整性检查。
  // cancel 也必须立即打断这一步，而不是等检查自然跑完。
  it("U3 cancel 立即打断 migrate 阶段（handoff reconcile 开库）进行中的完整性检查", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = {
        agents: { ownership: "explicit", entries: { main: {} } },
      } satisfies OpenClawConfig;
      await state.writeConfig(cfg);
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:chat1", sessionId: "main-1" },
        { sessionId: "main-1", updatedAt: 1 },
      );
      const mainPath = openOpenClawAgentDatabase({ agentId: "main" }).path;
      closeOpenClawAgentDatabasesForTest();
      // 先跑一遍阻塞版：登记库并写入当前 mainKey，之后 open 阶段会跳过开库。
      await runStartupSessionMigration({ cfg, log: { info: vi.fn(), warn: vi.fn() } });
      closeOpenClawAgentDatabasesForTest();

      const entered = createDeferred<void>();
      let checkAborted = false;
      vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker").mockImplementation(
        async (pathname, _busyTimeoutMs, signal) => {
          if (pathname !== mainPath) {
            return;
          }
          entered.resolve();
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 10_000);
            signal?.addEventListener("abort", () => {
              checkAborted = true;
              clearTimeout(timer);
              reject(signal.reason);
            });
          });
        },
      );
      await scheduleBackgroundStartupSessionMigration({
        cfg,
        log: { info: vi.fn(), warn: vi.fn() },
      });
      await entered.promise;
      const cancelled = cancelAgentStartupAdmission().then(() => "cancelled");
      const outcome = await Promise.race([cancelled, tick(2_000).then(() => "still-waiting")]);
      await cancelled;
      vi.restoreAllMocks();
      expect(outcome).toBe("cancelled");
      expect(checkAborted).toBe(true);
    });
  }, 30_000);
});

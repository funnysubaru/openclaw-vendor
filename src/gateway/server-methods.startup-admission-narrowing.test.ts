// 后台启动准入窗口内，收窄分发的边界与同步兜底的错误分类（PR #132 审查项 A1 / A3 / W3 / P4）：
// - A1：参数线索带偏收窄——无前缀键（默认员工）+ 别的员工前缀键，不能收窄到后者；
// - A3 / W3：handler 内同步开库撞上兜底，由分发层分类成可重试（准入中）/ 不可重试（已失败）的
//   UNAVAILABLE，不原样抛出；
// - P4：收窄的一轮里跨员工写（OAuth 刷新栅栏）先透明等对方准入。
// 写法仿照 server-methods.startup-admission.test.ts：真实分发层 + 真实 handler + 真实临时 SQLite
// + 真实后台迁移调度，只用 gate 卡住某个库的完整性 worker。
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import { createOAuthRefreshFence } from "../agents/auth-profiles/oauth-refresh-marker.js";
import { fenceOAuthRefreshPeers } from "../agents/auth-profiles/oauth-refresh-peers.js";
import { resolveAuthProfileDatabasePath } from "../agents/auth-profiles/sqlite.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
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
    req: { type: "req", id: `narrowing-${method}`, method, params },
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

describe("准入窗口内的收窄分发与错误分类", () => {
  // 审查项 A1：参数里"恰好一个"带前缀的员工线索就收窄，但请求真正的目标可能是无前缀键（默认员工）。
  // keys = ["main", "agent:ops:main"]：扫描只看到 ops → 收窄到 ops；"main" 实际解析为默认员工 main，
  // main 仍在准入中。期望：请求等 main 准入完成（或等全部），两条预览都正常。
  it("sessions.preview 同时给无前缀键和别的员工前缀键：不收窄到 ops，等 main 准入完成", async () => {
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
    // 窗口内请求应等待（不应已回包），准入完成后两条预览都正常。
    expect(inWindow).toBe("still-waiting");
    expect((afterAdmission as unknown[] | undefined)?.[0]).toBe(true);
  });

  // 审查项 A3：兜底形态——请求被收窄到 ops，handler 内部同步开 main 的库（跨员工读），
  // 撞上 AgentStartupAdmissionPendingError。修前 handleGatewayRequest 直接 reject，外层
  // authenticated-request-dispatch 转成不带 retryable 的 UNAVAILABLE 并记 error 日志。
  it("收窄到 ops 的请求在 handler 内同步读准入中的 main：回可重试的 UNAVAILABLE", async () => {
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

  // 审查项 W3：共享库布局（等待全部），共享库 owner main 准入失败后，ops 的共享库请求怎么结束。
  it("等全部模式下共享库 owner 准入失败：ops 的请求回不可重试的 UNAVAILABLE（同一原因）", async () => {
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
        await waitForAgentStartupAdmission("main")?.catch(() => {});
        const { request, respond } = dispatch(
          "chat.history",
          { sessionKey: sharedScope.sessionKey },
          sharedCfg,
        );
        let rejected: unknown;
        await request.catch((error: unknown) => {
          rejected = error;
        });
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

  // 审查探针 P4：运行期跨员工写。OAuth 刷新会给"持有同一凭据代际"的其它员工库写刷新栅栏
  // （fenceOAuthRefreshPeers → updateCandidateAuthProfileStore → 同步开库）。Yuiclaw 把同一订阅
  // 凭据广播进每个员工库，所以这条路径在默认布局下一定跨员工；收窄到 main 的入口在 ops 准入中
  // 触发刷新，必须先等 ops 准入，而不是撞上 ops 的同步兜底。
  it("收窄到 main 的请求里 OAuth 刷新要给准入中的 ops 写栅栏：透明等待 ops 准入后成功", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = {
        agents: { ownership: "explicit", entries: { main: {}, ops: {} } },
      } satisfies OpenClawConfig;
      await state.writeConfig(cfg);
      const profileId = "openai-codex:default";
      const original = {
        type: "oauth" as const,
        provider: "openai-codex",
        access: "expired-access",
        refresh: "refresh-token",
        expires: Date.now() - 60_000,
      };
      const agentDirs: Record<string, string> = {};
      // 先写 ops 再写 main：非 main 员工库只保存与共享库不同的副本，先写 ops 才会留下一份
      // "历史同代际副本"（上游 peer 模型；员工在共享凭据轮换前拷贝过凭据时就是这种状态）。
      for (const agentId of ["ops", "main"]) {
        await upsertSessionEntryCore(
          { agentId, sessionKey: `agent:${agentId}:chat1`, sessionId: `${agentId}-1` },
          { sessionId: `${agentId}-1`, updatedAt: 1 },
        );
        agentDirs[agentId] = path.resolve(resolveAgentDir(cfg, agentId));
        saveAuthProfileStore(
          { version: 1, profiles: { [profileId]: original } },
          agentDirs[agentId],
        );
      }
      const opsPath = openOpenClawAgentDatabase({ agentId: "ops" }).path;
      expect(resolveAuthProfileDatabasePath(agentDirs.ops!)).toBe(opsPath);
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
        cfg: { ...cfg, session: { mainKey: "work" } },
        log: { info: vi.fn(), warn: vi.fn() },
      });
      try {
        await waitForAgentStartupAdmission("main");
        expect(waitForAgentStartupAdmission("ops")).toBeDefined();
        const respond = vi.fn<RespondFn>();
        // 用已声明可收窄的 chat.history 名字承载"main 的一轮对话里触发 OAuth 刷新"，走真实收窄分发。
        const request = handleGatewayRequest({
          req: {
            type: "req",
            id: "p4",
            method: "chat.history",
            params: { sessionKey: "agent:main:chat1" },
          },
          respond,
          client: { connect: { scopes: ["operator.admin"] } } as never,
          isWebchatConnect: () => false,
          context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
          extraHandlers: {
            "chat.history": async ({ respond: reply }) => {
              const claims = await fenceOAuthRefreshPeers({
                cfg,
                ownerDatabasePath: resolveAuthProfileDatabasePath(agentDirs.main!),
                profileId,
                generation: original,
                fence: createOAuthRefreshFence({ profileId, credential: original }),
                rollbackOnFailure: false,
              });
              reply(true, { claims: claims.length }, undefined);
            },
          },
        });
        // ops 仍在准入：刷新给 ops 写栅栏前应透明等待，而不是撞同步兜底失败。
        await Promise.race([request, tick(1_000)]);
        expect(respond).not.toHaveBeenCalled();
        releaseOps.resolve();
        await request;
        // ops 准入完成后，刷新正常给 ops 写栅栏。
        expect(respond).toHaveBeenCalledWith(true, { claims: 1 }, undefined);
      } finally {
        releaseOps.resolve();
        await waitForAgentStartupAdmission("ops")?.catch(() => {});
        vi.restoreAllMocks();
        await cancelAgentStartupAdmission();
      }
    });
  }, 30_000);
});

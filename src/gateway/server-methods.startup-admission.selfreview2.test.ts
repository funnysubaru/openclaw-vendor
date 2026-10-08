// PR #132 第二轮独立审查（selfreview2）薄弱点 3：chat.send 能否加入按员工收窄的清单。
// 手法：每员工默认库布局（收窄证明成立）下卡住 ops 的准入，借已声明可收窄的方法名
// "chat.history" 注册一个直接调用真实 chat.send handler 的测试 handler（与 A3 同一手法），
// 让请求真实地走"收窄到 main"的分发路径；同时记录 handler 处理过程中经过准入闸门的员工。
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import { createOAuthRefreshFence } from "../agents/auth-profiles/oauth-refresh-marker.js";
import { fenceOAuthRefreshPeers } from "../agents/auth-profiles/oauth-refresh-peers.js";
import { resolveAuthProfileDatabasePath } from "../agents/auth-profiles/sqlite.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { scheduleBackgroundSessionStartupMigration } from "../config/sessions/startup-migration.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as integrityWorker from "../infra/sqlite-integrity-worker.js";
import * as admission from "../state/agent-startup-admission.js";
import {
  cancelAgentStartupAdmission,
  resetAgentStartupAdmissionForTest,
  waitForAgentStartupAdmission,
} from "../state/agent-startup-admission.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import { agentHandlers } from "./server-methods/agent.js";
import { chatHandlers } from "./server-methods/chat.js";
import type { RespondFn } from "./server-methods/types.js";

afterEach(() => {
  resetAgentStartupAdmissionForTest();
});

async function tick(ms = 20) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("PR #132 selfreview2 薄弱点 3：chat.send 收窄探针", () => {
  it.each([
    {
      name: "chat.send",
      handler: chatHandlers["chat.send"]!,
      params: { sessionKey: "agent:main:chat1", message: "hi", idempotencyKey: "p3-run" },
    },
    {
      name: "agent",
      handler: agentHandlers.agent!,
      params: {
        sessionKey: "agent:main:chat1",
        message: "hi",
        idempotencyKey: "p3-agent-run",
        bestEffortDeliver: false,
      },
    },
  ])(
    "P3 收窄到 main 的 $name 在 ops 准入中：handler 是否触碰 ops 的库闸门",
    async (probe) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const cfg = {
          agents: { ownership: "explicit", entries: { main: {}, ops: {} } },
        } satisfies OpenClawConfig;
        await state.writeConfig(cfg);
        for (const agentId of ["main", "ops"]) {
          await upsertSessionEntryCore(
            { agentId, sessionKey: `agent:${agentId}:chat1`, sessionId: `${agentId}-1` },
            { sessionId: `${agentId}-1`, updatedAt: 1 },
          );
        }
        const opsPath = openOpenClawAgentDatabase({ agentId: "ops" }).path;
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
        const gated: string[] = [];
        let inHandler = false;
        const realWait = admission.waitForAgentStartupAdmission;
        const realAssert = admission.assertAgentStartupAdmissionSettled;
        vi.spyOn(admission, "waitForAgentStartupAdmission").mockImplementation((agentId) => {
          if (inHandler) {
            gated.push(`async:${agentId}`);
          }
          return realWait(agentId);
        });
        vi.spyOn(admission, "assertAgentStartupAdmissionSettled").mockImplementation((agentId) => {
          if (inHandler) {
            gated.push(`sync:${agentId}`);
          }
          realAssert(agentId);
        });
        try {
          await realWait("main");
          expect(realWait("ops")).toBeDefined();
          const respond = vi.fn<RespondFn>();
          const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
          const request = handleGatewayRequest({
            req: {
              type: "req",
              id: "p3",
              method: "chat.history",
              params: probe.params,
            },
            respond,
            client: { connect: { scopes: ["operator.admin"] } } as never,
            isWebchatConnect: () => false,
            context,
            extraHandlers: {
              "chat.history": async (opts) => {
                inHandler = true;
                await probe.handler(opts as never);
              },
            },
          });
          const outcome = await Promise.race([
            request.then(
              () => "settled",
              (error: unknown) => `rejected: ${String(error)}`,
            ),
            tick(3_000).then(() => "still-waiting"),
          ]);
          const startedWait = Date.now();
          const late = await Promise.race([
            request.then(() => "settled-late"),
            tick(8_000).then(() => "still-blocked-after-11s"),
          ]);
          console.log(`[P3 ${probe.name}] late:`, late, Date.now() - startedWait, "ms");
          console.log(`[P3 ${probe.name}] outcome while ops pending:`, outcome);
          console.log(
            `[P3 ${probe.name}] respond:`,
            JSON.stringify(respond.mock.calls).slice(0, 600),
          );
          console.log(`[P3 ${probe.name}] gates touched in handler:`, JSON.stringify(gated));
          console.log(
            "[P3] logGateway.error:",
            JSON.stringify((context.logGateway.error as ReturnType<typeof vi.fn>).mock.calls).slice(
              0,
              600,
            ),
          );
          expect(gated.filter((entry) => entry.endsWith(":ops"))).toEqual([]);
        } finally {
          inHandler = false;
          releaseOps.resolve();
          await waitForAgentStartupAdmission("ops")?.catch(() => {});
          vi.restoreAllMocks();
          await cancelAgentStartupAdmission();
        }
      });
    },
    30_000,
  );
});

// 薄弱点 3 的反证：运行期的跨员工同步写。OAuth 刷新会给"持有同一凭据代际"的所有其它员工库写
// 刷新栅栏（fenceOAuthRefreshPeers → updateCandidateAuthProfileStore → runOpenClawAgentWriteTransaction
// → 同步开库）。Yuiclaw 把同一订阅凭据广播进每个员工库，所以这条路径在 Yuiclaw 默认布局下一定跨员工。
// 收窄到 main 的入口（渠道 / cron / heartbeat / 投递恢复 / 若加入清单的 chat.send、agent）在 ops
// 准入中触发刷新，就会撞上 ops 的同步兜底。
describe("PR #132 selfreview2 薄弱点 3：运行期跨员工同步写（OAuth 刷新栅栏）", () => {
  it("P4 每员工默认库布局、ops 准入中：main 的 OAuth 刷新给 ops 写栅栏 → 透明等待 ops 准入后成功", async () => {
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
              const { listCandidateAuthProfileStores, loadCandidateAuthProfileStore } =
                await import("../agents/auth-profiles/candidate-stores.js");
              for (const candidate of await listCandidateAuthProfileStores({ cfg })) {
                console.log(
                  "[P4] candidate",
                  candidate.agentId,
                  candidate.databasePath,
                  JSON.stringify(loadCandidateAuthProfileStore(candidate)?.profiles ?? null).slice(
                    0,
                    200,
                  ),
                );
              }
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
        console.log("[P4] respond:", JSON.stringify(respond.mock.calls));
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

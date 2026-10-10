// 停止已开始的对话（chat.abort）在别的员工还在后台启动准入时的分发策略（Yuiclaw #424 review P2）。
// 场景：每员工一库布局，main 已准入并在跑一轮对话，ops 还卡在完整性检查 / 迁移里。
// 修前 chat.abort 不在收窄清单里，分发层等全部员工准入：ops 放开之前 Stop 既不回包、main 的
// AbortController 也不 abort，面板（先乐观标成已停止、吞掉 RPC 失败）显示停了、模型和工具还在跑。
// 走真实分发层 handleGatewayRequest + 真实 chat.abort handler + 真实临时 SQLite + 真实后台迁移
// 调度，只用 gate 卡住 ops 库的完整性 worker。
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../agents/embedded-agent-runner/runs.test-support.js";
import { registerSubagentRun } from "../agents/subagents/registry/subagent-registry.js";
import { settleSubagentRegistryPersistenceWork } from "../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import {
  getSubagentRunByChildSessionKey,
  resetSubagentRegistryForTests,
  testing as subagentRegistryTesting,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { scheduleBackgroundSessionStartupMigration } from "../config/sessions/startup-migration.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { LegacyContextEngine } from "../context-engine/legacy.js";
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
import { createActiveRun } from "./server-methods/chat.abort.test-helpers.js";
import type { RespondFn } from "./server-methods/types.js";

afterEach(async () => {
  await settleSubagentRegistryPersistenceWork();
  resetSubagentRegistryForTests({ persist: false });
  subagentRegistryTesting.setDepsForTest();
  resetAgentStartupAdmissionForTest();
});

const MAIN_SESSION = "agent:main:chat1";
const RUN_ID = "main-run";
/** ops 准入挂起期间观察 Stop 的窗口（reviewer 复现用的是 750ms）。 */
const WINDOW_MS = 750;

async function tick(ms = 20) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function dispatch(
  method: string,
  params: Record<string, unknown>,
  context: ReturnType<typeof createDirectChatContext>,
) {
  const respond = vi.fn<RespondFn>();
  const request = handleGatewayRequest({
    req: { type: "req", id: `stop-${method}`, method, params },
    respond,
    client: { connect: { scopes: ["operator.admin"] } } as never,
    isWebchatConnect: () => false,
    context,
  });
  return { request, respond };
}

type Layout = "per-agent" | "shared";

/**
 * 搭好"main 已准入、ops 仍卡在完整性检查"的现场后执行 run。
 * - per-agent：每员工默认库（调度方能证明逻辑员工 = 物理 owner，收窄成立）；
 * - shared：main 与 ops 的会话都在 main 名下的共享库，ops 另有一个自有旧库（证明不成立，等全部）。
 * 两种布局都只卡 ops 自己的库，所以 main 的会话库在 run 开始时已经准入完成。
 */
async function withOpsAdmissionPending(
  layout: Layout,
  run: (env: {
    cfg: OpenClawConfig;
    releaseOps: () => void;
    context: ReturnType<typeof createDirectChatContext>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const store = path.join(state.root, "custom", "shared.sqlite");
    const cfg = (
      layout === "shared"
        ? {
            agents: {
              ownership: "explicit",
              defaults: { sessionStore: { agentId: "main" } },
              entries: { main: {}, ops: {} },
            },
            session: { store },
          }
        : { agents: { ownership: "explicit", entries: { main: {}, ops: {} } } }
    ) satisfies OpenClawConfig;
    await state.writeConfig(cfg);
    const storePath = layout === "shared" ? store : undefined;
    for (const [agentId, sessionKey, sessionId] of [
      ["main", MAIN_SESSION, "main-1"],
      ["ops", "agent:ops:chat1", "ops-1"],
      ["ops", "agent:ops:subagent:child", "child-1"],
    ] as const) {
      await upsertSessionEntryCore(
        { agentId, sessionKey, sessionId, ...(storePath ? { storePath } : {}) },
        { sessionId, updatedAt: 1 },
      );
    }
    // ops 自己的库：per-agent 下就是它的会话库；shared 下是它名下保留的默认旧库。
    const opsPath = openOpenClawAgentDatabase({ agentId: "ops" }).path;
    if (layout === "shared") {
      const sharedPath = resolveOpenClawAgentSqlitePath(
        toDatabaseOptions(
          resolveSqliteReadScope({ agentId: "main", sessionKey: MAIN_SESSION, storePath: store }),
        ),
      );
      expect(sharedPath).not.toBe(opsPath);
    }
    // 预热：让 chat.abort 的惰性 handler 模块在准入前加载完，否则冷加载本身要几秒，
    // "窗口内没回包"会被误当成在等准入。
    const warm = dispatch(
      "chat.abort",
      { sessionKey: MAIN_SESSION, runId: "warmup" },
      createDirectChatContext({ getRuntimeConfig: () => cfg }),
    );
    await warm.request;
    expect(warm.respond.mock.calls[0]?.[0]).toBe(true);
    closeOpenClawAgentDatabasesForTest();

    const release = createDeferred<void>();
    const actualCheck = integrityWorker.assertSqliteIntegrityInWorker;
    vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker").mockImplementation(
      async (pathname, busyTimeoutMs, signal) => {
        if (pathname === opsPath) {
          await release.promise;
        }
        return await actualCheck(pathname, busyTimeoutMs, signal);
      },
    );
    await scheduleBackgroundSessionStartupMigration({
      cfg: { ...cfg, session: { ...(storePath ? { store } : {}), mainKey: "work" } },
      log: { info: vi.fn(), warn: vi.fn() },
    });
    try {
      await waitForAgentStartupAdmission("main");
      expect(waitForAgentStartupAdmission("ops")).toBeDefined();
      await run({
        cfg,
        releaseOps: () => release.resolve(),
        context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
      });
    } finally {
      release.resolve();
      await waitForAgentStartupAdmission("ops")?.catch(() => {});
      vi.restoreAllMocks();
      await cancelAgentStartupAdmission();
    }
  });
}

describe("Stop（chat.abort）与员工库后台启动准入", () => {
  // reviewer 的复现：main 的一轮已经在跑（AbortController 已登记），只有 ops 还在准入。
  it("每员工一库：Stop 不等无关员工 ops，窗口内就 abort main 的运行并回包", async () => {
    await withOpsAdmissionPending("per-agent", async ({ context, releaseOps }) => {
      const run = createActiveRun(MAIN_SESSION, { sessionId: "main-1", agentId: "main" });
      context.chatAbortControllers.set(RUN_ID, run);
      const { request, respond } = dispatch(
        "chat.abort",
        { sessionKey: MAIN_SESSION, runId: RUN_ID },
        context,
      );
      await Promise.race([request, tick(WINDOW_MS)]);
      expect(run.controller.signal.aborted).toBe(true);
      expect(respond).toHaveBeenCalledWith(true, {
        ok: true,
        aborted: true,
        runIds: [RUN_ID],
      });
      releaseOps();
      await request;
    });
  });

  // 级联停止：main 这一轮派生的子 agent 在 ops 名下（现实里子 agent 在跑就说明 ops 已准入，
  // 这里人为让 ops 仍在准入，压最坏情况）。父运行的内存 abort 在级联 kill 的 beforeKill 里、
  // 早于子 agent 清理；子 agent 的内存 abort、登记表终态（全局状态库）都不碰员工库，同样当场
  // 生效；只有给子会话写 abortedLastRun 这类落库清理按 ops 的库主人等准入，回包可能因此晚到，
  // ops 放开后补完。
  it("子 agent 在准入中的员工下：父运行与子运行当场停止，子会话落库等 ops 准入后补完", async () => {
    await withOpsAdmissionPending("per-agent", async ({ context, releaseOps }) => {
      subagentRegistryTesting.setDepsForTest({
        persistSubagentRunsToDisk: () => {},
        persistSubagentRunsToDiskOrThrow: () => {},
        cleanupBrowserSessionsForLifecycleEnd: async () => {},
        loadAgentRuntimePluginRegistryHandle: () => undefined,
        resolveContextEngine: async () => new LegacyContextEngine(),
        callGateway: async () => await new Promise<never>(() => {}),
      });
      const childKey = "agent:ops:subagent:child";
      registerSubagentRun({
        runId: "child-run",
        childSessionKey: childKey,
        requesterSessionKey: MAIN_SESSION,
        requesterAgentId: "main",
        requesterDisplayKey: MAIN_SESSION,
        requesterTurnRunId: RUN_ID,
        task: "child",
        cleanup: "keep",
        expectsCompletionMessage: false,
      });
      const childAbort = vi.fn();
      const handle = createEmbeddedRunHandle({ runId: "child-run", abort: childAbort });
      setActiveEmbeddedRun("child-1", handle, childKey);
      const run = createActiveRun(MAIN_SESSION, { sessionId: "main-1", agentId: "main" });
      context.chatAbortControllers.set(RUN_ID, run);
      try {
        const { request, respond } = dispatch(
          "chat.abort",
          { sessionKey: MAIN_SESSION, runId: RUN_ID },
          context,
        );
        await Promise.race([request, tick(WINDOW_MS)]);
        expect(run.controller.signal.aborted).toBe(true);
        expect(childAbort).toHaveBeenCalledOnce();
        expect(getSubagentRunByChildSessionKey(childKey)?.execution.status).toBe("terminal");
        releaseOps();
        await request;
        expect(respond).toHaveBeenCalledWith(true, {
          ok: true,
          aborted: true,
          runIds: [RUN_ID],
        });
        // 子会话的 abortedLastRun 落在 ops 库里：等 ops 准入后补写，没有丢。
        expect(loadSessionEntry({ agentId: "ops", sessionKey: childKey })?.abortedLastRun).toBe(
          true,
        );
      } finally {
        clearActiveEmbeddedRun("child-1", handle, childKey);
      }
    });
  });

  // 共享库布局证明不了一员工一库，Stop 仍等全部（已知取舍）：这里锁住"不能无条件放行"。
  it("共享库布局：证明不了一员工一库，Stop 仍等全部员工准入（已知取舍）", async () => {
    await withOpsAdmissionPending("shared", async ({ context, releaseOps }) => {
      const run = createActiveRun(MAIN_SESSION, { sessionId: "main-1", agentId: "main" });
      context.chatAbortControllers.set(RUN_ID, run);
      const { request, respond } = dispatch(
        "chat.abort",
        { sessionKey: MAIN_SESSION, runId: RUN_ID },
        context,
      );
      await Promise.race([request, tick(WINDOW_MS)]);
      expect(respond).not.toHaveBeenCalled();
      expect(run.controller.signal.aborted).toBe(false);
      releaseOps();
      await request;
      expect(run.controller.signal.aborted).toBe(true);
      expect(respond).toHaveBeenCalledWith(true, { ok: true, aborted: true, runIds: [RUN_ID] });
    });
  });

  // 会话键没有 agent:<id>: 前缀：入口不解析默认员工，算不出目标，等全部。
  it("会话键无前缀：入口算不出目标员工，Stop 等全部员工准入", async () => {
    await withOpsAdmissionPending("per-agent", async ({ context, releaseOps }) => {
      const run = createActiveRun(MAIN_SESSION, { sessionId: "main-1", agentId: "main" });
      context.chatAbortControllers.set(RUN_ID, run);
      const { request, respond } = dispatch(
        "chat.abort",
        { sessionKey: "chat1", agentId: "main", runId: RUN_ID },
        context,
      );
      await Promise.race([request, tick(WINDOW_MS)]);
      expect(respond).not.toHaveBeenCalled();
      expect(run.controller.signal.aborted).toBe(false);
      releaseOps();
      await request;
      expect(run.controller.signal.aborted).toBe(true);
      expect(respond).toHaveBeenCalledWith(true, { ok: true, aborted: true, runIds: [RUN_ID] });
    });
  });

  // 关停 / 热重启：Stop 的目标员工自己还在准入时照常等它；调度器 cancel 立即以可重试的
  // UNAVAILABLE 结束等待，不卡关停。
  it("目标员工还在准入时 Stop 等它；关停 / 热重启 cancel 立即以可重试 UNAVAILABLE 结束", async () => {
    await withOpsAdmissionPending("per-agent", async ({ context }) => {
      const { request, respond } = dispatch(
        "chat.abort",
        { sessionKey: "agent:ops:chat1", runId: "ops-run" },
        context,
      );
      await Promise.race([request, tick(WINDOW_MS)]);
      expect(respond).not.toHaveBeenCalled();
      const cancelled = cancelAgentStartupAdmission();
      await Promise.race([request, tick(2_000)]);
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
      );
      await cancelled;
    });
  });
});

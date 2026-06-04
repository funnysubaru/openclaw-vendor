// 端到端接线级集成测试：面板 chat.abort（Stop）→ orchestrator abortedLastRun 持久化 →
// 下一轮读盘 → 会话级 abort 闸真触发。
//
// 为什么单独建这个文件（上一轮漏的就是这一层）：
//   上一轮的单测只测了孤立的闸函数 maybeResetOrchestratorYieldContextAfterUserAbort（直接喂 flag=true），
//   所以它永远 GREEN，却完全没覆盖「真实面板 Stop 路径根本不产生这个 flag」这个承重断点。
//   live 复验失败的根因正是：面板 teardown 只打内存闸、不写 store → 下一轮读出的 abortedLastRun
//   恒 false → 闸判据 #2 恒 false → 闸永不触发。
//
// 本测试用真实文件 store（不 mock store 读写），把链路串起来跑：
//   1) 写一个真实 store.json，里面有 orchestrator entry（带 sessionId + fresh updatedAt，abortedLastRun=false）；
//   2) 用真实 updateSessionStoreEntry（teardown 里调的同一个函数、同样的参数形态）落盘 abortedLastRun=true；
//   3) 用真实 loadSessionStore 读回盘上的 entry，断言 abortedLastRun 现在是 true（=teardown 写盘生效）；
//   4) 模拟 session.ts 的读取（entry.abortedLastRun ?? false）→ 透传成 abortedLastRunBeforeReset，
//      喂给真实闸函数 maybeResetOrchestratorYieldContextAfterUserAbort，断言闸确实触发（strip + inject 被调）。
//
// 第 2 步刻意复刻 session-runtime-teardown.ts 里 persistAbortedFlag 步骤的调用形态（同函数、
// 同 update→{abortedLastRun:true}）。如果哪天有人把 teardown 里那步删了/改坏了，session-runtime-teardown.test.ts
// 的接线断言会先红；而本文件证明「只要那步在、参数对，整条链就能驱动闸触发」。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maybeResetOrchestratorYieldContextAfterUserAbort } from "../agents/pi-embedded-runner/run/attempt.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  updateSessionStoreEntry,
} from "../config/sessions.js";

// orchestrator(团队编排者) 的 canonicalKey —— 面板团队会话用 :panel 后缀，绝非子 agent（无 :subagent: 段）。
const ORCHESTRATOR_KEY = "agent:main:user:u1:panel";

let tmpDir: string;
let storePath: string;

beforeEach(() => {
  // 每个用例一个独立临时目录 + 干净的 store cache，避免跨用例/跨 worker 读到旧盘内容。
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-abort-yield-"));
  storePath = path.join(tmpDir, "sessions.json");
  clearSessionStoreCacheForTest();
});

afterEach(() => {
  clearSessionStoreCacheForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// 往真实盘写一个初始 store：orchestrator 停在「上一轮没标记 abort」的常态。
function seedStore(entry: Partial<SessionEntry>): void {
  const store: Record<string, Partial<SessionEntry>> = {
    [ORCHESTRATOR_KEY]: {
      sessionId: "sess-orch-1",
      updatedAt: Date.now(),
      systemSent: true,
      abortedLastRun: false,
      ...entry,
    },
  };
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf8");
  // 写完清缓存，确保后续 loadSessionStore 走盘而不是命中预热缓存。
  clearSessionStoreCacheForTest();
}

describe("面板 Stop → orchestrator abortedLastRun 持久化 → 会话级 abort 闸触发（端到端串链路）", () => {
  it("teardown 持久化的 abortedLastRun 能驱动闸真触发（strip + inject 被调）", async () => {
    // 步骤 1：盘上 orchestrator 上一轮 abortedLastRun=false（常态）。
    seedStore({ abortedLastRun: false });

    // 前置断言：写盘前确实是 false（防止 seed 写错让后面假绿）。
    const before = loadSessionStore(storePath, { skipCache: true });
    expect(before[ORCHESTRATOR_KEY]?.abortedLastRun).toBe(false);

    // 步骤 2：复刻 teardown 的 persistAbortedFlag —— 同函数、同参数形态，对 orchestrator canonicalKey 打标。
    const result = await updateSessionStoreEntry({
      storePath,
      sessionKey: ORCHESTRATOR_KEY,
      update: async () => ({ abortedLastRun: true }),
    });
    // updateSessionStoreEntry 命中已存在 entry → 返回非 null。
    expect(result).not.toBeNull();

    // 步骤 3：真实读回盘上的 entry，断言 abortedLastRun 已落盘为 true（=面板 Stop 写盘生效）。
    const after = loadSessionStore(storePath, { skipCache: true });
    const persistedEntry = after[ORCHESTRATOR_KEY];
    expect(persistedEntry?.abortedLastRun).toBe(true);
    // 不能凭空丢了 sessionId / systemSent（否则下一轮会被误判成新会话，反而丢上下文）。
    expect(persistedEntry?.sessionId).toBe("sess-orch-1");
    expect(persistedEntry?.systemSent).toBe(true);

    // 步骤 4：模拟 session.ts:370 的读取 —— entry.abortedLastRun ?? false —— 作为闸判据 #2 的真值来源。
    const abortedLastRunBeforeReset = persistedEntry?.abortedLastRun ?? false;
    expect(abortedLastRunBeforeReset).toBe(true);

    // 构造 live session 桩：leaf 停在 sessions_yield 挂起态、本轮是真实用户消息（external_user）。
    const stripArtifacts = vi.fn();
    const injectCalls: Array<{ customType: string; display: boolean; triggerTurn?: boolean }> = [];
    const activeSession = {
      messages: [] as never[],
      agent: { replaceMessages: vi.fn() },
      sessionManager: undefined,
      sendCustomMessage: vi.fn(
        async (
          message: { customType: string; content: string; display: boolean },
          options?: { triggerTurn?: boolean },
        ) => {
          injectCalls.push({
            customType: message.customType,
            display: message.display,
            triggerTurn: options?.triggerTurn,
          });
        },
      ),
    };

    const decision = await maybeResetOrchestratorYieldContextAfterUserAbort({
      leafEntry: { type: "custom_message", customType: "openclaw.sessions_yield" },
      // 这里喂的就是从真实盘读回的 abortedLastRun —— 不是凭空 true，证明整条链打通。
      abortedLastRunBeforeReset,
      inputProvenanceKind: "external_user",
      activeSession,
      stripArtifacts,
    });

    // 闸必须触发：剥挂起工件 + 注入隐藏修正说明。
    expect(decision.applied).toBe(true);
    expect(decision.reason).toBe("applied");
    expect(stripArtifacts).toHaveBeenCalledTimes(1);
    expect(injectCalls).toHaveLength(1);
    expect(injectCalls[0].customType).toBe("openclaw.session_aborted_reset");
    expect(injectCalls[0].display).toBe(false);
    expect(injectCalls[0].triggerTurn).toBe(false);
  });

  it("反证：若面板 Stop 不写盘（旧 bug 行为），盘上 abortedLastRun 仍是 false → 闸不触发", async () => {
    // 这个用例固化「根因」：只要 teardown 不持久化（这里通过『跳过 updateSessionStoreEntry』模拟旧行为），
    // 读回的 abortedLastRun 就是 false，闸判据 #2 落空、闸不触发 —— 正是 live 复验看到的现象。
    seedStore({ abortedLastRun: false });

    // 故意不调 updateSessionStoreEntry（= 旧 teardown 只打内存闸、不写盘）。
    const after = loadSessionStore(storePath, { skipCache: true });
    const abortedLastRunBeforeReset = after[ORCHESTRATOR_KEY]?.abortedLastRun ?? false;
    expect(abortedLastRunBeforeReset).toBe(false);

    const stripArtifacts = vi.fn();
    const sendCustomMessage = vi.fn();
    const decision = await maybeResetOrchestratorYieldContextAfterUserAbort({
      leafEntry: { type: "custom_message", customType: "openclaw.sessions_yield" },
      abortedLastRunBeforeReset,
      inputProvenanceKind: "external_user",
      activeSession: {
        messages: [] as never[],
        agent: { replaceMessages: vi.fn() },
        sessionManager: undefined,
        sendCustomMessage,
      },
      stripArtifacts,
    });

    // 闸不触发 —— 这正是修复前 live 的行为，留作根因守护。
    expect(decision.applied).toBe(false);
    expect(decision.reason).toBe("not-aborted");
    expect(stripArtifacts).not.toHaveBeenCalled();
    expect(sendCustomMessage).not.toHaveBeenCalled();
  });

  it("updateSessionStoreEntry 对不存在的 entry 返回 null 且不在盘上凭空创建 entry", async () => {
    // 防御：teardown 用 updateSessionStoreEntry 而非 updateSessionStore 手写 mutator，正是为了
    // 「entry 不存在就不创建」。这里验证该语义 —— store 为空时打标返回 null，盘上不出现该 key。
    fs.writeFileSync(storePath, JSON.stringify({}, null, 2), "utf8");
    clearSessionStoreCacheForTest();

    const result = await updateSessionStoreEntry({
      storePath,
      sessionKey: ORCHESTRATOR_KEY,
      update: async () => ({ abortedLastRun: true }),
    });
    expect(result).toBeNull();

    const after = loadSessionStore(storePath, { skipCache: true });
    expect(after[ORCHESTRATOR_KEY]).toBeUndefined();
  });
});

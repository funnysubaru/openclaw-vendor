// 开库准入 owner 的「最后一个等待者因 signal 离开
// 且库未打开完 → 中止共享打开」。真实 SQLite + 真实开库生成器，只把完整性 worker 换成一个
// 会响应 signal 的慢检查（与真实 worker 同语义）。对应 PR #132 审查项 W1a–W1c。
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as integrityWorker from "../infra/sqlite-integrity-worker.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resetAgentStartupAdmissionForTest } from "./agent-startup-admission.js";
import { agentDatabaseLifecycle as cache } from "./openclaw-agent-db-lifecycle.js";
import {
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
  withOpenClawAgentDatabaseAsync,
} from "./openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  resetAgentStartupAdmissionForTest();
});

const options = { agentId: "main" };

function readLeases() {
  return openOpenClawStateDatabase()
    .db.prepare("SELECT lease_id FROM agent_database_leases ORDER BY lease_id")
    .all();
}

/** 冷库 + 慢完整性检查：返回每次检查的进入 / 被中止记录。 */
function gateIntegrity(pathname: string, abortDelayMs = 0) {
  const calls: { aborted: boolean; entered: ReturnType<typeof createDeferred<void>> }[] = [];
  const release = createDeferred<void>();
  const actual = integrityWorker.assertSqliteIntegrityInWorker;
  vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker").mockImplementation(
    async (target, busyTimeoutMs, signal) => {
      if (target !== pathname) {
        return await actual(target, busyTimeoutMs, signal);
      }
      const call = { aborted: false, entered: createDeferred<void>() };
      calls.push(call);
      call.entered.resolve();
      await new Promise<void>((resolve, reject) => {
        void release.promise.then(resolve);
        signal?.addEventListener("abort", () => {
          call.aborted = true;
          // 真实 worker 被 abort 后要 terminate 线程，有几毫秒到几十毫秒的延迟。
          setTimeout(() => reject(signal.reason), abortDelayMs);
        });
      });
      return await actual(target, busyTimeoutMs, signal);
    },
  );
  return { calls, release: () => release.resolve() };
}

async function prepareColdDatabase() {
  const pathname = openOpenClawAgentDatabase(options).path;
  closeOpenClawAgentDatabasesForTest();
  return pathname;
}

describe("共享开库：最后一个等待者离开即中止", () => {
  it("带 signal 的发起方离开、无 signal 的同伴仍在：打开不被中止，同伴拿到库", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const pathname = await prepareColdDatabase();
      const gate = gateIntegrity(pathname);
      const x = new AbortController();
      const first = withOpenClawAgentDatabaseAsync(options, (db) => db.path, undefined, x.signal);
      await vi.waitFor(() => expect(gate.calls).toHaveLength(1));
      const second = withOpenClawAgentDatabaseAsync(options, (db) => db.path);
      x.abort(new Error("caller cancelled"));
      await expect(first).rejects.toMatchObject({ name: "AbortError" });
      expect(gate.calls[0]?.aborted).toBe(false);
      gate.release();
      await expect(second).resolves.toBe(pathname);
      expect(gate.calls).toHaveLength(1);
      expect(cache.pending.size).toBe(0);
    });
  });

  it("唯一等待者离开：打开被中止；紧接着到的无 signal 调用方重试成功，句柄 / 租约无泄漏", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const pathname = await prepareColdDatabase();
      const baseline = readLeases();
      const gate = gateIntegrity(pathname, 50);
      const x = new AbortController();
      const first = withOpenClawAgentDatabaseAsync(options, (db) => db.path, undefined, x.signal);
      await vi.waitFor(() => expect(gate.calls).toHaveLength(1));
      // 打开进行中：已经为这次打开持有一条租约。
      expect(readLeases().length).toBe(baseline.length + 1);
      x.abort(new Error("caller cancelled"));
      await expect(first).rejects.toMatchObject({ name: "AbortError" });
      // 被中止的 pending 还没退场时到达的调用方：走 "existing 已中止 → 等它结束再重试" 分支。
      const pendingBefore = cache.pending.get(pathname);
      const second = withOpenClawAgentDatabaseAsync(options, (db) => db.path);
      await vi.waitFor(() => expect(gate.calls).toHaveLength(2));
      expect(gate.calls[0]?.aborted).toBe(true);
      expect(gate.calls[1]?.aborted).toBe(false);
      expect(pendingBefore?.controller.signal.aborted).toBe(true);
      gate.release();
      await expect(second).resolves.toBe(pathname);
      expect(getOpenClawAgentDatabaseIfOpen(options)?.db.isOpen).toBe(true);
      expect(cache.pending.size).toBe(0);
      expect(cache.activePending.size).toBe(0);
      // 中止那次的租约已释放：只剩当前打开的一条。
      expect(readLeases().length).toBe(baseline.length + 1);
      closeOpenClawAgentDatabasesForTest();
      expect(readLeases()).toEqual(baseline);
    });
  });

  it("中止后无人重试：句柄、租约、pending 全部收尾，之后重开不跳过完整性检查", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const pathname = await prepareColdDatabase();
      const baseline = readLeases();
      const gate = gateIntegrity(pathname);
      const x = new AbortController();
      const first = withOpenClawAgentDatabaseAsync(options, (db) => db.path, undefined, x.signal);
      await vi.waitFor(() => expect(gate.calls).toHaveLength(1));
      x.abort(new Error("caller cancelled"));
      await expect(first).rejects.toMatchObject({ name: "AbortError" });
      await vi.waitFor(() => expect(cache.activePending.size).toBe(0));
      expect(cache.pending.size).toBe(0);
      expect(gate.calls[0]?.aborted).toBe(true);
      expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
      expect(cache.failures.has(pathname)).toBe(false);
      expect(cache.terminal.get(pathname)).toBeUndefined();
      expect(readLeases()).toEqual(baseline);
      gate.release();
      // 异步重开会再做一次完整性检查（中止的那次没有被当成"已检查"）。
      await expect(withOpenClawAgentDatabaseAsync(options, (db) => db.path)).resolves.toBe(
        pathname,
      );
      expect(gate.calls).toHaveLength(2);
    });
  });
});

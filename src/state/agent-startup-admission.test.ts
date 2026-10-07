// ADR-0033 任务84(c)：后台 open+migrate 调度器的行为测试——并发上限、请求等待
// 挂起/失败两种结局、关闭时取消并等待收尾。
import { afterEach, describe, expect, it } from "vitest";
import {
  cancelAgentStartupAdmission,
  resetAgentStartupAdmissionForTest,
  scheduleAgentStartupAdmission,
  waitForAgentStartupAdmission,
} from "./agent-startup-admission.js";

afterEach(() => {
  resetAgentStartupAdmissionForTest();
});

/** 返回一对 { promise, resolve, reject }，方便手动控制 openAgent/migrateAgent 何时完成。 */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("agent-startup-admission", () => {
  it("open 并发上限为 2：第 3 个员工要等前两个之一先开完才开始 open", async () => {
    const gates = ["a", "b", "c"].map(() => deferred());
    const openStarted: string[] = [];
    scheduleAgentStartupAdmission({
      agentIds: ["a", "b", "c"],
      openAgent: async (agentId) => {
        openStarted.push(agentId);
        await gates[["a", "b", "c"].indexOf(agentId)].promise;
      },
      migrateAgent: async () => {},
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(openStarted.toSorted()).toEqual(["a", "b"]);

    gates[0].resolve();
    // a 的 open 完成、释放许可给 migrate 池之前，先让事件循环跑几轮，
    // 直到 c 真的拿到 open 许可开始跑（c 自己的 openAgent 会一直挂到我们 resolve 它）。
    for (let i = 0; i < 50 && !openStarted.includes("c"); i += 1) {
      await Promise.resolve();
    }
    expect(openStarted.toSorted()).toEqual(["a", "b", "c"]);

    gates[1].resolve();
    gates[2].resolve();
    await waitForAgentStartupAdmission("b");
    await waitForAgentStartupAdmission("c");
  });

  it("请求打到还没准入完成的员工时等待其完成，完成后 withOpenClawAgentDatabaseAsync 才继续", async () => {
    const openGate = deferred();
    scheduleAgentStartupAdmission({
      agentIds: ["worker"],
      openAgent: async () => {
        await openGate.promise;
      },
      migrateAgent: async () => {},
    });

    let waited = false;
    const pending = waitForAgentStartupAdmission("worker");
    expect(pending).toBeDefined();
    const waiting = pending?.then(() => {
      waited = true;
    });

    expect(waited).toBe(false);
    openGate.resolve();
    await waiting;
    expect(waited).toBe(true);
    // 准入完成后这个 agentId 就从 pending 表里摘掉了，后面的调用方不用再等。
    expect(waitForAgentStartupAdmission("worker")).toBeUndefined();
  });

  it("员工 open 失败时只让这一个员工不可用，等待方拿到同一个失败原因", async () => {
    scheduleAgentStartupAdmission({
      agentIds: ["broken"],
      openAgent: async () => {
        throw new Error("integrity_check failed: simulated corruption");
      },
      migrateAgent: async () => {
        throw new Error("should not reach migrate after a failed open");
      },
    });

    await expect(waitForAgentStartupAdmission("broken")).rejects.toThrow(
      "integrity_check failed: simulated corruption",
    );
    // 第二次等待（比如同一个请求重试，或者另一个请求打到同一个员工）拿到同一个
    // 原因，不会重跑 openAgent，也不会把它当成"没被这套机制接管过"而悄悄放行。
    await expect(waitForAgentStartupAdmission("broken")).rejects.toThrow(
      "integrity_check failed: simulated corruption",
    );
  });

  it("没被调度过的 agentId 返回 undefined，调用方照常走自己原来的路径", () => {
    expect(waitForAgentStartupAdmission("never-scheduled")).toBeUndefined();
  });

  it("关闭时取消还没跑完的后台准入，并真正等它们收尾（不是只发 abort 就提前返回）", async () => {
    const openStartedSignals: AbortSignal[] = [];
    let migrateReached = false;
    let cleanupFinished = false;
    const cleanupGate = deferred();
    scheduleAgentStartupAdmission({
      agentIds: ["slow"],
      openAgent: async (_agentId, signal) => {
        openStartedSignals.push(signal);
        // 模拟一个还在跑的异步操作：不会自己完成，只能被 abort 打断；abort 之后还有
        // 一步"收尾清理"要等外部的 cleanupGate 才算完——这是本测试要验证的重点：
        // cancelAgentStartupAdmission() 必须等到这一步也跑完才能返回，不能 abort
        // 一发出去就提前算数（上面那个被去掉 tracked.add 也能通过的弱版本就是漏了
        // 这一步）。
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")),
            { once: true },
          );
        }).catch(() => {
          // openAgent 自己吞掉 abort、正常返回；下面 migrateAgent 不应该再被进入。
        });
        await cleanupGate.promise;
        // 故意再跨一个宏任务（setTimeout）才真正置位：如果 cancelAgentStartupAdmission
        // 没有真的在等 tracked 里的 work（比如漏了 tracked.add），它会在微任务阶段就
        // 提前 resolve，赶不上这个宏任务——用宏任务而不是再等几个 Promise.resolve()，
        // 是为了不依赖微任务调度顺序的偶然性，给出确定性的信号。
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 5);
        });
        cleanupFinished = true;
      },
      migrateAgent: async () => {
        migrateReached = true;
      },
    });

    await Promise.resolve();
    expect(openStartedSignals).toHaveLength(1);
    expect(openStartedSignals[0]?.aborted).toBe(false);

    const cancelled = cancelAgentStartupAdmission();
    // abort 本身是同步广播的，但收尾（cleanupGate）还没放行——cancel 不该在这里就
    // 已经 resolve 了。给几轮微任务机会，确认它确实还在等。
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }
    expect(openStartedSignals[0]?.aborted).toBe(true);
    expect(cleanupFinished).toBe(false);

    cleanupGate.resolve();
    await cancelled;

    expect(cleanupFinished).toBe(true);
    // migrate 并发池的 acquire 在 signal 已经 abort 时直接返回 null（见
    // shared/permit-pool.ts），所以不会真的跑 migrateAgent。
    expect(migrateReached).toBe(false);
  });

  it("resetAgentStartupAdmissionForTest 清空全部状态", async () => {
    scheduleAgentStartupAdmission({
      agentIds: ["x"],
      openAgent: async () => {},
      migrateAgent: async () => {},
    });
    expect(waitForAgentStartupAdmission("x")).toBeDefined();

    resetAgentStartupAdmissionForTest();

    expect(waitForAgentStartupAdmission("x")).toBeUndefined();
  });

  // ADR-0033 任务84(c)：gateway 支持不退出进程的热 restart（"gateway-restart" 独立于
  // "gateway-startup"），本模块是模块级全局单例，cancelAgentStartupAdmission 收尾后
  // 必须顺带清空 failedByAgentId——否则上一轮真的失败过的 agentId 会被
  // scheduleAgentStartupAdmission 的 dedup 判据永久跳过，下一轮启动永远不会重试，
  // waitForAgentStartupAdmission 对它也永远 reject 同一个陈旧原因。
  it("cancelAgentStartupAdmission 收尾后清空失败记录，下一轮 restart 能重新调度同一个 agentId", async () => {
    scheduleAgentStartupAdmission({
      agentIds: ["flaky"],
      openAgent: async () => {
        throw new Error("transient disk error on first boot");
      },
      migrateAgent: async () => {},
    });
    await expect(waitForAgentStartupAdmission("flaky")).rejects.toThrow(
      "transient disk error on first boot",
    );

    await cancelAgentStartupAdmission();

    // 清空之后，这个 agentId 不再被 dedup 挡住——下一轮 restart 的
    // scheduleAgentStartupAdmission 能把它重新排进去，而不是永远背着上一轮的旧错误。
    let reopened = false;
    scheduleAgentStartupAdmission({
      agentIds: ["flaky"],
      openAgent: async () => {
        reopened = true;
      },
      migrateAgent: async () => {},
    });
    await waitForAgentStartupAdmission("flaky");
    expect(reopened).toBe(true);
  });

  // 死锁回归：openclaw-agent-db.ts 的 withOpenClawAgentDatabaseAsync 第一步就是调
  // waitForAgentStartupAdmission(options.agentId) 并 await 它拿到的 pending；如果
  // 调度出的 openAgent/migrateAgent 回调内部对"自己正在处理的那个 agentId"走这同一
  // 步骤（而不是 withOpenClawAgentDatabaseAsyncSkippingStartupAdmissionWait 绕过
  // 入口），waitForAgentStartupAdmission 返回的正是自己这个 work 本身——等于自己等
  // 自己，不靠外部事件永远不会 resolve。
  //
  // 这条测试直接用 waitForAgentStartupAdmission（而不是真去调
  // withOpenClawAgentDatabaseAsync）复现这个核心机制，避免真的触发 sqlite 文件 I/O
  // ——一旦 migrateAgent 自己通过 race 的超时分支返回，work 会 settle，那时如果换了
  // 真实的 withOpenClawAgentDatabaseAsync，它遗留的那个"还在等 pending"的调用会在
  // work settle 后继续往下跑到真正开库那一步，在测试环境里没有意义地碰真实
  // sqlite 路径；用纯函数 waitForAgentStartupAdmission 复现同一条件，遗留的
  // `.then()` 延续只是个无副作用的空操作，不会有这个问题。
  //
  // 用一个短超时的 Promise.race 把"不靠外部事件永远不会 resolve"变成可在几十毫秒内
  // 判定的结果，而不是真的把测试进程挂死：换成
  // withOpenClawAgentDatabaseAsyncSkippingStartupAdmissionWait 的等价绕过逻辑（直接
  // 跳过 waitForAgentStartupAdmission 这一步）的话，这条测试会从"判定为死锁"反转成
  // "立刻判定为已解除"，从而变红——证明测试确实在断言正确的那一端。
  it("调度回调内部如果对同一个 agentId 走等待检查这一步会自己等自己（死锁回归）", async () => {
    let outcome: "deadlocked" | "resolved" | undefined;
    scheduleAgentStartupAdmission({
      agentIds: ["self-wait"],
      openAgent: async () => {},
      migrateAgent: async (agentId) => {
        // 等价于 withOpenClawAgentDatabaseAsync 真正会执行的第一步：此刻
        // pendingByAgentId 里挂着的正是自己这个 work。
        const pending = waitForAgentStartupAdmission(agentId);
        const result = await Promise.race([
          (pending ?? Promise.resolve()).then(() => "resolved" as const),
          new Promise<"deadlocked">((resolve) => {
            setTimeout(() => resolve("deadlocked"), 50);
          }),
        ]);
        outcome = result;
      },
    });

    await waitForAgentStartupAdmission("self-wait");
    expect(outcome).toBe("deadlocked");
  });
});

// ADR-0033 任务84(c)：后台 open+migrate 调度器的行为测试——并发上限、请求等待
// 挂起/失败两种结局、关闭时取消并等待收尾。
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentStartupAdmissionPendingError,
  assertAgentStartupAdmissionSettled,
  cancelAgentStartupAdmission,
  resetAgentStartupAdmissionForTest,
  scheduleAgentStartupAdmission,
  waitForAgentStartupAdmission,
  waitForAgentStartupAdmissionBeforeRequest,
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

  // 死锁回归（review P1-1）：准入工作内部（含间接调用链）对自己这个 agentId 查等待 / 同步
  // 检查都必须放行，否则会拿到自己这个 work，自己等自己；工作外部照常等待 / 拒绝；准入
  // 结束后，在准入期间派生、活得更久的上下文不能再拿它当豁免凭证。真实 handoff 链路的
  // 端到端回归见 src/gateway/session-startup-migration.background-admission.test.ts。
  it("准入工作内部对自己不等待不拒绝，外部照常等待 / 拒绝，结束后豁免失效", async () => {
    const release = deferred();
    let lingering: (() => void) | undefined;
    const inside: unknown[] = [];
    scheduleAgentStartupAdmission({
      agentIds: ["self-wait"],
      openAgent: async () => {
        // 经一层异步间接调用再查，模拟 handoff → reconcile → 开库这类深层调用。
        await Promise.resolve();
        inside.push(waitForAgentStartupAdmission("self-wait"));
        try {
          assertAgentStartupAdmissionSettled("self-wait");
          inside.push("allowed");
        } catch (error) {
          inside.push(error);
        }
        lingering = () => assertAgentStartupAdmissionSettled("self-wait");
        await release.promise;
      },
      migrateAgent: async () => {},
    });
    const outside = waitForAgentStartupAdmission("self-wait");
    expect(outside).toBeDefined();
    expect(() => assertAgentStartupAdmissionSettled("self-wait")).toThrow(
      AgentStartupAdmissionPendingError,
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(inside[0]).toBeUndefined();
    expect(inside[1]).toBe("allowed");

    release.resolve();
    await outside;
    expect(waitForAgentStartupAdmission("self-wait")).toBeUndefined();
    expect(() => assertAgentStartupAdmissionSettled("self-wait")).not.toThrow();

    // 下一轮准入（热重启）开始后，上一轮遗留的上下文不再豁免。
    const nextRound = deferred();
    await cancelAgentStartupAdmission();
    scheduleAgentStartupAdmission({
      agentIds: ["self-wait"],
      openAgent: async () => await nextRound.promise,
      migrateAgent: async () => {},
    });
    expect(lingering).toThrow(AgentStartupAdmissionPendingError);
    nextRound.resolve();
    await waitForAgentStartupAdmission("self-wait");
  });

  it("准入失败后同步检查抛同一个失败原因", async () => {
    const failure = new Error("integrity failed");
    scheduleAgentStartupAdmission({
      agentIds: ["broken"],
      openAgent: async () => {
        throw failure;
      },
      migrateAgent: async () => {},
    });
    await expect(waitForAgentStartupAdmission("broken")).rejects.toBe(failure);
    expect(() => assertAgentStartupAdmissionSettled("broken")).toThrow(failure);
  });

  // review2~4 收口：只有调度方证明了"逻辑员工 = 物理 owner、无共享库"才按员工收窄；
  // 证明不了（不传 / false）时任何员工的请求都等全部在途准入。
  it("证明了一一对应才按员工收窄；否则一律等全部", async () => {
    const opsGate = deferred();
    const settled: string[] = [];
    const track = (label: string, wait: Promise<void> | undefined) => {
      if (wait) {
        void wait.then(() => settled.push(label));
      } else {
        settled.push(label);
      }
    };
    scheduleAgentStartupAdmission({
      agentIds: ["main", "ops"],
      openAgent: async (agentId) => {
        if (agentId === "ops") {
          await opsGate.promise;
        }
      },
      migrateAgent: async () => {},
      narrowRequestsToAgent: true,
    });
    await waitForAgentStartupAdmission("main");
    track("narrow-main", waitForAgentStartupAdmissionBeforeRequest({ agentId: "main" }));
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(settled).toEqual(["narrow-main"]);
    opsGate.resolve();
    await waitForAgentStartupAdmission("ops");
    resetAgentStartupAdmissionForTest();

    const opsGate2 = deferred();
    scheduleAgentStartupAdmission({
      agentIds: ["main", "ops"],
      openAgent: async (agentId) => {
        if (agentId === "ops") {
          await opsGate2.promise;
        }
      },
      migrateAgent: async () => {},
    });
    await waitForAgentStartupAdmission("main");
    track("wide-main", waitForAgentStartupAdmissionBeforeRequest({ agentId: "main" }));
    track("wide-stranger", waitForAgentStartupAdmissionBeforeRequest({ agentId: "stranger" }));
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(settled).toEqual(["narrow-main"]);
    opsGate2.resolve();
    await waitForAgentStartupAdmission("ops");
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(settled.toSorted()).toEqual(["narrow-main", "wide-main", "wide-stranger"]);
  });

  // 失败语义：收窄时请求员工已失败立即 reject；等全部时，请求员工本身是已失败的库 owner，
  // 则在全部在途准入结束后报它的失败原因（不会被当成成功放行）。
  it("请求员工准入已失败：收窄时立即报，等全部时结束后报同一原因", async () => {
    const failure = new Error("main integrity failed");
    const opsGate = deferred();
    scheduleAgentStartupAdmission({
      agentIds: ["main", "ops"],
      openAgent: async (agentId) => {
        if (agentId === "main") {
          throw failure;
        }
        await opsGate.promise;
      },
      migrateAgent: async () => {},
    });
    await expect(waitForAgentStartupAdmission("main")).rejects.toBe(failure);
    let rejected: unknown;
    const wide = waitForAgentStartupAdmissionBeforeRequest({ agentId: "main" })?.catch(
      (error: unknown) => {
        rejected = error;
      },
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(rejected).toBeUndefined();
    opsGate.resolve();
    await wide;
    expect(rejected).toBe(failure);
  });
});

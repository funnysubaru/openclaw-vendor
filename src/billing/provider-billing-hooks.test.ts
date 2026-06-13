/**
 * provider-billing-hooks.test.ts
 *
 * 单测覆盖 wrapProviderWithBilling 的关键行为：
 *   1. 无 hooks → 透传（向后兼容）
 *   2. 成功路径：preCheck 1 次 + postCharge 1 次，costUsd 正确
 *   3. preCheck blocked → 不调 baseFn、不调 postCharge
 *   4. baseFn 抛错 → cancelReservation，不调 postCharge
 *   5. result() 抛错（流 error） → cancelReservation，不调 postCharge
 *   6. 多次调用 → 每次独立计费（N 次 postCharge）
 *   7. preCheck 抛错 → fail-open，继续调用 baseFn
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  wrapProviderWithBilling,
  setBillingHooks,
  getBillingHooks,
  clearBillingHooks,
  type BillingHooks,
  type BillingWrapParams,
} from "./provider-billing-hooks.js";

// =============================================================================
// 辅助：创建假 stream 对象（模拟 streamSimple 返回值）
// =============================================================================

/** 创建一个成功完成的假 stream，result() 返回带 usage 的 message */
function createMockStream(usagePayload?: Record<string, unknown>, shouldResultThrow = false) {
  const message = usagePayload ? { usage: usagePayload, role: "assistant" } : { role: "assistant" };
  return {
    result: shouldResultThrow
      ? vi.fn(async () => {
          throw new Error("stream error");
        })
      : vi.fn(async () => message),
    [Symbol.asyncIterator]: vi.fn(function () {
      let done = false;
      return {
        async next() {
          if (!done) {
            done = true;
            return { done: false, value: { type: "text_delta", delta: "hello" } };
          }
          return { done: true, value: undefined };
        },
        async return(value?: unknown) {
          return { done: true as const, value };
        },
        async throw(error?: unknown) {
          throw error;
        },
      };
    }),
  };
}

/** 创建标准 BillingHooks mock */
function createMockHooks(preCheckAllowed = true): {
  hooks: BillingHooks;
  preCheck: ReturnType<typeof vi.fn>;
  postCharge: ReturnType<typeof vi.fn>;
  cancelReservation: ReturnType<typeof vi.fn>;
} {
  const preCheck = vi.fn(async () => ({
    allowed: preCheckAllowed,
    reason: preCheckAllowed ? undefined : "quota exceeded",
  }));
  const postCharge = vi.fn(async () => {});
  const cancelReservation = vi.fn(async () => {});
  const hooks: BillingHooks = { preCheck, postCharge, cancelReservation };
  return { hooks, preCheck, postCharge, cancelReservation };
}

/** 标准 BillingWrapParams，含模型单价配置 */
const BASE_PARAMS: BillingWrapParams = {
  modelName: "claude-3-5-sonnet-20241022",
  provider: "anthropic",
  sessionKey: "test-session-key",
  sessionId: "test-session-id",
  runId: "test-run-id",
  agentId: "test-agent-id",
  messageChannel: "panel-chat",
  // input: $3/1M tokens, output: $15/1M tokens（Anthropic Claude 3.5 Sonnet 示例单价）
  modelCost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};

// =============================================================================
// 测试
// =============================================================================

describe("wrapProviderWithBilling", () => {
  beforeEach(() => {
    // 每个测试前清除全局 registry，保证隔离
    clearBillingHooks();
  });

  // ---------------------------------------------------------------------------
  // 1. 无 hooks → 原样透传（向后兼容）
  // ---------------------------------------------------------------------------
  it("hooks 为 null 时返回原始 baseFn（向后兼容）", () => {
    const baseFn = vi.fn() as unknown as StreamFn;
    const wrapped = wrapProviderWithBilling(baseFn, null, BASE_PARAMS);
    expect(wrapped).toBe(baseFn);
  });

  it("hooks 为 undefined 时返回原始 baseFn（向后兼容）", () => {
    const baseFn = vi.fn() as unknown as StreamFn;
    const wrapped = wrapProviderWithBilling(baseFn, undefined, BASE_PARAMS);
    expect(wrapped).toBe(baseFn);
  });

  // ---------------------------------------------------------------------------
  // 2. 成功路径：preCheck 1 次 + postCharge 1 次，costUsd 正确
  // ---------------------------------------------------------------------------
  it("成功路径：一次调用触发 1 次 preCheck + 1 次 postCharge，costUsd 正确算出", async () => {
    const { hooks, preCheck, postCharge, cancelReservation } = createMockHooks(true);
    // 1000 input tokens + 500 output tokens
    // cost = (1000 * 3 + 500 * 15) / 1_000_000 = (3000 + 7500) / 1_000_000 = 0.0105
    const mockStream = createMockStream({ input_tokens: 1000, output_tokens: 500 });
    const baseFn = vi.fn(() => mockStream) as unknown as StreamFn;

    const wrapped = wrapProviderWithBilling(baseFn, hooks, BASE_PARAMS);
    // 调用 wrapped
    const streamResult = await (wrapped as Function)({}, {}, {});
    // 消费 result()
    await streamResult.result();

    // 等一个 microtask tick，让 postCharge Promise 跑完
    await Promise.resolve();

    expect(preCheck).toHaveBeenCalledTimes(1);
    expect(baseFn).toHaveBeenCalledTimes(1);
    expect(postCharge).toHaveBeenCalledTimes(1);
    expect(cancelReservation).not.toHaveBeenCalled();

    // 校验 postCharge ctx 字段
    const postChargeCtx = postCharge.mock.calls[0]?.[0];
    expect(postChargeCtx.eventId).toBeTypeOf("string");
    expect(postChargeCtx.eventId.length).toBeGreaterThan(0);
    expect(postChargeCtx.modelName).toBe("claude-3-5-sonnet-20241022");
    expect(postChargeCtx.provider).toBe("anthropic");
    expect(postChargeCtx.sessionKey).toBe("test-session-key");

    // usage 规范化后正确
    expect(postChargeCtx.usage).toBeDefined();
    expect(postChargeCtx.usage.input).toBe(1000);
    expect(postChargeCtx.usage.output).toBe(500);

    // costUsd 正确：(1000 * 3 + 500 * 15) / 1_000_000 = 0.0105
    expect(postChargeCtx.costUsd).toBeCloseTo(0.0105, 6);
  });

  // ---------------------------------------------------------------------------
  // 3. preCheck blocked → 不调 baseFn、抛错
  // ---------------------------------------------------------------------------
  it("preCheck 返回 blocked → 不调 baseFn，不调 postCharge，抛错", async () => {
    const { hooks, preCheck, postCharge, cancelReservation } = createMockHooks(false);
    const baseFn = vi.fn() as unknown as StreamFn;
    const wrapped = wrapProviderWithBilling(baseFn, hooks, BASE_PARAMS);

    await expect((wrapped as Function)({}, {}, {})).rejects.toThrow("[billing] blocked");

    expect(preCheck).toHaveBeenCalledTimes(1);
    expect(baseFn).not.toHaveBeenCalled();
    expect(postCharge).not.toHaveBeenCalled();
    expect(cancelReservation).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // 4. baseFn 抛错 → cancelReservation，不调 postCharge
  // ---------------------------------------------------------------------------
  it("baseFn 同步抛错 → cancelReservation 被调，不调 postCharge", async () => {
    const { hooks, preCheck, postCharge, cancelReservation } = createMockHooks(true);
    const baseFn = vi.fn(() => {
      throw new Error("provider error");
    }) as unknown as StreamFn;
    const wrapped = wrapProviderWithBilling(baseFn, hooks, BASE_PARAMS);

    await expect((wrapped as Function)({}, {}, {})).rejects.toThrow("provider error");

    // 等 cancel promise
    await Promise.resolve();

    expect(preCheck).toHaveBeenCalledTimes(1);
    expect(baseFn).toHaveBeenCalledTimes(1);
    expect(postCharge).not.toHaveBeenCalled();
    expect(cancelReservation).toHaveBeenCalledTimes(1);

    // cancel ctx 带正确的 eventId
    const cancelCtx = cancelReservation.mock.calls[0]?.[0];
    expect(cancelCtx.eventId).toBeTypeOf("string");
    expect(cancelCtx.modelName).toBe("claude-3-5-sonnet-20241022");
  });

  // ---------------------------------------------------------------------------
  // 5. result() 抛错（流 error）→ cancelReservation，不调 postCharge
  // ---------------------------------------------------------------------------
  it("result() 抛错（流 error）→ cancelReservation 被调，不调 postCharge", async () => {
    const { hooks, postCharge, cancelReservation } = createMockHooks(true);
    // shouldResultThrow = true → result() 会抛错
    const mockStream = createMockStream(undefined, true);
    const baseFn = vi.fn(() => mockStream) as unknown as StreamFn;
    const wrapped = wrapProviderWithBilling(baseFn, hooks, BASE_PARAMS);

    const streamResult = await (wrapped as Function)({}, {}, {});
    await expect(streamResult.result()).rejects.toThrow("stream error");

    // 等 cancel promise
    await Promise.resolve();

    expect(postCharge).not.toHaveBeenCalled();
    expect(cancelReservation).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // 6. 多次调用 → 每次独立计费（N 次 postCharge，eventId 各不同）
  // ---------------------------------------------------------------------------
  it("多次调用 → N 次 postCharge，每次 eventId 不同（per-call 粒度）", async () => {
    const { hooks, postCharge } = createMockHooks(true);
    const baseFn = vi.fn(() =>
      createMockStream({ input_tokens: 100, output_tokens: 50 }),
    ) as unknown as StreamFn;
    const wrapped = wrapProviderWithBilling(baseFn, hooks, BASE_PARAMS);

    // 调用 3 次
    for (let i = 0; i < 3; i++) {
      const s = await (wrapped as Function)({}, {}, {});
      await s.result();
    }
    await Promise.resolve();

    expect(postCharge).toHaveBeenCalledTimes(3);

    // 每次 eventId 不同
    const eventIds = postCharge.mock.calls.map((call) => call[0].eventId);
    expect(new Set(eventIds).size).toBe(3);
  });

  // ---------------------------------------------------------------------------
  // 7. preCheck 本身抛错 → fail-open，继续调用 baseFn
  // ---------------------------------------------------------------------------
  it("preCheck 抛错 → fail-open，继续调用 baseFn + postCharge", async () => {
    const { hooks, postCharge } = createMockHooks(true);
    // 覆写 preCheck 使之抛错
    hooks.preCheck = vi.fn(async () => {
      throw new Error("BFF unreachable");
    });

    const mockStream = createMockStream({ input_tokens: 100, output_tokens: 50 });
    const baseFn = vi.fn(() => mockStream) as unknown as StreamFn;
    const wrapped = wrapProviderWithBilling(baseFn, hooks, BASE_PARAMS);

    // 不应抛错（fail-open）
    const streamResult = await (wrapped as Function)({}, {}, {});
    await streamResult.result();
    await Promise.resolve();

    expect(baseFn).toHaveBeenCalledTimes(1);
    expect(postCharge).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // 8. setBillingHooks / getBillingHooks / clearBillingHooks registry 验证
  // ---------------------------------------------------------------------------
  it("setBillingHooks 注册后 getBillingHooks 可取到，clearBillingHooks 后返回 null", () => {
    const { hooks } = createMockHooks(true);
    expect(getBillingHooks()).toBeNull();
    setBillingHooks(hooks);
    expect(getBillingHooks()).toBe(hooks);
    clearBillingHooks();
    expect(getBillingHooks()).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 9. costUsd 在没有模型单价配置时返回 undefined
  // ---------------------------------------------------------------------------
  it("modelCost 缺失时 postCharge.costUsd 为 undefined", async () => {
    const { hooks, postCharge } = createMockHooks(true);
    const paramsNoCost: BillingWrapParams = { ...BASE_PARAMS, modelCost: undefined };
    const baseFn = vi.fn(() => createMockStream({ input_tokens: 100 })) as unknown as StreamFn;
    const wrapped = wrapProviderWithBilling(baseFn, hooks, paramsNoCost);

    const s = await (wrapped as Function)({}, {}, {});
    await s.result();
    await Promise.resolve();

    expect(postCharge).toHaveBeenCalledTimes(1);
    expect(postCharge.mock.calls[0]?.[0].costUsd).toBeUndefined();
  });
});

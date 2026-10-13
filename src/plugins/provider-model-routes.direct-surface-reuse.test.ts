// 任务99 热点②（回搬上游 #155241 中我们漏掉的那处）：resolveProviderModelPolicySurface 先按 provider id
// 查一次「随包直接策略」，没命中才走 resolveProviderPolicySurface；后者以前会按同一个 id 再查一遍。
// Windows 上每查一次都要读几次环境变量（本机实测一次 3.6～6.7 微秒），启动期模型目录按模型逐个调用，
// 重复查被放大成秒级。这里用真实的下游实现，只给直接查找包一层计数，断言同一 id 只查一次。
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./provider-policy-surface.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./provider-policy-surface.js")>();
  return {
    ...actual,
    resolveDirectBundledProviderPolicySurface: vi.fn(
      actual.resolveDirectBundledProviderPolicySurface,
    ),
  };
});

import { resolveProviderModelPolicySurface } from "./provider-model-routes.js";
import * as policySurface from "./provider-policy-surface.js";
import { resolveProviderPolicySurface } from "./provider-public-artifacts.js";

const directLookup = vi.mocked(policySurface.resolveDirectBundledProviderPolicySurface);
const callsFor = (providerId: string) =>
  directLookup.mock.calls.filter(([id]) => id === providerId).length;

describe("provider 直接策略查找不重复", () => {
  beforeEach(() => {
    directLookup.mockClear();
  });

  it("未命中的 provider 只按自身 id 查一次直接策略", () => {
    const providerId = "task99-unknown-provider";
    expect(resolveProviderModelPolicySurface(providerId, { plugins: [] } as never)).toBeNull();
    // 修前为 2：resolveProviderModelPolicySurface 一次 + resolveBundledProviderPolicySurface 又一次。
    expect(callsFor(providerId)).toBe(1);
  });

  it("不带 directSurface 的调用方仍自己查一次（行为不变）", () => {
    const providerId = "task99-direct-caller";
    expect(
      resolveProviderPolicySurface(providerId, { manifestRegistry: { plugins: [] } }),
    ).toBeNull();
    expect(callsFor(providerId)).toBe(1);
  });
});

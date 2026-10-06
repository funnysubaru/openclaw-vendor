// 守住 provider-model-routes.ts 的一处调用约定（ADR-0033 任务 72/84，回搬自上游 #155250）：
// resolveProviderModelPolicySurface 必须把调用方给的 metadata 快照**原引用**交给
// resolveProviderPolicySurface，不能每次 `{ plugins: [...metadata.plugins] }` 重新包一层。
// provider-policy-owners.ts 按 registry 对象引用缓存归属索引，包一层新对象就永远不命中
// （回搬前插桩实测 383903 次调用、0 次命中，冷启动多花约 7 秒）。这里 mock 掉下游，只断言传参引用。
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveProviderPolicySurface: vi.fn((_provider: string, _params: unknown) => null),
  resolveDirectBundledProviderPolicySurface: vi.fn((_provider: string) => null),
}));

vi.mock("./provider-public-artifacts.js", () => ({
  resolveProviderPolicySurface: mocks.resolveProviderPolicySurface,
}));
vi.mock("./provider-policy-surface.js", () => ({
  resolveDirectBundledProviderPolicySurface: mocks.resolveDirectBundledProviderPolicySurface,
}));

import { resolveProviderModelPolicySurface } from "./provider-model-routes.js";

describe("resolveProviderModelPolicySurface 传参引用", () => {
  beforeEach(() => {
    mocks.resolveProviderPolicySurface.mockClear();
    mocks.resolveDirectBundledProviderPolicySurface.mockClear();
  });

  it("把调用方的 metadata 原引用作为 manifestRegistry 传下去，多次调用引用不变", () => {
    const metadata = { plugins: [] } as never;
    resolveProviderModelPolicySurface("some-external-provider", metadata);
    resolveProviderModelPolicySurface("some-external-provider", metadata);

    expect(mocks.resolveProviderPolicySurface).toHaveBeenCalledTimes(2);
    for (const [, params] of mocks.resolveProviderPolicySurface.mock.calls) {
      // toBe = 同一对象引用；若改回「每次新包一层」这里会变红。
      expect((params as { manifestRegistry: unknown }).manifestRegistry).toBe(metadata);
    }
  });

  it("随包 provider 直接命中时不走 manifestRegistry 查询", () => {
    const surface = { pluginId: "bundled" };
    mocks.resolveDirectBundledProviderPolicySurface.mockReturnValueOnce(surface as never);
    expect(resolveProviderModelPolicySurface("openai", { plugins: [] } as never)).toBe(surface);
    expect(mocks.resolveProviderPolicySurface).not.toHaveBeenCalled();
  });
});

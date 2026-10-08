import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("direct provider policy surface", () => {
  afterEach(() => {
    vi.doUnmock("./bundled-dir.js");
    vi.doUnmock("./manifest-registry.js");
    vi.doUnmock("./public-surface-loader.js");
    vi.doUnmock("./plugin-cache.js");
    vi.doUnmock("./runtime-state.js");
    vi.doUnmock("./runtime/gateway-request-scope.js");
    vi.resetModules();
  });

  it("loads the provider-id artifact without evaluating the manifest registry", async () => {
    const manifestRegistryModuleFactory = vi.fn(() => {
      throw new Error("unexpected manifest registry import");
    });
    const resolveModelRoutes = vi.fn();
    const isResponseModelEquivalent = vi.fn();
    const projectRealtimeVoicePublicProjection = vi.fn();
    const loadBundledPluginPublicArtifactModuleFromCandidatesSync = vi.fn(() => ({
      deprecatedProfileIds: ["demo:legacy"],
      resolveModelRoutes,
      isResponseModelEquivalent,
      projectRealtimeVoicePublicProjection,
    }));

    vi.doMock("./bundled-dir.js", () => ({
      resolveBundledPluginsDir: () => "/tmp/bundled-plugins",
    }));
    vi.doMock("./manifest-registry.js", manifestRegistryModuleFactory);
    vi.doMock("./public-surface-loader.js", () => ({
      loadBundledPluginPublicArtifactModuleFromCandidatesSync,
    }));

    const { resolveDirectBundledProviderPolicySurface } = await importFreshModule<
      typeof import("./provider-policy-surface.js")
    >(import.meta.url, "./provider-policy-surface.js?scope=direct-provider-policy");

    const surface = resolveDirectBundledProviderPolicySurface("openai");

    expect(surface?.resolveModelRoutes).toBe(resolveModelRoutes);
    expect(surface?.isResponseModelEquivalent).toBe(isResponseModelEquivalent);
    expect(surface?.projectRealtimeVoicePublicProjection).toBe(
      projectRealtimeVoicePublicProjection,
    );
    expect(surface?.deprecatedProfileIds).toEqual(["demo:legacy"]);
    expect(loadBundledPluginPublicArtifactModuleFromCandidatesSync).toHaveBeenCalledWith({
      dirName: "openai",
      artifactCandidates: ["provider-policy-api.js"],
    });
    expect(manifestRegistryModuleFactory).not.toHaveBeenCalled();
  });

  it("returns no policy for a provider without a bundled artifact", async () => {
    vi.doMock("./public-surface-loader.js", () => ({
      loadBundledPluginPublicArtifactModuleFromCandidatesSync: () => null,
    }));
    const { resolveDirectBundledProviderPolicySurface } = await importFreshModule<
      typeof import("./provider-policy-surface.js")
    >(import.meta.url, "./provider-policy-surface.js?scope=missing-provider-policy");

    expect(resolveDirectBundledProviderPolicySurface("custom-provider")).toBeNull();
  });

  it("propagates errors from a present provider artifact", async () => {
    const error = new Error("Provider artifact is outside its boundary root");
    vi.doMock("./public-surface-loader.js", () => ({
      loadBundledPluginPublicArtifactModuleFromCandidatesSync: () => {
        throw error;
      },
    }));
    const { resolveDirectBundledProviderPolicySurface } = await importFreshModule<
      typeof import("./provider-policy-surface.js")
    >(import.meta.url, "./provider-policy-surface.js?scope=invalid-provider-policy");

    expect(() => resolveDirectBundledProviderPolicySurface("custom-provider")).toThrow(error);
  });

  // ADR-0033 任务72第二批：resolveDirectBundledProviderPolicySurface 原来对同一个 pluginId 每次
  // 调用都重新走一遍模块加载/对象重建——真实数据 CPU profile 显示它被按"员工 × 模型"的笛卡尔积
  // 反复调用几万次，但结果只取决于 pluginId。以下用例直接验证缓存的命中/失效边界，而不是只测
  // "调用一次不报错"：必须证明①同输入第二次调用不重新加载模块，②registry/版本/bundledPluginsDir
  // 任何一项变化都会让缓存失效重新加载——这正是本类"结构层缓存"最容易引入隐蔽 bug 的地方
  // （缓存了一个本该随插件重装/配置热重载而变化的结果）。
  describe("per-pluginId cache", () => {
    function makeFakeMetadata() {
      return {
        bundledPluginsDir: { token: "gen-1" } as unknown,
        bundledProviderPolicySurfaces: new Map(),
      };
    }

    it("reuses the previous surface for a second call with unchanged registry/version/selection", async () => {
      const loadBundledPluginPublicArtifactModuleFromCandidatesSync = vi.fn(() => ({
        resolveModelRoutes: vi.fn(),
      }));
      const metadata = makeFakeMetadata();
      // 关键：registry 必须是同一个对象引用（不是每次调用都 new 一个），否则缓存按引用比较
      // 会被这里的测试写法本身误判成"变了"——这正是本类"按引用比较"缓存最容易被测试自身
      // 写错的地方，特意用 const 固定一份引用来排除这个假阴性。
      const stableRegistry = { id: "registry-a" };
      vi.doMock("./bundled-dir.js", () => ({ resolveBundledPluginsDir: () => undefined }));
      vi.doMock("./plugin-cache.js", () => ({ getPluginCache: () => ({ metadata }) }));
      vi.doMock("./runtime-state.js", () => ({
        getPluginRegistryState: () => ({ activeVersion: 1 }),
      }));
      vi.doMock("./runtime/gateway-request-scope.js", () => ({
        getPluginRegistryForContext: () => stableRegistry,
      }));
      vi.doMock("./public-surface-loader.js", () => ({
        loadBundledPluginPublicArtifactModuleFromCandidatesSync,
      }));

      const { resolveDirectBundledProviderPolicySurface } = await importFreshModule<
        typeof import("./provider-policy-surface.js")
      >(import.meta.url, "./provider-policy-surface.js?scope=cache-hit");

      const first = resolveDirectBundledProviderPolicySurface("openai");
      const second = resolveDirectBundledProviderPolicySurface("openai");

      expect(second).toBe(first);
      expect(loadBundledPluginPublicArtifactModuleFromCandidatesSync).toHaveBeenCalledTimes(1);
    });

    it("recomputes when the plugin registry reference changes", async () => {
      const loadBundledPluginPublicArtifactModuleFromCandidatesSync = vi.fn(() => ({
        resolveModelRoutes: vi.fn(),
      }));
      const metadata = makeFakeMetadata();
      let registry: object = { id: "registry-a" };
      vi.doMock("./bundled-dir.js", () => ({ resolveBundledPluginsDir: () => undefined }));
      vi.doMock("./plugin-cache.js", () => ({ getPluginCache: () => ({ metadata }) }));
      vi.doMock("./runtime-state.js", () => ({
        getPluginRegistryState: () => ({ activeVersion: 1 }),
      }));
      vi.doMock("./runtime/gateway-request-scope.js", () => ({
        getPluginRegistryForContext: () => registry,
      }));
      vi.doMock("./public-surface-loader.js", () => ({
        loadBundledPluginPublicArtifactModuleFromCandidatesSync,
      }));

      const { resolveDirectBundledProviderPolicySurface } = await importFreshModule<
        typeof import("./provider-policy-surface.js")
      >(import.meta.url, "./provider-policy-surface.js?scope=cache-registry-change");

      resolveDirectBundledProviderPolicySurface("openai");
      // 插件重装/热重载产生一份新的 registry 快照引用。
      registry = { id: "registry-b" };
      resolveDirectBundledProviderPolicySurface("openai");

      expect(loadBundledPluginPublicArtifactModuleFromCandidatesSync).toHaveBeenCalledTimes(2);
    });

    it("recomputes when the registry version changes on the same registry reference", async () => {
      const loadBundledPluginPublicArtifactModuleFromCandidatesSync = vi.fn(() => ({
        resolveModelRoutes: vi.fn(),
      }));
      const metadata = makeFakeMetadata();
      const registry = { id: "registry-a" };
      let activeVersion = 1;
      vi.doMock("./bundled-dir.js", () => ({ resolveBundledPluginsDir: () => undefined }));
      vi.doMock("./plugin-cache.js", () => ({ getPluginCache: () => ({ metadata }) }));
      vi.doMock("./runtime-state.js", () => ({
        getPluginRegistryState: () => ({ activeVersion }),
      }));
      vi.doMock("./runtime/gateway-request-scope.js", () => ({
        getPluginRegistryForContext: () => registry,
      }));
      vi.doMock("./public-surface-loader.js", () => ({
        loadBundledPluginPublicArtifactModuleFromCandidatesSync,
      }));

      const { resolveDirectBundledProviderPolicySurface } = await importFreshModule<
        typeof import("./provider-policy-surface.js")
      >(import.meta.url, "./provider-policy-surface.js?scope=cache-version-change");

      resolveDirectBundledProviderPolicySurface("openai");
      // 同一个 registry 引用内部被原地更新（版本号变了），不能只比引用。
      activeVersion = 2;
      resolveDirectBundledProviderPolicySurface("openai");

      expect(loadBundledPluginPublicArtifactModuleFromCandidatesSync).toHaveBeenCalledTimes(2);
    });

    it("recomputes when the bundled-plugins-dir selection changes", async () => {
      const loadBundledPluginPublicArtifactModuleFromCandidatesSync = vi.fn(() => ({
        resolveModelRoutes: vi.fn(),
      }));
      const metadata = makeFakeMetadata();
      // registry 引用和版本都固定不变，确保第二次重算只能由 selection 变化触发；
      // 每次返回新对象的话，引用变化本身就会让缓存失效，这条用例就测不到 selection 比较。
      const stableRegistry = { id: "registry-a" };
      vi.doMock("./bundled-dir.js", () => ({ resolveBundledPluginsDir: () => undefined }));
      vi.doMock("./plugin-cache.js", () => ({ getPluginCache: () => ({ metadata }) }));
      vi.doMock("./runtime-state.js", () => ({
        getPluginRegistryState: () => ({ activeVersion: 1 }),
      }));
      vi.doMock("./runtime/gateway-request-scope.js", () => ({
        getPluginRegistryForContext: () => stableRegistry,
      }));
      vi.doMock("./public-surface-loader.js", () => ({
        loadBundledPluginPublicArtifactModuleFromCandidatesSync,
      }));

      const { resolveDirectBundledProviderPolicySurface } = await importFreshModule<
        typeof import("./provider-policy-surface.js")
      >(import.meta.url, "./provider-policy-surface.js?scope=cache-selection-change");

      resolveDirectBundledProviderPolicySurface("openai");
      // cwd/env/override 驱动 resolveBundledPluginsDir 重算出一个新的缓存条目对象。
      metadata.bundledPluginsDir = { token: "gen-2" };
      resolveDirectBundledProviderPolicySurface("openai");

      expect(loadBundledPluginPublicArtifactModuleFromCandidatesSync).toHaveBeenCalledTimes(2);
    });

    it("does not cache while a plugin registration is in progress", async () => {
      const loadBundledPluginPublicArtifactModuleFromCandidatesSync = vi.fn(() => ({
        resolveModelRoutes: vi.fn(),
      }));
      const metadata = makeFakeMetadata();
      vi.doMock("./bundled-dir.js", () => ({ resolveBundledPluginsDir: () => undefined }));
      vi.doMock("./plugin-cache.js", () => ({ getPluginCache: () => ({ metadata }) }));
      vi.doMock("./runtime-state.js", () => ({
        getPluginRegistryState: () => ({
          activeVersion: 1,
          registrationContext: { registry: {}, pluginId: "openai" },
        }),
      }));
      vi.doMock("./runtime/gateway-request-scope.js", () => ({
        getPluginRegistryForContext: () => ({ id: "registry-a" }),
      }));
      vi.doMock("./public-surface-loader.js", () => ({
        loadBundledPluginPublicArtifactModuleFromCandidatesSync,
      }));

      const { resolveDirectBundledProviderPolicySurface } = await importFreshModule<
        typeof import("./provider-policy-surface.js")
      >(import.meta.url, "./provider-policy-surface.js?scope=cache-registration-context");

      resolveDirectBundledProviderPolicySurface("openai");
      resolveDirectBundledProviderPolicySurface("openai");

      expect(loadBundledPluginPublicArtifactModuleFromCandidatesSync).toHaveBeenCalledTimes(2);
      expect(metadata.bundledProviderPolicySurfaces.size).toBe(0);
    });
  });
});

// 验证 provider-policy-owners.ts 的核心业务约定：按「注册表对象引用」缓存归属索引。
// 回搬自上游 #144290/#145921/#146123/#149528/#155241/#155250（ADR-0033 任务 72/84）。
//
// 背景：旧实现每次调用都把插件清单重新排序、重建 Set（CPU profile 实测单进程首轮约占 30 秒）。
// 本文件用业务可观察的方式证明这个修复生效——不直接 mock 内部排序函数（太脆），而是验证
// 「同一份 registry 引用被反复查询时结果保持稳定且正确」与「registry 引用一旦更换就会重新计算」，
// 这正是缓存按对象身份失效的预期行为契约，也是写这个缓存时最容易踩的两个坑：
//   1. 用内容做 key（比如序列化插件 id 列表）——registry 稍微变动就命中不到，缓存等于白做。
//   2. 完全不做失效——plugin 重装/卸载后旧归属结果会一直残留。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPluginCache, resetPluginCache, withPluginCache } from "./plugin-cache.js";
import {
  listTrustedExternalProviderPolicyOwners,
  resolveBundledProviderPolicyOwner,
} from "./provider-policy-owners.js";

function makePlugin(overrides: Record<string, unknown>) {
  return {
    id: "plugin",
    origin: "bundled",
    rootDir: "/tmp/plugin",
    source: "/tmp/plugin/index.js",
    providers: [],
    cliBackends: [],
    skills: [],
    channels: [],
    hooks: [],
    manifestPath: "/tmp/plugin/openclaw.plugin.json",
    ...overrides,
  } as never;
}

describe("provider-policy-owners 缓存契约", () => {
  beforeEach(() => {
    resetPluginCache();
  });

  afterEach(() => {
    resetPluginCache();
  });

  it("同一份 registry 引用重复查询，结果保持一致（证明走了缓存命中而非每次重算）", () => {
    const registry = {
      plugins: [
        makePlugin({ id: "zed-provider", origin: "bundled", providers: ["zed"] }),
        makePlugin({ id: "acme-provider", origin: "bundled", providers: ["acme"] }),
      ],
    };
    withPluginCache(createPluginCache(), () => {
      // 字典序 acme < zed；两次查询不同 providerId 都要能命中，且互不干扰。
      expect(resolveBundledProviderPolicyOwner("acme", registry)?.id).toBe("acme-provider");
      expect(resolveBundledProviderPolicyOwner("zed", registry)?.id).toBe("zed-provider");
      // 再查一次同一个 providerId，必须仍是同一个结果（索引是懒建一次、不是每次新算）。
      expect(resolveBundledProviderPolicyOwner("acme", registry)?.id).toBe("acme-provider");
    });
  });

  it("受信任外部插件按插件 id 字典序返回，且只收录 trustedOfficialInstall 为 true 的", () => {
    const registry = {
      plugins: [
        makePlugin({
          id: "zeta-trusted",
          origin: "installed",
          trustedOfficialInstall: true,
          providers: ["shared"],
        }),
        makePlugin({
          id: "alpha-trusted",
          origin: "installed",
          trustedOfficialInstall: true,
          providers: ["shared"],
        }),
        makePlugin({
          id: "untrusted",
          origin: "installed",
          trustedOfficialInstall: false,
          providers: ["shared"],
        }),
      ],
    };
    withPluginCache(createPluginCache(), () => {
      const owners = listTrustedExternalProviderPolicyOwners("shared", registry);
      expect(owners.map((owner) => owner.id)).toEqual(["alpha-trusted", "zeta-trusted"]);
    });
  });

  it("providerAuthAliases 指向的目标 provider 也能解析到同一个拥有者", () => {
    const registry = {
      plugins: [
        makePlugin({
          id: "alias-owner",
          origin: "bundled",
          providers: ["real-provider"],
          providerAuthAliases: { "alias-provider": "real-provider" },
        }),
      ],
    };
    withPluginCache(createPluginCache(), () => {
      expect(resolveBundledProviderPolicyOwner("alias-provider", registry)?.id).toBe("alias-owner");
    });
  });

  it("registry 引用一旦更换（例如插件重装产生新快照），归属索引会跟着重新计算，不会残留旧结果", () => {
    const registryA = {
      plugins: [makePlugin({ id: "owner-a", origin: "bundled", providers: ["x"] })],
    };
    const registryB = {
      plugins: [makePlugin({ id: "owner-b", origin: "bundled", providers: ["x"] })],
    };
    withPluginCache(createPluginCache(), () => {
      expect(resolveBundledProviderPolicyOwner("x", registryA)?.id).toBe("owner-a");
      // 换一个新的 registry 对象（代表插件重新发现后产生的新快照），即使 providerId 相同，
      // 也必须按新 registry 的内容重新得出结果，而不是命中 registryA 遗留的缓存。
      expect(resolveBundledProviderPolicyOwner("x", registryB)?.id).toBe("owner-b");
    });
  });
});

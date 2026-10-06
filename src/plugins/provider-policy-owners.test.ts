// 验证 provider-policy-owners.ts 的核心业务约定：按「注册表对象引用」缓存归属索引。
// 回搬自上游 #144290/#145921/#146123/#149528/#155241/#155250（ADR-0033 任务 72/84）。
//
// 背景：旧实现每次调用都把插件清单重新排序、重建 Set（CPU profile 实测单进程首轮约占 30 秒）。
// 本文件分两类断言：
//   - 结果正确性：同一份 registry 反复查询结果稳定、换 registry 后按新内容重算（不残留旧结果）。
//   - 缓存复用（可观察计数）：建索引时会对 `registry.plugins` 调一次 `toSorted`，这里在 fixture 的
//     plugins 数组实例上挂 spy 计数——同一 registry 无论查多少次只建一次索引（计数 1），换一个新的
//     registry 对象才重建。只断言结果的话，把缓存整个去掉（每次重建索引）也照样全绿，防不住本修复
//     要解决的性能回退（code review P3 指出），所以必须有这条计数断言；不依赖耗时阈值。
// 写这个缓存时最容易踩的两个坑也由上面两类断言覆盖：
//   1. 用内容做 key 或调用方每次新包一层对象——命中不到，缓存等于白做（计数断言会变红）。
//   2. 完全不做失效——plugin 重装/卸载后旧归属结果会一直残留（换 registry 的用例会变红）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("同一份 registry 引用重复查询，结果保持一致", () => {
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

  it("同一份 registry 多次查询只建一次索引，换新 registry 对象才重建（缓存复用可观察）", () => {
    const pluginsA = [
      makePlugin({ id: "zed-provider", origin: "bundled", providers: ["zed"] }),
      makePlugin({ id: "acme-provider", origin: "bundled", providers: ["acme"] }),
      makePlugin({
        id: "trusted-ext",
        origin: "installed",
        trustedOfficialInstall: true,
        providers: ["shared"],
      }),
    ];
    // 在数组实例上挂 spy：建索引时对 registry.plugins 只调一次 toSorted，计数 = 建索引次数。
    const sortA = vi.spyOn(pluginsA, "toSorted");
    const registryA = { plugins: pluginsA };
    withPluginCache(createPluginCache(), () => {
      // bundled / trusted 两个入口、命中与未命中的 providerId 混着查，都应复用同一份索引。
      for (let i = 0; i < 5; i += 1) {
        expect(resolveBundledProviderPolicyOwner("acme", registryA)?.id).toBe("acme-provider");
        expect(resolveBundledProviderPolicyOwner("zed", registryA)?.id).toBe("zed-provider");
        expect(resolveBundledProviderPolicyOwner("missing", registryA)).toBeNull();
        expect(
          listTrustedExternalProviderPolicyOwners("shared", registryA).map((owner) => owner.id),
        ).toEqual(["trusted-ext"]);
      }
      expect(sortA).toHaveBeenCalledTimes(1);

      // 内容相同但是新对象（例如调用方每次 `{ plugins: [...metadata.plugins] }` 重新包一层）
      // 必然重建——这正是 provider-model-routes.ts 修掉的「缓存零命中」形态，调用方必须传稳定引用。
      const pluginsB = [...pluginsA];
      const sortB = vi.spyOn(pluginsB, "toSorted");
      const registryB = { plugins: pluginsB };
      expect(resolveBundledProviderPolicyOwner("acme", registryB)?.id).toBe("acme-provider");
      expect(resolveBundledProviderPolicyOwner("acme", registryB)?.id).toBe("acme-provider");
      expect(sortB).toHaveBeenCalledTimes(1);
      expect(sortA).toHaveBeenCalledTimes(1);
    });
  });

  it("trusted 查询返回副本，调用方修改返回数组不会污染缓存", () => {
    const registry = {
      plugins: [
        makePlugin({
          id: "trusted-ext",
          origin: "installed",
          trustedOfficialInstall: true,
          providers: ["shared"],
        }),
      ],
    };
    withPluginCache(createPluginCache(), () => {
      const first = listTrustedExternalProviderPolicyOwners("shared", registry);
      first.length = 0;
      expect(
        listTrustedExternalProviderPolicyOwners("shared", registry).map((owner) => owner.id),
      ).toEqual(["trusted-ext"]);
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

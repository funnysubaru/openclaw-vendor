// 回搬自上游 provider 策略查询性能修复系列（#144290/#145921/#146123/#149528/#155241/#155250，
// ADR-0033 任务 72/84）。
//
// 业务背景：每次解析一个 provider（如 openai / anthropic）该走哪个插件的策略钩子（OAuth、
// 计费头、模型目录等），旧实现都要把全部已加载插件 toSorted(localeCompare) 重新排序一遍，
// 并为逐个候选插件重建一个 Set（providers + cliBackends + embeddingProviders 合并归一化）。
// CPU profile 实测：冷启动首轮 / 换模型后首条消息，这一步单进程能占到约 30 秒（见
// 产品文档/02.ADR/ADR-0033 任务 72、84）。
//
// 本文件没有照搬上游同名文件的完整实现——上游那版耦合进了一个更大的插件配置/快照重构
// （hardlink-policy / plugin-setup-module / normalizePluginsConfig 等，我们当前 pin 还没有这些
// 模块，硬搬会把不相关的大改动一起拉进来）。这里按上游同一思路做了一次更小的对齐实现：
// 用插件注册表对象自身的引用身份（registry.plugins 在同一次 Gateway 运行期间是稳定引用，
// 见 manifest-registry.ts 的 loadPluginManifestRegistryCore）做 key，懒加载建一次索引、
// 缓存进现有的 PluginCache（plugin-cache.ts 的 getPluginCache()，与 channelAdapters /
// staticCatalogStates 等既有缓存槛同一套机制），避免每次调用都重新排序 + 重建 Set。
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { PluginManifestRecord } from "./manifest-registry.types.js";
import { getPluginCache } from "./plugin-cache.js";
import type { ProviderPolicyOwnerIndex } from "./provider-policy-owners.types.js";

type ProviderPolicyRegistry = { plugins: readonly PluginManifestRecord[] };

/** 插件是否声明了（而非经由别名）拥有这个归一化后的 providerId。 */
function pluginDeclaresProviderPolicyRef(
  plugin: PluginManifestRecord,
  normalizedProviderId: string,
): boolean {
  if (!normalizedProviderId) {
    return false;
  }
  for (const provider of plugin.providers) {
    if (normalizeProviderId(provider) === normalizedProviderId) {
      return true;
    }
  }
  for (const provider of plugin.cliBackends) {
    if (normalizeProviderId(provider) === normalizedProviderId) {
      return true;
    }
  }
  for (const provider of plugin.contracts?.embeddingProviders ?? []) {
    if (normalizeProviderId(provider) === normalizedProviderId) {
      return true;
    }
  }
  return false;
}

/** 插件是否拥有这个 providerId（直接声明，或通过 providerAuthAliases 别名指向一个直接声明）。 */
function pluginOwnsProviderPolicyRef(
  plugin: PluginManifestRecord,
  normalizedProviderId: string,
): boolean {
  if (pluginDeclaresProviderPolicyRef(plugin, normalizedProviderId)) {
    return true;
  }
  for (const [rawAlias, rawTarget] of Object.entries(plugin.providerAuthAliases ?? {})) {
    // 别名目标目前只支持字符串形式（{provider,baseUrls} 形式不在策略归属判定范围内，
    // 与回搬前的既有实现保持一致）。
    if (typeof rawTarget !== "string") {
      continue;
    }
    if (
      normalizeProviderId(rawAlias) === normalizedProviderId &&
      pluginDeclaresProviderPolicyRef(plugin, normalizeProviderId(rawTarget))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 对整份注册表扫描一遍，建出 providerId → 归属插件 的索引。
 * 只在每个 registry 对象第一次被查询时跑一遍（O(插件数)），之后同一注册表引用全部走索引命中。
 */
function buildProviderPolicyOwnerIndex(registry: ProviderPolicyRegistry): ProviderPolicyOwnerIndex {
  const index: ProviderPolicyOwnerIndex = { bundled: new Map(), trusted: new Map() };
  // 按插件 id 字典序遍历一次：bundled 侧第一个命中的即为旧实现 toSorted 后"取第一个匹配"的结果，
  // trusted 侧顺带就是排好序的列表，不需要再排一次。
  for (const plugin of registry.plugins.toSorted((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    if (plugin.origin !== "bundled" && plugin.trustedOfficialInstall !== true) {
      continue;
    }
    // 收集这个插件可能拥有的全部 providerId 候选（直接声明 + 别名来源），再逐个判定归属，
    // 避免对完全不相关的 providerId 做无意义的归属判定。
    const candidateIds = new Set(
      [
        ...plugin.providers,
        ...plugin.cliBackends,
        ...(plugin.contracts?.embeddingProviders ?? []),
        ...Object.keys(plugin.providerAuthAliases ?? {}),
      ].map((id) => normalizeProviderId(id)),
    );
    for (const providerId of candidateIds) {
      if (!providerId || !pluginOwnsProviderPolicyRef(plugin, providerId)) {
        continue;
      }
      if (plugin.origin === "bundled" && !index.bundled.has(providerId)) {
        index.bundled.set(providerId, plugin);
      }
      if (plugin.trustedOfficialInstall === true) {
        const owners = index.trusted.get(providerId) ?? [];
        owners.push(plugin);
        index.trusted.set(providerId, owners);
      }
    }
  }
  return index;
}

/** 懒加载获取（或建好并缓存）这份注册表对应的归属索引。 */
function getOrBuildProviderPolicyOwnerIndex(
  registry: ProviderPolicyRegistry,
): ProviderPolicyOwnerIndex {
  const cache = getPluginCache().metadata.providerPolicyOwners;
  let index = cache.get(registry);
  if (!index) {
    index = buildProviderPolicyOwnerIndex(registry);
    cache.set(registry, index);
  }
  return index;
}

/** 解析一个 providerId 对应的随包（bundled）策略归属插件；没有命中返回 null。 */
export function resolveBundledProviderPolicyOwner(
  normalizedProviderId: string,
  registry: ProviderPolicyRegistry,
): PluginManifestRecord | null {
  if (!normalizedProviderId) {
    return null;
  }
  return getOrBuildProviderPolicyOwnerIndex(registry).bundled.get(normalizedProviderId) ?? null;
}

/** 列出受信任的已安装外部插件中，拥有这个 provider 策略引用的那些（按插件 id 字典序）。 */
export function listTrustedExternalProviderPolicyOwners(
  providerId: string,
  registry: ProviderPolicyRegistry,
): PluginManifestRecord[] {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!normalizedProviderId) {
    return [];
  }
  return [
    ...(getOrBuildProviderPolicyOwnerIndex(registry).trusted.get(normalizedProviderId) ?? []),
  ];
}

import path from "node:path";
// Extracts provider public artifacts from plugin metadata.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import {
  loadPluginManifestRegistryCore,
  type PluginManifestRegistry,
} from "./manifest-registry.js";
import {
  resolveBundledProviderPolicyOwner,
  listTrustedExternalProviderPolicyOwners as listTrustedExternalProviderPolicyOwnersIndexed,
} from "./provider-policy-owners.js";
import {
  resolveDirectBundledProviderPolicySurface,
  resolveTrustedExternalProviderPolicySurface,
  type BundledProviderPolicySurface,
  type ProviderPolicySurface,
} from "./provider-policy-surface.js";

// 这里特意用 readonly 而不是 Pick<PluginManifestRegistry, "plugins">（mutable 数组）：
// 调用方（如 provider-model-routes.ts）要传的是当前插件元数据快照本身（其 plugins 字段是
// readonly，Gateway 运行期间稳定不变、可按引用缓存），不该为了凑类型再 spread 复制一份——
// 复制出的新数组每次调用都是新对象，会让 provider-policy-owners.ts 的按引用缓存全部失效。
type ProviderPolicyRegistryLike = { plugins: readonly PluginManifestRegistry["plugins"][number][] };

type ProviderPolicyMetadata = {
  manifestRegistry?: ProviderPolicyRegistryLike;
  loadManifestRegistry?: () => ProviderPolicyRegistryLike | undefined;
};

// 回搬自上游 #144290/#145921/#146123/#149528/#155241/#155250（ADR-0033 任务 72/84）：
// 原先这里会在每次调用时把整份插件清单 toSorted(localeCompare) 重排一遍，并为每个候选插件
// 重建一次 providers/cliBackends/embeddingProviders 的归一化 Set——真正的归属判定逻辑已经
// 挪到 provider-policy-owners.ts，按注册表对象身份缓存成一份索引，这里只是转发调用。
function resolveBundledProviderPolicyPlugin(
  providerId: string,
  options: ProviderPolicyMetadata = {},
): PluginManifestRegistry["plugins"][number] | null {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!normalizedProviderId) {
    return null;
  }
  const bundledPluginsDir = resolveBundledPluginsDir();
  if (!bundledPluginsDir) {
    return null;
  }

  const registry =
    options.manifestRegistry ??
    options.loadManifestRegistry?.() ??
    loadPluginManifestRegistryCore();
  return resolveBundledProviderPolicyOwner(normalizedProviderId, registry);
}

/** Resolves provider policy hooks for a bundled provider or its owning plugin. */
export function resolveBundledProviderPolicySurface(
  providerId: string,
  options: ProviderPolicyMetadata = {},
): BundledProviderPolicySurface | null {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!normalizedProviderId) {
    return null;
  }
  const directSurface = resolveDirectBundledProviderPolicySurface(normalizedProviderId);
  if (directSurface) {
    return directSurface;
  }
  const ownerPlugin = resolveBundledProviderPolicyPlugin(normalizedProviderId, options);
  if (ownerPlugin) {
    const ownerSurface = resolveDirectBundledProviderPolicySurface(ownerPlugin.id);
    if (ownerSurface) {
      return ownerSurface;
    }
  }
  if (!ownerPlugin) {
    return null;
  }
  // A stable plugin id can differ from its stock directory name. Use the
  // registry-owned root basename so its pre-runtime policy stays discoverable.
  return resolveDirectBundledProviderPolicySurface(path.basename(ownerPlugin.rootDir));
}

/** Resolves provider policy hooks from bundled or trusted official plugin artifacts. */
export function resolveProviderPolicySurface(
  providerId: string,
  options: { manifestRegistry?: ProviderPolicyRegistryLike } = {},
): ProviderPolicySurface | null {
  const bundledSurface = resolveBundledProviderPolicySurface(providerId, options);
  if (bundledSurface) {
    return bundledSurface;
  }
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!normalizedProviderId || !options.manifestRegistry) {
    return null;
  }
  return (
    loadTrustedExternalProviderPolicyArtifacts(
      listTrustedExternalProviderPolicyOwners(providerId, options.manifestRegistry),
    )?.surface ?? null
  );
}

/** Loads the first usable policy surface from caller-selected trusted owners. */
export function loadTrustedExternalProviderPolicyArtifacts(
  owners: PluginManifestRegistry["plugins"],
) {
  for (const owner of owners) {
    const surface = resolveTrustedExternalProviderPolicySurface({
      pluginId: owner.id,
      pluginRoot: owner.rootDir,
      trustedOfficialInstall: owner.trustedOfficialInstall,
    });
    if (surface) {
      return { owner, surface };
    }
  }
  const owner = owners[0];
  return owner ? { owner, surface: null } : null;
}

/** Lists trusted installed plugins that own a provider policy reference. */
export function listTrustedExternalProviderPolicyOwners(
  providerId: string,
  manifestRegistry: ProviderPolicyRegistryLike,
) {
  return listTrustedExternalProviderPolicyOwnersIndexed(providerId, manifestRegistry);
}

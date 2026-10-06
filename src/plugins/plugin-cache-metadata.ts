import type { BundledStaticCatalogState } from "../agents/embedded-agent-runner/model.static-catalog.types.js";
import type { BundledChannelCatalogEntry } from "../channels/bundled-channel-catalog.types.js";
import type { ManifestChannelPlugin } from "../channels/plugins/manifest-channel-plugin.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginDiscoveryResult } from "./discovery.types.js";
import type {
  InstalledPluginIndex,
  InstalledPluginIndexFacts,
} from "./installed-plugin-index-types.js";
import type { ManifestModelSuppressionResolver } from "./manifest-model-suppression.types.js";
import type { PluginManifestRecord } from "./manifest-registry.types.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import type { ProviderPolicyOwnerIndex } from "./provider-policy-owners.types.js";

type CurrentPluginMetadataCacheState = {
  snapshot: unknown;
  owner: "gateway" | "operation";
  configFingerprint: string | undefined;
  envFingerprint: string | undefined;
  defaultDiscoveryCompatible: boolean;
  compatiblePolicyHashes: readonly string[] | undefined;
  compatibleConfigFingerprints: readonly string[] | undefined;
  revision: symbol;
  configIdentities: WeakSet<OpenClawConfig>;
};

export type PluginCacheMetadata = {
  metadata: {
    bundledPluginsDir?: { key: string; value: string | undefined };
    bundledDiscoveryMode?: { value: "compat" | "allowlist" | undefined };
    current: CurrentPluginMetadataCacheState;
    snapshots: Map<string, PluginMetadataSnapshot>;
    discovery: Map<string, PluginDiscoveryResult>;
    discoveryMountPoints?: ReadonlySet<string>;
    projections: WeakMap<PluginMetadataSnapshot, Map<string, PluginMetadataSnapshot>>;
    projectionSources: WeakMap<PluginMetadataSnapshot, PluginMetadataSnapshot>;
    completions: WeakMap<PluginMetadataSnapshot, PluginMetadataSnapshot>;
    indexFacts: WeakMap<InstalledPluginIndex, InstalledPluginIndexFacts>;
    channelAdapters: WeakMap<PluginManifestRecord, Map<string, ManifestChannelPlugin | undefined>>;
    bundledChannelCatalogs: Map<string, BundledChannelCatalogEntry[]>;
    staticCatalogStates: WeakMap<object, WeakMap<OpenClawConfig, BundledStaticCatalogState>>;
    // 回搬自上游 #144290/#145921/#146123/#149528/#155241/#155250（provider 策略查询性能修复，ADR-0033 任务 72/84）。
    // registry.plugins 在同一次 Gateway 启动期间是稳定引用（loadPluginManifestRegistryCore 返回同一份
    // gatewaySnapshot.manifestRegistry），按 registry 对象身份做一次性索引缓存，避免每次 provider 策略查询
    // 都重新 toSorted(localeCompare) + 为每个插件重建 Set（CPU profile 实测单进程首轮约占 30 秒）。
    providerPolicyOwners: WeakMap<object, ProviderPolicyOwnerIndex>;
    modelSuppressionResolvers: WeakMap<
      PluginMetadataSnapshot,
      {
        unconfigured?: ManifestModelSuppressionResolver;
        byConfig: WeakMap<OpenClawConfig, ManifestModelSuppressionResolver>;
      }
    >;
  };
};

export function createPluginCacheMetadata(): PluginCacheMetadata {
  return {
    metadata: {
      current: {
        snapshot: undefined,
        owner: "operation",
        configFingerprint: undefined,
        envFingerprint: undefined,
        defaultDiscoveryCompatible: false,
        compatiblePolicyHashes: undefined,
        compatibleConfigFingerprints: undefined,
        revision: Symbol("plugin-metadata-snapshot"),
        configIdentities: new WeakSet(),
      },
      snapshots: new Map(),
      discovery: new Map(),
      projections: new WeakMap(),
      projectionSources: new WeakMap(),
      completions: new WeakMap(),
      indexFacts: new WeakMap(),
      channelAdapters: new WeakMap(),
      bundledChannelCatalogs: new Map(),
      staticCatalogStates: new WeakMap(),
      modelSuppressionResolvers: new WeakMap(),
      providerPolicyOwners: new WeakMap(),
    },
  };
}

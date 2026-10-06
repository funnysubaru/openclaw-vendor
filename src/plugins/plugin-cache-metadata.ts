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
    // 回搬自上游 #145226（ADR-0033 任务 72 第二批）：原实现每次调用 resolveBundledPluginsDir
    // 都要 JSON.stringify 一个 7 元组（含 import.meta.url / argv[1] / execPath / cwd 等）拼出
    // 缓存键字符串，命中缓存时这次字符串分配 + 拼接纯属浪费——provider 策略查询会对模型目录
    // 的每个 provider/model 都调一次这里。改成按字段逐一比较，缓存命中时零分配；只有任意一个
    // 输入字段真的变化（如 cwd 切换、env override 改了、gateway 重启换了新 metadata owner）
    // 时才会落到 resolveBundledPluginsDirUncached 重新计算。
    bundledPluginsDir?: {
      moduleUrl: string;
      disabled: boolean;
      resolvedOverride: string | undefined;
      trustOverride: boolean;
      argv1: string | undefined;
      execPath: string;
      cwd: string | undefined;
      value: string | undefined;
    };
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

/** Lightweight direct loader for bundled provider policy public artifacts. */
import type { ModelProviderConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  ProviderFastModePolicyContext,
  ProviderModelRouteResolution,
  ProviderNormalizeModelCatalogIdContext,
  ProviderResponseModelEquivalenceContext,
  ProviderResolveModelRoutesContext,
  ProviderToolSearchPolicyContext,
} from "../plugin-sdk/provider-model-types.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import { getPluginCache } from "./plugin-cache.js";
import type {
  ProviderApplyConfigDefaultsContext,
  ProviderNormalizeConfigContext,
  ProviderResolveConfigApiKeyContext,
} from "./provider-config-context.types.js";
import type { ProviderRuntimeModel } from "./provider-runtime-model.types.js";
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "./provider-thinking.types.js";
import {
  loadBundledPluginPublicArtifactModuleFromCandidatesSync,
  loadPluginPublicArtifactModuleSync,
} from "./public-surface-loader.js";
import { getPluginRegistryState } from "./runtime-state.js";
import { getPluginRegistryForContext } from "./runtime/gateway-request-scope.js";

const PROVIDER_POLICY_ARTIFACT_CANDIDATES = ["provider-policy-api.js"] as const;

type ProviderProjectConfiguredModelRowContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  provider: string;
  modelId: string;
  model: ProviderRuntimeModel;
};

type ProviderProjectRealtimeVoicePublicConfigContext = {
  providerConfig: Record<string, unknown>;
  config: Record<string, unknown>;
};

export type RealtimeVoicePublicClientHints = {
  modelSource?: "gateway";
  gatewayRelaySupported?: boolean;
};

export type RealtimeVoicePublicProjection = {
  config: Record<string, unknown>;
  clientHints?: RealtimeVoicePublicClientHints;
};

type EmbeddingProviderSetupInspection = {
  provider: string;
  reason: string;
  requirement?: string;
  fixHint?: string;
};

export type InspectEmbeddingProviderSetup = (params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  agentId: string;
  provider: string;
}) => EmbeddingProviderSetupInspection | null | Promise<EmbeddingProviderSetupInspection | null>;

/** Provider policy hooks supported by bundled and trusted official plugins. */
export type ProviderPolicySurface = {
  resolveFastModeSupport?: (ctx: ProviderFastModePolicyContext) => boolean | undefined;
  deprecatedProfileIds?: readonly string[];
  normalizeConfig?: (ctx: ProviderNormalizeConfigContext) => ModelProviderConfig | null | undefined;
  applyConfigDefaults?: (
    ctx: ProviderApplyConfigDefaultsContext,
  ) => OpenClawConfig | null | undefined;
  resolveConfigApiKey?: (ctx: ProviderResolveConfigApiKeyContext) => string | null | undefined;
  resolveThinkingProfile?: (
    ctx: ProviderDefaultThinkingPolicyContext,
  ) => ProviderThinkingProfile | null | undefined;
  /** Prefer compact tool discovery, or veto a managed-service default for a hosted route. */
  resolveToolSearchMode?: (ctx: ProviderToolSearchPolicyContext) => "tools" | false | undefined;
  resolveModelRoutes?: (
    ctx: ProviderResolveModelRoutesContext,
  ) => ProviderModelRouteResolution | null | undefined;
  normalizeModelCatalogId?: (
    ctx: ProviderNormalizeModelCatalogIdContext,
  ) => string | null | undefined;
  isResponseModelEquivalent?: (
    ctx: ProviderResponseModelEquivalenceContext,
  ) => boolean | null | undefined;
  inspectEmbeddingProviderSetup?: InspectEmbeddingProviderSetup;
};

/** Provider policy hooks loaded only from bundled plugin public artifacts. */
export type BundledProviderPolicySurface = ProviderPolicySurface & {
  projectConfiguredModelRow?: (
    ctx: ProviderProjectConfiguredModelRowContext,
  ) => ProviderRuntimeModel | null | undefined;
  projectRealtimeVoicePublicProjection?: (
    ctx: ProviderProjectRealtimeVoicePublicConfigContext,
  ) => RealtimeVoicePublicProjection | null | undefined;
};

const PROVIDER_POLICY_HOOK_KEYS = [
  "resolveFastModeSupport",
  "normalizeConfig",
  "applyConfigDefaults",
  "resolveConfigApiKey",
  "resolveThinkingProfile",
  "resolveToolSearchMode",
  "resolveModelRoutes",
  "normalizeModelCatalogId",
  "isResponseModelEquivalent",
  "inspectEmbeddingProviderSetup",
] as const satisfies readonly (keyof ProviderPolicySurface)[];

function extractProviderPolicySurface(mod: Record<string, unknown>): ProviderPolicySurface | null {
  const surface: ProviderPolicySurface = {};
  if (
    Array.isArray(mod.deprecatedProfileIds) &&
    mod.deprecatedProfileIds.every((value) => typeof value === "string")
  ) {
    surface.deprecatedProfileIds = mod.deprecatedProfileIds;
  }
  for (const key of PROVIDER_POLICY_HOOK_KEYS) {
    const hook = mod[key];
    if (typeof hook === "function") {
      Object.assign(surface, { [key]: hook });
    }
  }
  return Object.keys(surface).length > 0 ? surface : null;
}

function extractBundledProviderPolicySurface(
  mod: Record<string, unknown>,
): BundledProviderPolicySurface | null {
  const surface: BundledProviderPolicySurface = extractProviderPolicySurface(mod) ?? {};
  if (typeof mod.projectConfiguredModelRow === "function") {
    surface.projectConfiguredModelRow =
      mod.projectConfiguredModelRow as BundledProviderPolicySurface["projectConfiguredModelRow"];
  }
  if (typeof mod.projectRealtimeVoicePublicProjection === "function") {
    Object.assign(surface, {
      projectRealtimeVoicePublicProjection: mod.projectRealtimeVoicePublicProjection,
    });
  }
  return Object.keys(surface).length > 0 ? surface : null;
}

function resolveProviderPolicySurface<T extends ProviderPolicySurface>(params: {
  loadModule: (artifactBasename: string) => Record<string, unknown>;
  missingSurfacePrefix: string;
  extractSurface: (mod: Record<string, unknown>) => T | null;
}): T | null {
  for (const artifactBasename of PROVIDER_POLICY_ARTIFACT_CANDIDATES) {
    try {
      const mod = params.loadModule(artifactBasename);
      const surface = params.extractSurface(mod);
      if (surface) {
        return surface;
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(params.missingSurfacePrefix)) {
        continue;
      }
      throw error;
    }
  }
  return null;
}

/** Loads policy hooks directly by canonical bundled plugin id. */
export function resolveDirectBundledProviderPolicySurface(
  pluginId: string,
): BundledProviderPolicySurface | null {
  // Provider refs are not necessarily plugin directories. Let manifest-owned
  // policy resolution handle namespaced refs without weakening artifact path checks.
  if (
    pluginId === "." ||
    pluginId === ".." ||
    pluginId.includes("/") ||
    pluginId.includes("\\") ||
    pluginId.includes(":")
  ) {
    return null;
  }
  // ADR-0033 任务72第二批（已查上游：当前 src/plugins/provider-policy-surface.ts 的同名函数已有
  // 这层缓存，搬了它的判据设计，但换成我们仓库里实际存在的等价 API——上游用
  // getPluginRegistryVersion(registry) / getPluginValueInstance(mod) / plugin-instance-scope.ts，
  // 这些在我们 pin 上不存在；我们有的是 getPluginRegistryState().activeVersion 和
  // getPluginRegistryForContext()，语义等价，直接复用）。
  //
  // 真实数据 CPU profile 二轮复测实锤：这个函数本身在批一之前完全没有缓存，每次调用都要走一遍
  // loadBundledPluginPublicArtifactModuleFromCandidatesSync 的缓存键计算 + extractBundledProviderPolicySurface
  // 重建对象——而调用方 resolveProviderModelPolicySurface 是按"员工 × 模型"的笛卡尔积反复调用的
  // （见 chat-metadata-runtime.ts 的 buildGeneration 对全量 agent 做 Promise.all），返回值却只取决于
  // pluginId 本身。按 pluginId 缓存一次，让同一个 provider 对所有员工/模型只算一次。
  //
  // 失效边界覆盖三类（coordinator 点名要求）：
  // ① registry 对象引用变了（插件重装/热重载产生新快照）；
  // ② registry 版本号变了（同一个引用内部被原地更新，只比引用不够）；
  // ③ selection 变了（即 resolveBundledPluginsDir 的缓存条目对象——cwd/env/override 任何一项驱动
  //    它重算的输入变了，这里直接复用那次重算产生的新对象当廉价的"代际"标记，不用再自己比 7 个字段）。
  // 整个 Map 又活在随 cache owner 更换（gateway 重启/管理范围切换/config 热重载）而整体丢弃重建的
  // metadata 对象里，所以"config 热重载"这一类失效不需要额外代码，是 metadata 生命周期本身保证的。
  const registry = getPluginRegistryForContext();
  const registryState = getPluginRegistryState();
  // 插件正在注册/热重载中途时，registry 内容可能还没稳定，不缓存这次结果（跟上游的
  // registrationContext 判据同一个意图：宁可多算一次，不要缓存一个还在变化中的插件状态）。
  const cacheable = !registryState?.registrationContext;
  const metadata = getPluginCache().metadata;
  resolveBundledPluginsDir(); // 确保 metadata.bundledPluginsDir 是这次调用时最新的缓存条目对象
  const selection = metadata.bundledPluginsDir;
  const cached = cacheable ? metadata.bundledProviderPolicySurfaces.get(pluginId) : undefined;
  if (
    cached &&
    cached.registry === registry &&
    cached.version === registryState?.activeVersion &&
    cached.selection === selection
  ) {
    return cached.value;
  }
  const mod = loadBundledPluginPublicArtifactModuleFromCandidatesSync<Record<string, unknown>>({
    dirName: pluginId,
    artifactCandidates: PROVIDER_POLICY_ARTIFACT_CANDIDATES,
  });
  const surface = mod ? extractBundledProviderPolicySurface(mod) : null;
  if (cacheable) {
    metadata.bundledProviderPolicySurfaces.set(pluginId, {
      registry,
      version: registryState?.activeVersion,
      selection,
      value: surface,
    });
  }
  return surface;
}

/** Loads policy hooks from a host-verified official external plugin install. */
export function resolveTrustedExternalProviderPolicySurface(params: {
  pluginId: string;
  pluginRoot: string;
  trustedOfficialInstall?: boolean;
}): ProviderPolicySurface | null {
  if (params.trustedOfficialInstall !== true) {
    return null;
  }
  return resolveProviderPolicySurface({
    loadModule: (artifactBasename) =>
      loadPluginPublicArtifactModuleSync<Record<string, unknown>>({
        pluginRoot: params.pluginRoot,
        artifactBasename,
      }),
    missingSurfacePrefix: "Unable to resolve plugin public surface ",
    extractSurface: extractProviderPolicySurface,
  });
}

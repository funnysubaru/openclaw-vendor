/** Cold adapter for provider-owned OpenAI model route facts. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveMergedModelProviderConfig } from "../config/model-provider-config.js";
import type { ModelApi } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  ProviderModelRouteResolution,
  ProviderModelRouteSource,
  ProviderRouteOverridePresence,
} from "../plugin-sdk/provider-model-types.js";
import {
  createProviderModelRoutesResolver,
  resolveProviderModelCatalogId,
  resolveProviderModelPolicySurface,
} from "../plugins/provider-model-routes.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import type { ProviderModelAuthSourcePlan } from "./provider-model-auth-source-plan.js";
import { selectProviderModelRouteAuth } from "./provider-model-route-auth.js";
import { createProviderModelCatalogRoutePolicy } from "./provider-model-route.js";

const OPENAI_PROVIDER_ID = "openai";

export function createOpenAIModelRoutesResolver(params: {
  config?: OpenClawConfig;
  env?: Readonly<Record<string, string | undefined>>;
  requestTransportOverrides?: ProviderRouteOverridePresence;
}) {
  const resolveRoutes = createProviderModelRoutesResolver({
    provider: OPENAI_PROVIDER_ID,
    config: params.config,
    env: params.env,
    requestTransportOverrides: params.requestTransportOverrides,
  });
  return (observed: {
    modelId?: string;
    api?: string | null;
    baseUrl?: unknown;
    observedRoutes?: readonly ProviderModelRouteSource[];
  }) =>
    resolveRoutes({
      modelId: observed.modelId ? splitTrailingAuthProfile(observed.modelId).model : undefined,
      observedRoutes:
        observed.observedRoutes ??
        (observed.api != null || (observed.baseUrl !== undefined && observed.baseUrl !== null)
          ? [
              {
                api: observed.api as ModelApi | null | undefined,
                baseUrl: observed.baseUrl,
              },
            ]
          : undefined),
    });
}

/** Returns the authored OpenAI provider auth mode, if one exists. */
export function resolveConfiguredOpenAIAuthMode(config?: OpenClawConfig): string | undefined {
  return resolveMergedModelProviderConfig(config, OPENAI_PROVIDER_ID)?.auth;
}

export function selectOpenAIModelRouteAuth(params: {
  resolution: Parameters<typeof selectProviderModelRouteAuth>[0]["resolution"];
  sourcePlan: ProviderModelAuthSourcePlan;
  configuredAuthMode?: string;
  runtimeAuthOwner?: { id: string };
  allowNativeAuthOnSingleRoute?: boolean;
}) {
  return selectProviderModelRouteAuth({ provider: OPENAI_PROVIDER_ID, ...params });
}

export const openAIModelCatalogRoutePolicy =
  createProviderModelCatalogRoutePolicy(OPENAI_PROVIDER_ID);

/** Canonical catalog identity without ambiguity between provider and model segments. */
export function resolveModelCatalogIdentityKey(
  entry: Pick<ModelCatalogEntry, "provider" | "id">,
): string {
  return resolveModelCatalogIdentityKeyWithPolicies(entry);
}

/**
 * Reuses each provider policy only for one synchronous catalog operation.
 *
 * 回搬上游 #145257（任务99 热点②）：模型目录的去重 / 可见性判断要对每个模型算一次身份键，
 * 原写法每算一次都重新查一遍该 provider 的策略；Windows 上每查一次要读几次环境变量
 * （本机实测一次 3.6～6.7 微秒），启动期合计十几秒。这里按 provider 记住查到的策略
 * （未命中的 null 也记住），只在调用方这一次处理内有效：调用方每次处理新建一个，
 * 不跨 await 复用（await 期间插件归属可能变化），所以插件重装 / 配置热重载后自然重新查。
 */
export function createModelCatalogIdentityKeyResolver() {
  const policies = new Map<string, ReturnType<typeof resolveProviderModelPolicySurface>>();
  return (entry: Pick<ModelCatalogEntry, "provider" | "id">) =>
    resolveModelCatalogIdentityKeyWithPolicies(entry, policies);
}

function resolveModelCatalogIdentityKeyWithPolicies(
  entry: Pick<ModelCatalogEntry, "provider" | "id">,
  policies?: Map<string, ReturnType<typeof resolveProviderModelPolicySurface>>,
): string {
  const provider = normalizeProviderId(entry.provider);
  const modelId = splitTrailingAuthProfile(entry.id).model;
  let surface = policies?.get(provider);
  if (policies && surface === undefined) {
    surface = resolveProviderModelPolicySurface(provider);
    policies.set(provider, surface);
  }
  const id =
    resolveProviderModelCatalogId({
      provider,
      modelId,
      surface,
    }) ?? entry.id;
  return JSON.stringify([provider, id]);
}

/** Resolves provider-owned OpenAI route state without loading the full provider runtime. */
export function resolveOpenAIModelRoutes(params: {
  provider?: string;
  modelId?: string;
  api?: string | null;
  baseUrl?: unknown;
  config?: OpenClawConfig;
  env?: Readonly<Record<string, string | undefined>>;
  requestTransportOverrides?: ProviderRouteOverridePresence;
}): ProviderModelRouteResolution | null {
  if (normalizeProviderId(params.provider ?? "") !== OPENAI_PROVIDER_ID) {
    return null;
  }
  return createOpenAIModelRoutesResolver({
    config: params.config,
    env: params.env,
    requestTransportOverrides: params.requestTransportOverrides,
  })({
    modelId: params.modelId,
    api: params.api as ModelApi | null | undefined,
    baseUrl: params.baseUrl,
  });
}

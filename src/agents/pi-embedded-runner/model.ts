import type { Api, Model } from "@mariozechner/pi-ai";
import type { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../../config/config.js";
import type { ModelDefinitionConfig } from "../../config/types.js";
import { resolveOpenClawAgentDir } from "../agent-paths.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { buildModelAliasLines } from "../model-alias-lines.js";
import { isSecretRefHeaderValueMarker } from "../model-auth-markers.js";
import { resolveForwardCompatModel } from "../model-forward-compat.js";
import { findNormalizedProviderValue, normalizeProviderId } from "../model-selection.js";
import {
  buildSuppressedBuiltInModelError,
  shouldSuppressBuiltInModel,
} from "../model-suppression.js";
import { discoverAuthStorage, discoverModels } from "../pi-model-discovery.js";
import { normalizeResolvedProviderModel } from "./model.provider-normalization.js";

type InlineModelEntry = ModelDefinitionConfig & {
  provider: string;
  baseUrl?: string;
  headers?: Record<string, string>;
};
type InlineProviderConfig = {
  baseUrl?: string;
  api?: ModelDefinitionConfig["api"];
  models?: ModelDefinitionConfig[];
  headers?: unknown;
};

function sanitizeModelHeaders(
  headers: unknown,
  opts?: { stripSecretRefMarkers?: boolean },
): Record<string, string> | undefined {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return undefined;
  }
  const next: Record<string, string> = {};
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (typeof headerValue !== "string") {
      continue;
    }
    if (opts?.stripSecretRefMarkers && isSecretRefHeaderValueMarker(headerValue)) {
      continue;
    }
    next[headerName] = headerValue;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeResolvedModel(params: { provider: string; model: Model<Api> }): Model<Api> {
  return normalizeResolvedProviderModel(params);
}

export { buildModelAliasLines };

function resolveConfiguredProviderConfig(
  cfg: OpenClawConfig | undefined,
  provider: string,
): InlineProviderConfig | undefined {
  const configuredProviders = cfg?.models?.providers;
  if (!configuredProviders) {
    return undefined;
  }
  const exactProviderConfig = configuredProviders[provider];
  if (exactProviderConfig) {
    return exactProviderConfig;
  }
  return findNormalizedProviderValue(configuredProviders, provider);
}

/**
 * pi-ai の生成済みカタログ（@mariozechner/pi-ai/dist/models.generated.js）は
 * OpenRouter の動的ルーティングモデル（例: "openrouter/auto"）に対して
 * cost: { input: -1000000, output: -1000000, cacheRead: 0, cacheWrite: 0 } を書き込む。
 *
 * これは OpenRouter の API が pricing="-1"（単価不定の哨兵値）を返すのを
 * pi-ai のスキャナが per-million 換算しそのまま焼き付けた結果であり、
 * 実際の課金コストを表すものではない。
 *
 * この負値が使われると：
 * - session jsonl の usage.cost が負数になり用量パネルの統計が狂う
 * - PLG billing wrap が負の costUsd をレポートしてしまう
 *
 * 対策：cost の任意フィールドが負値の場合、その cost オブジェクト全体を
 * { input:0, output:0, cacheRead:0, cacheWrite:0 } でリセットする。
 * undefined ではなく 0 を使うのは、下流の pi-ai models.js が
 * model.cost.input を直接乗算するため undefined だと NaN になるから。
 *
 * この関数を applyConfiguredProviderOverrides の入口で呼ぶことで、
 * 関数内の全 return 分岐（早期 return × 2 + 末尾の正常合流）を一括でカバーする。
 */
function sanitizeModelCost(cost: Model<Api>["cost"]): Model<Api>["cost"] {
  if (!cost) {
    return cost;
  }
  // cost オブジェクトのいずれかのフィールドが負値ならば、
  // catalog 由来の「単価不定」哨兵が紛れ込んでいると判断して全フィールドを 0 にする。
  const hasNegativeField =
    (cost.input ?? 0) < 0 ||
    (cost.output ?? 0) < 0 ||
    (cost.cacheRead ?? 0) < 0 ||
    (cost.cacheWrite ?? 0) < 0;
  if (!hasNegativeField) {
    return cost;
  }
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function applyConfiguredProviderOverrides(params: {
  discoveredModel: Model<Api>;
  providerConfig?: InlineProviderConfig;
  modelId: string;
}): Model<Api> {
  const { discoveredModel, providerConfig, modelId } = params;

  // pi-ai catalog の負 cost 哨兵を関数入口で清洗する。
  // ここで一括処理することで以下の全 return 分岐をカバーする：
  //   1) !providerConfig 早期 return
  //   2) !configuredModel && !baseUrl && !api && !headers 早期 return
  //   3) 末尾の正常合流（line ~112: cost: configuredModel?.cost ?? discoveredModel.cost）
  const sanitizedDiscoveredModel: Model<Api> = {
    ...discoveredModel,
    cost: sanitizeModelCost(discoveredModel.cost),
  };

  if (!providerConfig) {
    return {
      ...sanitizedDiscoveredModel,
      // Discovered models originate from models.json and may contain persistence markers.
      headers: sanitizeModelHeaders(sanitizedDiscoveredModel.headers, {
        stripSecretRefMarkers: true,
      }),
    };
  }
  const configuredModel = providerConfig.models?.find((candidate) => candidate.id === modelId);
  // sanitizedDiscoveredModel のヘッダを使う（cost 清洗済みオブジェクトで統一）
  const discoveredHeaders = sanitizeModelHeaders(sanitizedDiscoveredModel.headers, {
    stripSecretRefMarkers: true,
  });
  const providerHeaders = sanitizeModelHeaders(providerConfig.headers, {
    stripSecretRefMarkers: true,
  });
  const configuredHeaders = sanitizeModelHeaders(configuredModel?.headers, {
    stripSecretRefMarkers: true,
  });
  if (!configuredModel && !providerConfig.baseUrl && !providerConfig.api && !providerHeaders) {
    // 分岐2：providerConfig があるが configuredModel/baseUrl/api/headers のいずれもない場合。
    // sanitizedDiscoveredModel を使うことで負 cost が漏れない。
    return {
      ...sanitizedDiscoveredModel,
      headers: discoveredHeaders,
    };
  }
  const resolvedInput = configuredModel?.input ?? sanitizedDiscoveredModel.input;
  const normalizedInput =
    Array.isArray(resolvedInput) && resolvedInput.length > 0
      ? resolvedInput.filter((item) => item === "text" || item === "image")
      : (["text"] as Array<"text" | "image">);

  return {
    // 分岐3（正常合流）：sanitizedDiscoveredModel をスプレッドのベースにすることで
    // configuredModel.cost が未設定の場合でも清洗済みの cost が使われる。
    ...sanitizedDiscoveredModel,
    api: configuredModel?.api ?? providerConfig.api ?? sanitizedDiscoveredModel.api,
    baseUrl: providerConfig.baseUrl ?? sanitizedDiscoveredModel.baseUrl,
    reasoning: configuredModel?.reasoning ?? sanitizedDiscoveredModel.reasoning,
    input: normalizedInput,
    cost: configuredModel?.cost ?? sanitizedDiscoveredModel.cost,
    contextWindow: configuredModel?.contextWindow ?? sanitizedDiscoveredModel.contextWindow,
    maxTokens: configuredModel?.maxTokens ?? sanitizedDiscoveredModel.maxTokens,
    headers:
      discoveredHeaders || providerHeaders || configuredHeaders
        ? {
            ...discoveredHeaders,
            ...providerHeaders,
            ...configuredHeaders,
          }
        : undefined,
    compat: configuredModel?.compat ?? sanitizedDiscoveredModel.compat,
  };
}

export function buildInlineProviderModels(
  providers: Record<string, InlineProviderConfig>,
): InlineModelEntry[] {
  return Object.entries(providers).flatMap(([providerId, entry]) => {
    const trimmed = providerId.trim();
    if (!trimmed) {
      return [];
    }
    const providerHeaders = sanitizeModelHeaders(entry?.headers, {
      stripSecretRefMarkers: true,
    });
    return (entry?.models ?? []).map((model) => ({
      ...model,
      provider: trimmed,
      baseUrl: entry?.baseUrl,
      api: model.api ?? entry?.api,
      headers: (() => {
        const modelHeaders = sanitizeModelHeaders((model as InlineModelEntry).headers, {
          stripSecretRefMarkers: true,
        });
        if (!providerHeaders && !modelHeaders) {
          return undefined;
        }
        return {
          ...providerHeaders,
          ...modelHeaders,
        };
      })(),
    }));
  });
}

export function resolveModelWithRegistry(params: {
  provider: string;
  modelId: string;
  modelRegistry: ModelRegistry;
  cfg?: OpenClawConfig;
}): Model<Api> | undefined {
  const { provider, modelId, modelRegistry, cfg } = params;
  if (shouldSuppressBuiltInModel({ provider, id: modelId })) {
    return undefined;
  }
  const providerConfig = resolveConfiguredProviderConfig(cfg, provider);
  const model = modelRegistry.find(provider, modelId) as Model<Api> | null;

  if (model) {
    return normalizeResolvedModel({
      provider,
      model: applyConfiguredProviderOverrides({
        discoveredModel: model,
        providerConfig,
        modelId,
      }),
    });
  }

  const providers = cfg?.models?.providers ?? {};
  const inlineModels = buildInlineProviderModels(providers);
  const normalizedProvider = normalizeProviderId(provider);
  const inlineMatch = inlineModels.find(
    (entry) => normalizeProviderId(entry.provider) === normalizedProvider && entry.id === modelId,
  );
  if (inlineMatch?.api) {
    return normalizeResolvedModel({ provider, model: inlineMatch as Model<Api> });
  }

  // Forward-compat fallbacks must be checked BEFORE the generic providerCfg fallback.
  // Otherwise, configured providers can default to a generic API and break specific transports.
  const forwardCompat = resolveForwardCompatModel(provider, modelId, modelRegistry);
  if (forwardCompat) {
    return normalizeResolvedModel({
      provider,
      model: applyConfiguredProviderOverrides({
        discoveredModel: forwardCompat,
        providerConfig,
        modelId,
      }),
    });
  }

  // OpenRouter is a pass-through proxy - any model ID available on OpenRouter
  // should work without being pre-registered in the local catalog.
  if (normalizedProvider === "openrouter") {
    return normalizeResolvedModel({
      provider,
      model: {
        id: modelId,
        name: modelId,
        api: "openai-completions",
        provider,
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: DEFAULT_CONTEXT_TOKENS,
        // Align with OPENROUTER_DEFAULT_MAX_TOKENS in models-config.providers.ts
        maxTokens: 8192,
      } as Model<Api>,
    });
  }

  const configuredModel = providerConfig?.models?.find((candidate) => candidate.id === modelId);
  const providerHeaders = sanitizeModelHeaders(providerConfig?.headers, {
    stripSecretRefMarkers: true,
  });
  const modelHeaders = sanitizeModelHeaders(configuredModel?.headers, {
    stripSecretRefMarkers: true,
  });
  if (providerConfig || modelId.startsWith("mock-")) {
    return normalizeResolvedModel({
      provider,
      model: {
        id: modelId,
        name: modelId,
        api: providerConfig?.api ?? "openai-responses",
        provider,
        baseUrl: providerConfig?.baseUrl,
        reasoning: configuredModel?.reasoning ?? false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow:
          configuredModel?.contextWindow ??
          providerConfig?.models?.[0]?.contextWindow ??
          DEFAULT_CONTEXT_TOKENS,
        maxTokens:
          configuredModel?.maxTokens ??
          providerConfig?.models?.[0]?.maxTokens ??
          DEFAULT_CONTEXT_TOKENS,
        headers:
          providerHeaders || modelHeaders ? { ...providerHeaders, ...modelHeaders } : undefined,
      } as Model<Api>,
    });
  }

  return undefined;
}

export function resolveModel(
  provider: string,
  modelId: string,
  agentDir?: string,
  cfg?: OpenClawConfig,
): {
  model?: Model<Api>;
  error?: string;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
} {
  const resolvedAgentDir = agentDir ?? resolveOpenClawAgentDir();
  const authStorage = discoverAuthStorage(resolvedAgentDir);
  const modelRegistry = discoverModels(authStorage, resolvedAgentDir);
  const model = resolveModelWithRegistry({ provider, modelId, modelRegistry, cfg });
  if (model) {
    return { model, authStorage, modelRegistry };
  }

  return {
    error: buildUnknownModelError(provider, modelId),
    authStorage,
    modelRegistry,
  };
}

/**
 * Build a more helpful error when the model is not found.
 *
 * Local providers (ollama, vllm) need a dummy API key to be registered.
 * Users often configure `agents.defaults.model.primary: "ollama/…"` but
 * forget to set `OLLAMA_API_KEY`, resulting in a confusing "Unknown model"
 * error.  This detects known providers that require opt-in auth and adds
 * a hint.
 *
 * See: https://github.com/openclaw/openclaw/issues/17328
 */
const LOCAL_PROVIDER_HINTS: Record<string, string> = {
  ollama:
    "Ollama requires authentication to be registered as a provider. " +
    'Set OLLAMA_API_KEY="ollama-local" (any value works) or run "openclaw configure". ' +
    "See: https://docs.openclaw.ai/providers/ollama",
  vllm:
    "vLLM requires authentication to be registered as a provider. " +
    'Set VLLM_API_KEY (any value works) or run "openclaw configure". ' +
    "See: https://docs.openclaw.ai/providers/vllm",
};

function buildUnknownModelError(provider: string, modelId: string): string {
  const suppressed = buildSuppressedBuiltInModelError({ provider, id: modelId });
  if (suppressed) {
    return suppressed;
  }
  const base = `Unknown model: ${provider}/${modelId}`;
  const hint = LOCAL_PROVIDER_HINTS[provider.toLowerCase()];
  return hint ? `${base}. ${hint}` : base;
}

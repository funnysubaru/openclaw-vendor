/** Keeps public and private runtime projections on the same captured catalog. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { dedupeByKey } from "../shared/dedupe-by-key.js";
import type { ModelAuthAvailabilityEvaluation } from "./model-auth-availability.js";
import {
  projectModelCatalogEntryForRoute,
  resolveConfiguredModelCatalogOverrides,
  type ModelCatalogRouteProjection,
} from "./model-catalog-route.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import {
  createModelCatalogIdentityKeyResolver,
  openAIModelCatalogRoutePolicy,
  resolveModelCatalogIdentityKey,
} from "./openai-model-routes.js";

/** Indexes physical variants for paired logical catalog projection. */
export function createModelCatalogView(params: {
  cfg: OpenClawConfig;
  catalog: ModelCatalogEntry[];
  routeVariants?: readonly ModelCatalogEntry[];
}) {
  // 任务99 热点②（对齐上游 #145257 及上游此函数的现行写法）：建索引与去重在这里同步做完，
  // 同一 provider 的策略只查一次。返回的 variantsOf 可能在 await / 插件重载之后才被调用，
  // 所以它照旧每次现查，不复用这个解析器（与上游一致）。
  const keyOf = createModelCatalogIdentityKeyResolver();
  const variantsByKey = new Map<string, ModelCatalogEntry[]>();
  for (const entry of params.routeVariants ?? params.catalog) {
    const key = keyOf(entry);
    const variants = variantsByKey.get(key) ?? [];
    variants.push(entry);
    variantsByKey.set(key, variants);
  }
  const variantsOf = (entry: Pick<ModelCatalogEntry, "provider" | "id">) =>
    variantsByKey.get(resolveModelCatalogIdentityKey(entry));
  return {
    logicalEntries: dedupeByKey(params.catalog, keyOf),
    variantsOf,
    project(entry: ModelCatalogEntry, evaluation: ModelAuthAvailabilityEvaluation) {
      const projection: ModelCatalogRouteProjection =
        evaluation.routeResolution === null
          ? { kind: "unmanaged" }
          : evaluation.selectedRoute
            ? {
                kind: "selected",
                route: evaluation.selectedRoute,
                policy: openAIModelCatalogRoutePolicy,
              }
            : { kind: "unresolved", policy: openAIModelCatalogRoutePolicy };
      const variants = variantsOf(entry);
      const overrides = resolveConfiguredModelCatalogOverrides({
        cfg: params.cfg,
        entry,
        policy: openAIModelCatalogRoutePolicy,
      });
      return projectModelCatalogEntryForRoute({
        entry,
        projection,
        ...(variants ? { catalog: variants } : {}),
        ...(overrides ? { overrides } : {}),
      });
    },
  };
}

// 任务99 热点②（回搬上游 #145257）：createModelCatalogIdentityKeyResolver 在一次处理内按 provider
// 记住策略，同一 provider 的多个模型只查一次；算出的身份键必须与逐个现查的 resolveModelCatalogIdentityKey
// 完全一致（只省重复查找，不改结果）。新建的解析器不沿用旧结果，插件重装 / 配置热重载后自然重新查。
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../plugins/provider-model-routes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/provider-model-routes.js")>();
  return {
    ...actual,
    resolveProviderModelPolicySurface: vi.fn(actual.resolveProviderModelPolicySurface),
  };
});

import * as providerModelRoutes from "../plugins/provider-model-routes.js";
import {
  createModelCatalogIdentityKeyResolver,
  resolveModelCatalogIdentityKey,
} from "./openai-model-routes.js";

const policyLookup = vi.mocked(providerModelRoutes.resolveProviderModelPolicySurface);

const entries = [
  { provider: "openai", id: "gpt-5.5" },
  { provider: "OpenAI", id: "gpt-5.5@work" },
  { provider: "openai", id: "gpt-5.4-mini" },
  { provider: "task99-unknown-provider", id: "model-a" },
  { provider: "task99-unknown-provider", id: "model-b" },
];

describe("createModelCatalogIdentityKeyResolver", () => {
  beforeEach(() => {
    policyLookup.mockClear();
  });

  it("一次处理内每个 provider 只查一次策略（未命中的 null 也记住）", () => {
    const keyOf = createModelCatalogIdentityKeyResolver();
    entries.forEach((entry) => keyOf(entry));
    entries.forEach((entry) => keyOf(entry));
    expect(policyLookup.mock.calls.map(([provider]) => provider)).toEqual([
      "openai",
      "task99-unknown-provider",
    ]);
  });

  it("身份键与逐个现查的结果完全一致", () => {
    const keyOf = createModelCatalogIdentityKeyResolver();
    expect(entries.map(keyOf)).toEqual(entries.map(resolveModelCatalogIdentityKey));
  });

  it("新建的解析器重新查，不沿用上一次处理的结果", () => {
    const entry = { provider: "openai", id: "gpt-5.5" };
    createModelCatalogIdentityKeyResolver()(entry);
    createModelCatalogIdentityKeyResolver()(entry);
    expect(policyLookup).toHaveBeenCalledTimes(2);
  });
});

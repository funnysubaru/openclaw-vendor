import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import { loadModelCatalog, resetModelCatalogCacheForTest } from "./model-catalog.js";
import {
  installModelsConfigTestHooks,
  MODELS_CONFIG_IMPLICIT_ENV_VARS,
  resolveImplicitProvidersForTest,
  unsetEnv,
  withModelsTempHome,
  withTempEnv,
} from "./models-config.e2e-harness.js";
import { ensureOpenClawModelsJson } from "./models-config.js";
import { readGeneratedModelsJson } from "./models-config.test-utils.js";
import { resolveModel } from "./pi-embedded-runner/model.js";

installModelsConfigTestHooks();

async function writeCodexOauthProfile(agentDir: string) {
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "auth-profiles.json"),
    JSON.stringify(
      {
        version: 1,
        profiles: {
          "openai-codex:default": {
            type: "oauth",
            provider: "openai-codex",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
          },
        },
        order: {
          "openai-codex": ["openai-codex:default"],
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

describe("openai-codex implicit provider", () => {
  it("injects an implicit provider when Codex OAuth exists", async () => {
    await withModelsTempHome(async () => {
      await withTempEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS, async () => {
        unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);
        const agentDir = resolveOpenClawAgentDir();
        await writeCodexOauthProfile(agentDir);

        const providers = await resolveImplicitProvidersForTest({ agentDir });
        // Codex OAuth 存在时会合成 openai-codex 的 implicit provider，只带
        // baseUrl/api、不带 apiKey；机型清单刻意留空（models: []），因为
        // openai-codex 的机型来自 pi-ai 内置目录，不从这里的 implicit 块取。
        expect(providers?.["openai-codex"]).toMatchObject({
          baseUrl: "https://chatgpt.com/backend-api",
          api: "openai-codex-responses",
          models: [],
        });
        expect(providers?.["openai-codex"]).not.toHaveProperty("apiKey");
      });
    });
  });

  it("resolves patched Codex models at request time with no cfg (real-runtime gate)", async () => {
    await withModelsTempHome(async () => {
      await withTempEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS, async () => {
        unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);
        const agentDir = resolveOpenClawAgentDir();
        // 模拟 Codex OAuth + 真实 boot 写盘路径，尽量贴近线上 agent 启动。
        await writeCodexOauthProfile(agentDir);
        await ensureOpenClawModelsJson({});

        // 关键验收门：cfg = undefined，复刻真实请求时 resolveModel 的调用
        // （run.ts:364 传的是用户 openclaw.json，其中并没有生成的 providers 块）。
        // 之前 buildOpenAICodexProvider 塞静态模型的机制在这一场景会报
        // "Unknown model"，因为 ModelRegistry.find() 只认 pi-ai 内置目录、
        // 不认 models.json 的 implicit 块。改用 pnpm patch 把两款补进 pi-ai
        // 内置目录后，find() 直接命中，这里必须转绿。
        for (const modelId of [
          "gpt-6-astra",
          "gpt-5.6-sol",
          "gpt-5.6-terra",
          "gpt-5.6-luna",
          "gpt-5.5",
          "gpt-5.4-mini",
        ]) {
          const result = resolveModel("openai-codex", modelId, agentDir, undefined);
          expect(result.error).toBeUndefined();
          expect(result.model).toMatchObject({
            provider: "openai-codex",
            id: modelId,
            api: "openai-codex-responses",
            baseUrl: "https://chatgpt.com/backend-api",
          });
        }
      });
    });
  });

  it("surfaces patched Codex models in the model-catalog layer (getAll)", async () => {
    // 可选补充验收（round 2/3 review Minor 项）：model-catalog.ts 的 loadModelCatalog()
    // 走的是真实 ModelRegistry.getAll()（picker/列表用），跟上面 resolveModel() 走的
    // find() 是两条不同代码路径。两条路径背后都依赖同一份 pi-ai patch 后的内置目录，
    // 这里不 mock __setModelCatalogImportForTest，直接验证 patch 对 getAll() 同样生效。
    resetModelCatalogCacheForTest();
    await withModelsTempHome(async () => {
      await withTempEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS, async () => {
        unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);
        const agentDir = resolveOpenClawAgentDir();
        await writeCodexOauthProfile(agentDir);
        await ensureOpenClawModelsJson({});

        const catalog = await loadModelCatalog({ useCache: false });
        const codexModelIds = new Set(
          catalog.filter((entry) => entry.provider === "openai-codex").map((entry) => entry.id),
        );
        expect(codexModelIds.has("gpt-6-astra")).toBe(true);
        expect(codexModelIds.has("gpt-5.6-sol")).toBe(true);
        expect(codexModelIds.has("gpt-5.6-luna")).toBe(true);
        expect(codexModelIds.has("gpt-5.6-terra")).toBe(true);
        expect(codexModelIds.has("gpt-5.5")).toBe(true);
        expect(codexModelIds.has("gpt-5.4-mini")).toBe(true);
      });
    });
    resetModelCatalogCacheForTest();
  });

  it("replaces stale openai-codex baseUrl in generated models.json", async () => {
    await withModelsTempHome(async () => {
      await withTempEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS, async () => {
        unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);
        const agentDir = resolveOpenClawAgentDir();
        await writeCodexOauthProfile(agentDir);
        await fs.writeFile(
          path.join(agentDir, "models.json"),
          JSON.stringify(
            {
              providers: {
                "openai-codex": {
                  baseUrl: "https://api.openai.com/v1",
                  api: "openai-responses",
                  models: [
                    {
                      id: "gpt-5.4",
                      name: "GPT-5.4",
                      api: "openai-responses",
                      contextWindow: 1_000_000,
                      maxTokens: 100_000,
                    },
                  ],
                },
              },
            },
            null,
            2,
          ),
          "utf8",
        );

        await ensureOpenClawModelsJson({});

        const parsed = await readGeneratedModelsJson<{
          providers: Record<string, { baseUrl?: string; api?: string }>;
        }>();
        expect(parsed.providers["openai-codex"]).toMatchObject({
          baseUrl: "https://chatgpt.com/backend-api",
          api: "openai-codex-responses",
        });
      });
    });
  });

  it("preserves an existing baseUrl for explicit openai-codex config without oauth synthesis", async () => {
    await withModelsTempHome(async () => {
      await withTempEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS, async () => {
        unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);
        const agentDir = resolveOpenClawAgentDir();
        await fs.mkdir(agentDir, { recursive: true });
        await fs.writeFile(
          path.join(agentDir, "models.json"),
          JSON.stringify(
            {
              providers: {
                "openai-codex": {
                  baseUrl: "https://chatgpt.com/backend-api",
                  api: "openai-codex-responses",
                  models: [],
                },
              },
            },
            null,
            2,
          ),
          "utf8",
        );

        await ensureOpenClawModelsJson({
          models: {
            mode: "merge",
            providers: {
              "openai-codex": {
                baseUrl: "",
                api: "openai-codex-responses",
                models: [],
              },
            },
          },
        });

        const parsed = await readGeneratedModelsJson<{
          providers: Record<string, { baseUrl?: string; api?: string }>;
        }>();
        expect(parsed.providers["openai-codex"]).toMatchObject({
          baseUrl: "https://chatgpt.com/backend-api",
          api: "openai-codex-responses",
        });
      });
    });
  });
});

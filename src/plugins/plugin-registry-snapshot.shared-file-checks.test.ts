// 任务99：一次「全员读配置」期间，各工作区共用持久化插件索引的文件检查结果。
// 用 isContainedPluginPath 的调用次数衡量「文件检查做了几遍」：它只在持久化索引的文件检查里
// 被逐个插件路径调用，派生发现不走它，所以次数能直接反映检查是否被重复执行。
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfigWidePluginMetadataSnapshot } from "../config/io.plugin-metadata.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { writePersistedInstalledPluginIndexSync } from "./installed-plugin-index-store-write.js";
import { loadInstalledPluginIndex } from "./installed-plugin-index.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import * as comparison from "./plugin-registry-comparison.js";
import {
  loadPluginRegistrySnapshotWithMetadata,
  withSharedPersistedPluginFileChecks,
} from "./plugin-registry-snapshot.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

vi.mock("./plugin-registry-comparison.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./plugin-registry-comparison.js")>();
  return { ...actual, isContainedPluginPath: vi.fn(actual.isContainedPluginPath) };
});

const tempDirs: string[] = [];

afterEach(() => {
  vi.mocked(comparison.isContainedPluginPath).mockClear();
  clearPluginMetadataLifecycleCaches();
  cleanupTrackedTempDirs(tempDirs);
});

function writePackagePlugin(rootDir: string, description = "one") {
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, "index.ts"), "export default { register() {} };\n", "utf8");
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({ id: "demo", name: "demo", description, configSchema: { type: "object" } }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "package.json"),
    JSON.stringify({ name: "demo", version: "1.0.0" }),
    "utf8",
  );
}

/** 一个装在 load path 上的插件 + 与之一致的持久化索引。 */
function setupPersistedPlugin() {
  const tempRoot = fs.realpathSync(makeTrackedTempDir("openclaw-shared-file-checks", tempDirs));
  const pluginDir = path.join(tempRoot, "plugin");
  const stateDir = path.join(tempRoot, "state");
  const env: NodeJS.ProcessEnv = {
    HOME: tempRoot,
    OPENCLAW_HOME: tempRoot,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_VERSION: "2026.4.26",
    VITEST: "true",
  };
  const config: OpenClawConfig = { plugins: { load: { paths: [pluginDir] } } };
  writePackagePlugin(pluginDir);
  writePersistedInstalledPluginIndexSync(loadInstalledPluginIndex({ config, env }), { stateDir });
  return { tempRoot, pluginDir, stateDir, env, config };
}

function countFileChecks(run: () => void): number {
  const spy = vi.mocked(comparison.isContainedPluginPath);
  spy.mockClear();
  run();
  return spy.mock.calls.length;
}

describe("withSharedPersistedPluginFileChecks", () => {
  it("checks persisted plugin files once for repeated loads inside the shared scope", () => {
    const { env, config, stateDir } = setupPersistedPlugin();
    const load = () => loadPluginRegistrySnapshotWithMetadata({ config, env, stateDir });

    const single = countFileChecks(() => withPluginCache(createPluginCache(), load));
    expect(single).toBeGreaterThan(0);

    // 不包共享作用域：每次加载都重新检查（长期运行时靠它发现插件文件被替换）。
    const unshared = countFileChecks(() =>
      withPluginCache(createPluginCache(), () => {
        load();
        load();
        load();
      }),
    );
    expect(unshared).toBe(single * 3);

    // 包在共享作用域里：同一索引对象只检查一遍。
    const shared = countFileChecks(() =>
      withPluginCache(createPluginCache(), () =>
        withSharedPersistedPluginFileChecks(() => {
          load();
          load();
          load();
        }),
      ),
    );
    expect(shared).toBe(single);
  });

  it("drops shared results when the scope ends so later loads check files again", () => {
    const { env, config, stateDir } = setupPersistedPlugin();
    // 同一个插件缓存代 = 同一个持久化索引对象。若共享结果泄漏到作用域之外，
    // 作用域外的加载会直接拿到旧结论、不再检查文件（调用次数为 0）。
    const cache = createPluginCache();
    const load = () =>
      withPluginCache(cache, () =>
        loadPluginRegistrySnapshotWithMetadata({ config, env, stateDir }),
      );

    const inScope = countFileChecks(() => withSharedPersistedPluginFileChecks(load));
    expect(inScope).toBeGreaterThan(0);
    expect(countFileChecks(load)).toBe(inScope);
    // 新开一个共享作用域也要重新检查，不能沿用上一次作用域的结论。
    expect(countFileChecks(() => withSharedPersistedPluginFileChecks(load))).toBe(inScope);
  });

  it("shares file checks across agent workspaces in a config-wide metadata read", () => {
    const { env, stateDir, pluginDir, tempRoot } = setupPersistedPlugin();
    const configWith = (workspaceCount: number): OpenClawConfig => ({
      agents: {
        ownership: "explicit",
        entries: Object.fromEntries(
          Array.from({ length: workspaceCount }, (_, i) => [
            `agent${i}`,
            { workspace: path.join(tempRoot, `workspace-${i}`) },
          ]),
        ),
      },
      plugins: { load: { paths: [pluginDir] } },
    });
    const read = (config: OpenClawConfig) =>
      countFileChecks(() =>
        resolveConfigWidePluginMetadataSnapshot({ config, env, stateDir, allowCurrent: false }),
      );

    const one = read(configWith(1));
    expect(one).toBeGreaterThan(0);
    // 修前：5 个工作区各检查一遍 = one * 5；修后与单个工作区相同。
    expect(read(configWith(5))).toBe(one);
  });
});

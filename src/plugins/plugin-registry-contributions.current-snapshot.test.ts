// Verifies current plugin registry contribution snapshots.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import {
  makeEmptyPluginMetadataOwners,
  setCurrentPluginMetadataSnapshot,
} from "./current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import * as installedIndex from "./installed-plugin-index.js";
import { loadManifestMetadataSnapshot } from "./manifest-contract-eligibility.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import {
  loadPluginManifestRegistryForPluginRegistry,
  listPluginContributionIds,
  resolveManifestContractOwnerPluginId,
  resolveManifestContractPluginIds,
  resolvePluginContributionOwners,
} from "./plugin-registry-contributions.js";
import { loadPluginRegistrySnapshotWithMetadata } from "./plugin-registry-snapshot.js";
import { buildDeclaredProviderOwnerIndex } from "./provider-owner-index.js";
import { createColdPluginFixture } from "./test-helpers/cold-plugin-fixtures.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  clearPluginMetadataLifecycleCaches();
});

function createPluginRecord(id: string, enabled: boolean): InstalledPluginIndex["plugins"][number] {
  return {
    pluginId: id,
    manifestPath: `/plugins/${id}/openclaw.plugin.json`,
    manifestHash: id,
    rootDir: `/plugins/${id}`,
    origin: "global",
    enabled,
    startup: {
      sidecar: false,
      memory: false,
      agentHarnesses: [],
    },
    compat: [],
  } as unknown as InstalledPluginIndex["plugins"][number];
}

function createManifest(id: string): PluginManifestRecord {
  return {
    id,
    origin: "global",
    providers: [],
    channels: [],
    channelConfigs: {},
    cliBackends: [],
    contracts: { webSearchProviders: [`${id}-search`] },
  } as unknown as PluginManifestRecord;
}

function createSnapshot(params: {
  config: OpenClawConfig;
  workspaceDir: string;
  registryDiagnostics?: PluginMetadataSnapshot["registryDiagnostics"];
}): PluginMetadataSnapshot {
  const policyHash = resolveInstalledPluginIndexPolicyHash(params.config);
  const index: InstalledPluginIndex = {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash,
    generatedAtMs: 0,
    installRecords: {},
    plugins: [createPluginRecord("enabled", true), createPluginRecord("disabled", false)],
    diagnostics: [],
  };
  const plugins = [createManifest("enabled"), createManifest("disabled")];
  return {
    policyHash,
    workspaceDir: params.workspaceDir,
    configFingerprint: "",
    index,
    registryIndex: index,
    registryDiagnostics: params.registryDiagnostics ?? [],
    manifestRegistry: { plugins, diagnostics: [] },
    plugins,
    diagnostics: [],
    byPluginId: new Map(plugins.map((plugin) => [plugin.id, plugin])),
    normalizePluginId: (pluginId: string) => pluginId,
    declaredProviderOwners: buildDeclaredProviderOwnerIndex(plugins),
    owners: makeEmptyPluginMetadataOwners(),
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: index.plugins.length,
      manifestPluginCount: plugins.length,
    },
  };
}

describe("loadPluginManifestRegistryForPluginRegistry current snapshot", () => {
  // 任务84第二批（上游 #153452）：验证「已缓存但未显式 publish 为 current」的元数据快照也能被
  // contributions 读取路径复用——只要 clearPluginMetadataLifecycleCaches() 没清掉缓存键，
  // 二次调用不应再触发 loadInstalledPluginIndexWithDiscovery（真正的插件发现扫描）。
  it("reuses unpublished metadata until explicit discovery or lifecycle invalidation", () => {
    const root = tempDirs.make("openclaw-registry-metadata-reuse-");
    const pluginRoot = path.join(root, "plugin");
    fs.mkdirSync(pluginRoot);
    const fixture = createColdPluginFixture({ rootDir: pluginRoot, pluginId: "reuse-fixture" });
    const config: OpenClawConfig = {
      plugins: {
        allow: [fixture.pluginId],
        load: { paths: [pluginRoot] },
        entries: { [fixture.pluginId]: { enabled: true } },
      },
    };
    const env = {
      HOME: root,
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    const params = { config, env };
    // 第一次调用走正常冷加载，把结果缓存进 plugin-metadata-snapshot 的缓存 Map，但不发布为 current。
    expect(loadPluginMetadataSnapshot(params).plugins.map((plugin) => plugin.id)).toEqual([
      fixture.pluginId,
    ]);
    const derive = vi.spyOn(installedIndex, "loadInstalledPluginIndexWithDiscovery");

    // 第二次经 contributions 读取路径(loadPluginManifestRegistryForPluginRegistry /
    // listPluginContributionIds / resolvePluginContributionOwners)应该直接命中上面的缓存，
    // 不重新跑插件发现。
    expect(
      loadPluginManifestRegistryForPluginRegistry(params).plugins.map((plugin) => plugin.id),
    ).toEqual([fixture.pluginId]);
    expect(listPluginContributionIds({ ...params, contribution: "channels" })).toEqual([
      fixture.channelId,
    ]);
    expect(
      resolvePluginContributionOwners({
        ...params,
        contribution: "channels",
        matches: fixture.channelId,
      }),
    ).toEqual([fixture.pluginId]);
    expect(derive).not.toHaveBeenCalled();
    // 这份缓存是「已缓存」而非「已发布」——current-plugin-metadata-snapshot 里查不到它。
    expect(getCurrentPluginMetadataSnapshot(params)).toBeUndefined();

    // 显式传了 candidates 等注册表专属参数时，必须绕开缓存走真实发现（行为不能被这次优化掩盖）。
    expect(
      loadPluginManifestRegistryForPluginRegistry({
        ...params,
        preferPersisted: false,
        candidates: [],
      }).plugins,
    ).toEqual([]);
    expect(derive).toHaveBeenCalledOnce();

    // 清掉生命周期缓存后，缓存键失效，下一次 contributions 读取应该重新走一次发现。
    clearPluginMetadataLifecycleCaches();
    expect(
      loadPluginManifestRegistryForPluginRegistry(params).plugins.map((plugin) => plugin.id),
    ).toEqual([fixture.pluginId]);
    expect(listPluginContributionIds({ ...params, contribution: "channels" })).toEqual([
      fixture.channelId,
    ]);
    expect(derive).toHaveBeenCalledTimes(2);
    // 发现扫描只读元数据文件，绝不应该触发插件的运行时入口（见 cold-plugin-fixtures 的 runtime 守卫）。
    expect(fs.existsSync(fixture.runtimeMarker)).toBe(false);
  });

  it("reuses current manifests for contribution listing and owner lookup", () => {
    const config: OpenClawConfig = {
      plugins: { entries: { disabled: { enabled: false } } },
    };
    const env = {
      HOME: "/tmp/openclaw-test-home",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    const workspaceDir = "/workspace";
    setCurrentPluginMetadataSnapshot(createSnapshot({ config, workspaceDir }), {
      config,
      env,
      workspaceDir,
    });
    const readFile = vi.spyOn(fs, "readFileSync");
    const readDirectory = vi.spyOn(fs, "readdirSync");
    const statFile = vi.spyOn(fs, "statSync");
    const lstatFile = vi.spyOn(fs, "lstatSync");
    const openFile = vi.spyOn(fs, "openSync");
    const params = { config, env, workspaceDir, contribution: "contracts" as const };

    const ids = listPluginContributionIds(params);
    const owners = resolvePluginContributionOwners({ ...params, matches: "webSearchProviders" });
    const allOwners = resolvePluginContributionOwners({
      ...params,
      matches: "webSearchProviders",
      includeDisabled: true,
    });

    for (const read of [readFile, readDirectory, statFile, lstatFile, openFile]) {
      expect(read).not.toHaveBeenCalled();
    }
    expect(ids).toEqual(["webSearchProviders"]);
    expect(owners).toEqual(["enabled"]);
    expect(allOwners).toEqual(["disabled", "enabled"]);
  });

  it("reuses an allowlisted published snapshot for configless manifest reads", () => {
    const config: OpenClawConfig = { plugins: { allow: ["enabled"] } };
    const env = {
      HOME: "/tmp/openclaw-test-home",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    const workspaceDir = "/workspace";
    const snapshot = createSnapshot({ config, workspaceDir });
    setCurrentPluginMetadataSnapshot(snapshot, { config, env, workspaceDir });
    const readDirectory = vi.spyOn(fs, "readdirSync");
    const readFile = vi.spyOn(fs, "readFileSync");

    expect(loadManifestMetadataSnapshot({ env })).toBe(snapshot);
    expect(readDirectory).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("projects supplied contract manifests without dropping disabled owners", () => {
    const config: OpenClawConfig = { plugins: { allow: ["enabled"] } };
    const env = {
      HOME: "/tmp/openclaw-test-home",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    const workspaceDir = "/workspace";
    const snapshot = createSnapshot({ config, workspaceDir });
    setCurrentPluginMetadataSnapshot(snapshot, { config, env, workspaceDir });
    const readDirectory = vi.spyOn(fs, "readdirSync");
    const readFile = vi.spyOn(fs, "readFileSync");

    expect(
      resolveManifestContractPluginIds({
        contract: "webSearchProviders",
        config,
        env,
        workspaceDir,
      }),
    ).toEqual(["disabled", "enabled"]);
    expect(
      resolveManifestContractOwnerPluginId({
        contract: "webSearchProviders",
        value: " DISABLED-SEARCH ",
        config,
        env,
        workspaceDir,
      }),
    ).toBe("disabled");
    expect(
      resolveManifestContractPluginIds({
        contract: "webSearchProviders",
        config: { plugins: { allow: ["incompatible-policy"] } },
        env,
        manifestRecords: snapshot.plugins,
        onlyPluginIds: ["disabled"],
      }),
    ).toEqual(["disabled"]);
    expect(
      resolveManifestContractOwnerPluginId({
        contract: "webSearchProviders",
        value: "disabled-search",
        config: { plugins: { allow: ["incompatible-policy"] } },
        env,
        manifestRecords: snapshot.plugins,
      }),
    ).toBe("disabled");
    expect(readDirectory).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("reuses compatible current manifest metadata", () => {
    const config: OpenClawConfig = {};
    const env = {
      HOME: "/tmp/openclaw-test-home",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    const workspaceDir = "/workspace";
    setCurrentPluginMetadataSnapshot(createSnapshot({ config, workspaceDir }), {
      config,
      env,
      workspaceDir,
    });

    expect(
      loadPluginManifestRegistryForPluginRegistry({ config, env, workspaceDir }).plugins.map(
        (plugin) => plugin.id,
      ),
    ).toEqual(["enabled"]);
    expect(
      loadPluginManifestRegistryForPluginRegistry({
        config,
        env,
        workspaceDir,
        includeDisabled: true,
      }).plugins.map((plugin) => plugin.id),
    ).toEqual(["enabled", "disabled"]);
    expect(
      loadPluginManifestRegistryForPluginRegistry({
        config,
        env,
        workspaceDir,
        includeDisabled: true,
        pluginIds: [],
      }).plugins.map((plugin) => plugin.id),
    ).toEqual([]);
    expect(
      loadPluginManifestRegistryForPluginRegistry({
        config,
        env,
        workspaceDir,
        includeDisabled: true,
        pluginIds: ["disabled"],
      }).plugins.map((plugin) => plugin.id),
    ).toEqual(["disabled"]);
    expect(loadPluginManifestRegistryForPluginRegistry({ config, env }).plugins).toEqual([]);
  });

  it("keeps explicit registry inputs authoritative and reuses current diagnostics", () => {
    const config: OpenClawConfig = {};
    const env = {
      HOME: "/tmp/openclaw-test-home",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    const workspaceDir = "/workspace";
    setCurrentPluginMetadataSnapshot(createSnapshot({ config, workspaceDir }), {
      config,
      env,
      workspaceDir,
    });
    const emptyIndex: InstalledPluginIndex = {
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash: resolveInstalledPluginIndexPolicyHash(config),
      generatedAtMs: 0,
      installRecords: {},
      plugins: [],
      diagnostics: [],
    };

    expect(
      loadPluginManifestRegistryForPluginRegistry({
        config,
        env,
        workspaceDir,
        index: emptyIndex,
        includeDisabled: true,
      }).plugins,
    ).toEqual([]);

    clearPluginMetadataLifecycleCaches();
    setCurrentPluginMetadataSnapshot(
      createSnapshot({
        config,
        workspaceDir,
        registryDiagnostics: [
          {
            level: "info",
            code: "persisted-registry-missing",
            message: "missing",
          },
        ],
      }),
      { config, env, workspaceDir },
    );
    const readDirectory = vi.spyOn(fs, "readdirSync");
    const readFile = vi.spyOn(fs, "readFileSync");
    const statFile = vi.spyOn(fs, "statSync");

    expect(
      loadPluginManifestRegistryForPluginRegistry({ config, env, workspaceDir }).plugins.map(
        (plugin) => plugin.id,
      ),
    ).toEqual(["enabled"]);
    expect(
      loadPluginRegistrySnapshotWithMetadata({ config, env, workspaceDir }).diagnostics,
    ).toEqual([
      {
        level: "info",
        code: "persisted-registry-missing",
        message: "missing",
      },
    ]);
    expect(readDirectory).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(statFile).not.toHaveBeenCalled();
  });
});

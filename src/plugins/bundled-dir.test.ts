// Verifies bundled plugin directory resolution.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as openClawRoot from "../infra/openclaw-root.js";
import * as testRuntimeEnvModule from "../infra/test-runtime-env.js";
import {
  resolveBundledPluginsDir,
  resolveSourceCheckoutDependencyDiagnostic,
  shouldTrustTestBundledPluginsDirOverride,
} from "./bundled-dir.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];
const originalBundledDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const originalDisableBundledPlugins = process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
const originalTrustBundledPlugins = process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
const originalVitest = process.env.VITEST;
const originalArgv1 = process.argv[1];
const originalExecArgv = [...process.execArgv];

function makeRepoRoot(prefix: string): string {
  return makeTrackedTempDir(prefix, tempDirs);
}

function createOpenClawRoot(params: {
  prefix: string;
  hasExtensions?: boolean;
  hasSrc?: boolean;
  hasDistRuntimeExtensions?: boolean;
  hasDistExtensions?: boolean;
  hasGitCheckout?: boolean;
  hasPnpmWorkspace?: boolean;
}) {
  const repoRoot = makeRepoRoot(params.prefix);
  if (params.hasExtensions) {
    fs.mkdirSync(path.join(repoRoot, "extensions"), { recursive: true });
  }
  if (params.hasSrc) {
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
  }
  if (params.hasDistRuntimeExtensions) {
    fs.mkdirSync(path.join(repoRoot, "dist-runtime", "extensions"), { recursive: true });
  }
  if (params.hasDistExtensions) {
    fs.mkdirSync(path.join(repoRoot, "dist", "extensions"), { recursive: true });
  }
  if (params.hasGitCheckout) {
    fs.writeFileSync(path.join(repoRoot, ".git"), "gitdir: /tmp/fake.git\n", "utf8");
  }
  if (params.hasPnpmWorkspace) {
    fs.writeFileSync(
      path.join(repoRoot, "pnpm-workspace.yaml"),
      "packages:\n  - .\n  - extensions/*\n",
      "utf8",
    );
  }
  fs.writeFileSync(
    path.join(repoRoot, "package.json"),
    `${JSON.stringify({ name: "openclaw" }, null, 2)}\n`,
    "utf8",
  );
  return repoRoot;
}

function seedBundledPluginTree(rootDir: string, relativeDir: string, pluginId = "discord") {
  const pluginDir = path.join(rootDir, relativeDir, pluginId);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    `${JSON.stringify({ name: `@openclaw/${pluginId}` }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify({ id: pluginId }, null, 2)}\n`,
    "utf8",
  );
}

function expectResolvedBundledDir(params: {
  cwd: string;
  expectedDir: string;
  argv1?: string;
  bundledDirOverride?: string;
  disableBundledPlugins?: string;
  vitest?: string;
  execArgv?: readonly string[];
}) {
  vi.spyOn(process, "cwd").mockReturnValue(params.cwd);
  process.argv[1] = params.argv1 ?? "/usr/bin/env";
  process.execArgv.length = 0;
  process.execArgv.push(...(params.execArgv ?? []));
  if (params.vitest === undefined) {
    delete process.env.VITEST;
  } else {
    process.env.VITEST = params.vitest;
  }
  if (params.bundledDirOverride === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = params.bundledDirOverride;
  }
  if (params.disableBundledPlugins === undefined) {
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  } else {
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = params.disableBundledPlugins;
  }

  expect(fs.realpathSync(resolveBundledPluginsDir() ?? "")).toBe(
    fs.realpathSync(params.expectedDir),
  );
}

function expectResolvedBundledDirFromRoot(params: {
  repoRoot: string;
  expectedRelativeDir: string;
  argv1?: string;
  bundledDirOverride?: string;
  vitest?: string;
  cwd?: string;
  execArgv?: readonly string[];
}) {
  expectResolvedBundledDir({
    cwd: params.cwd ?? params.repoRoot,
    expectedDir: path.join(params.repoRoot, params.expectedRelativeDir),
    argv1: params.argv1 ?? path.join(params.repoRoot, "openclaw.mjs"),
    ...(params.bundledDirOverride ? { bundledDirOverride: params.bundledDirOverride } : {}),
    ...(params.vitest !== undefined ? { vitest: params.vitest } : {}),
    ...(params.execArgv ? { execArgv: params.execArgv } : {}),
  });
}

function expectInstalledBundledDirScenario(params: {
  installedRoot: string;
  cwd?: string;
  argv1?: string;
  bundledDirOverride?: string;
}) {
  expectResolvedBundledDirFromRoot({
    repoRoot: params.installedRoot,
    cwd: params.cwd ?? process.cwd(),
    ...(params.argv1 ? { argv1: params.argv1 } : {}),
    ...(params.bundledDirOverride ? { bundledDirOverride: params.bundledDirOverride } : {}),
    expectedRelativeDir: path.join("dist", "extensions"),
  });
}

function expectInstalledBundledDirScenarioCase(
  createScenario: () => {
    installedRoot: string;
    cwd?: string;
    argv1?: string;
    bundledDirOverride?: string;
  },
) {
  expectInstalledBundledDirScenario(createScenario());
}

function requireBundledDir(value: string | null | undefined): string {
  if (!value) {
    throw new Error("expected bundled plugins dir");
  }
  return value;
}

beforeEach(() => {
  delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalBundledDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledDir;
  }
  if (originalDisableBundledPlugins === undefined) {
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  } else {
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = originalDisableBundledPlugins;
  }
  if (originalTrustBundledPlugins === undefined) {
    delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = originalTrustBundledPlugins;
  }
  if (originalVitest === undefined) {
    delete process.env.VITEST;
  } else {
    process.env.VITEST = originalVitest;
  }
  if (originalArgv1 === undefined) {
    process.argv.splice(1, 1);
  } else {
    process.argv[1] = originalArgv1;
  }
  process.execArgv.length = 0;
  process.execArgv.push(...originalExecArgv);
  cleanupTrackedTempDirs(tempDirs);
});

describe("shouldTrustTestBundledPluginsDirOverride", () => {
  // ADR-0033 任务 72（Windows 实测证据，回搬自上游 #155250）：热路径里这个函数每次调用都要
  // 判断是否处于 vitest 进程。生产环境下 OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR 几乎永远
  // 不设置，先判它能短路掉代价更高的 isVitestRuntimeEnv 调用（process.env 属性读取在
  // Windows 上是系统调用，比 POSIX 慢一个量级）。
  //
  // 矩阵测试用 mock 直接控制 isVitestRuntimeEnv 的返回值而不是摆弄真实
  // process.env.VITEST——因为测试本身就跑在 vitest worker 里，process.env 上
  // VITEST_POOL_ID / VITEST_WORKER_ID / NODE_ENV=test 这些字段天然为真，摆弄
  // VITEST 单个字段测不出「非 vitest 环境」这一分支（isVitestRuntimeEnv 还会兜底
  // 检查真实 process.env，必然命中）。mock 掉之后才能独立控制两个输入维度。
  it.each([
    [false, undefined, false],
    [false, "1", false],
    [true, undefined, false],
    [true, "1", true],
    [true, "true", true],
    [true, "0", false],
  ] as const)(
    "returns %s when isVitestRuntimeEnv()=%s and trust-env=%j",
    (isVitestMocked, trustEnvValue, expected) => {
      vi.spyOn(testRuntimeEnvModule, "isVitestRuntimeEnv").mockReturnValue(isVitestMocked);
      const env: NodeJS.ProcessEnv =
        trustEnvValue === undefined
          ? {}
          : { OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: trustEnvValue };
      // 行为等价性断言：短路顺序重排不改变任何输入组合下的返回值。
      expect(shouldTrustTestBundledPluginsDirOverride(env)).toBe(expected);
    },
  );

  it("short-circuits without calling isVitestRuntimeEnv when the trust-override env var is unset (production shape)", () => {
    const spy = vi.spyOn(testRuntimeEnvModule, "isVitestRuntimeEnv");
    // 不带 OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR 的独立 env 对象——这是生产环境
    // 每次调用 resolveBundledPluginsDir() 时的真实形状。
    const result = shouldTrustTestBundledPluginsDirOverride({});
    expect(result).toBe(false);
    // 核心断言：修复前这里会无条件调用两次 isVitestRuntimeEnv（各自最多访问 5 个
    // process.env 属性）。修复后短路在那之前，调用次数应为 0。还原旧实现（先判
    // isVitestProcess 再判 trust）此断言会变红，证明测的是这次改动本身。
    expect(spy).not.toHaveBeenCalled();
  });

  it("still calls isVitestRuntimeEnv when the trust-override env var is set", () => {
    const spy = vi.spyOn(testRuntimeEnvModule, "isVitestRuntimeEnv");
    shouldTrustTestBundledPluginsDirOverride({
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
    });
    expect(spy).toHaveBeenCalled();
  });
});

describe("resolveBundledPluginsDir", () => {
  it.each([
    [
      "prefers the runtime bundled plugin tree from the package root",
      {
        prefix: "openclaw-bundled-dir-runtime-",
        hasDistRuntimeExtensions: true,
        hasDistExtensions: true,
      },
      {
        expectedRelativeDir: path.join("dist-runtime", "extensions"),
      },
    ],
    [
      "falls back to built dist/extensions in installed package roots",
      {
        prefix: "openclaw-bundled-dir-dist-",
        hasDistExtensions: true,
      },
      {
        expectedRelativeDir: path.join("dist", "extensions"),
      },
    ],
    [
      "prefers built dist/extensions in a pnpm git checkout outside vitest",
      {
        prefix: "openclaw-bundled-dir-git-built-",
        hasExtensions: true,
        hasSrc: true,
        hasDistRuntimeExtensions: true,
        hasDistExtensions: true,
        hasGitCheckout: true,
        hasPnpmWorkspace: true,
      },
      {
        expectedRelativeDir: path.join("dist", "extensions"),
      },
    ],
    [
      "does not prefer source extensions from VITEST alone",
      {
        prefix: "openclaw-bundled-dir-vitest-",
        hasExtensions: true,
        hasDistRuntimeExtensions: true,
        hasDistExtensions: true,
      },
      {
        expectedRelativeDir: path.join("dist-runtime", "extensions"),
        vitest: "true",
      },
    ],
    [
      "prefers built dist/extensions during tsx-driven pnpm source execution",
      {
        prefix: "openclaw-bundled-dir-tsx-built-",
        hasExtensions: true,
        hasSrc: true,
        hasDistRuntimeExtensions: true,
        hasDistExtensions: true,
        hasGitCheckout: true,
        hasPnpmWorkspace: true,
      },
      {
        expectedRelativeDir: path.join("dist", "extensions"),
        execArgv: ["--import", "tsx"],
      },
    ],
    [
      "uses source extensions in a pnpm git checkout when built trees are missing",
      {
        prefix: "openclaw-bundled-dir-git-",
        hasExtensions: true,
        hasSrc: true,
        hasGitCheckout: true,
        hasPnpmWorkspace: true,
      },
      {
        expectedRelativeDir: "extensions",
      },
    ],
  ] as const)("%s", (_name, layout, expectation) => {
    const repoRoot = createOpenClawRoot(layout);
    if (expectation.expectedRelativeDir === path.join("dist-runtime", "extensions")) {
      seedBundledPluginTree(repoRoot, path.join("dist", "extensions"));
      seedBundledPluginTree(repoRoot, path.join("dist-runtime", "extensions"));
    } else if (expectation.expectedRelativeDir === path.join("dist", "extensions")) {
      seedBundledPluginTree(repoRoot, path.join("dist", "extensions"));
    } else if (expectation.expectedRelativeDir === "extensions") {
      seedBundledPluginTree(repoRoot, "extensions");
    }
    expectResolvedBundledDirFromRoot({
      repoRoot,
      expectedRelativeDir: expectation.expectedRelativeDir,
      ...("vitest" in expectation ? { vitest: expectation.vitest } : {}),
      ...("execArgv" in expectation ? { execArgv: [...expectation.execArgv] } : {}),
    });
  });

  it("falls back to source extensions when dist trees exist but do not contain real plugin manifests", () => {
    const repoRoot = createOpenClawRoot({
      prefix: "openclaw-bundled-dir-incomplete-built-",
      hasExtensions: true,
      hasSrc: true,
      hasDistRuntimeExtensions: true,
      hasDistExtensions: true,
      hasGitCheckout: true,
      hasPnpmWorkspace: true,
    });
    fs.mkdirSync(path.join(repoRoot, "dist", "extensions", "discord"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, "dist-runtime", "extensions", "discord"), {
      recursive: true,
    });
    seedBundledPluginTree(repoRoot, "extensions");

    expectResolvedBundledDirFromRoot({
      repoRoot,
      expectedRelativeDir: "extensions",
    });
  });

  it("uses source extensions in pnpm workspace mirrors without git metadata", () => {
    const repoRoot = createOpenClawRoot({
      prefix: "openclaw-bundled-dir-source-mirror-",
      hasExtensions: true,
      hasSrc: true,
      hasPnpmWorkspace: true,
    });
    seedBundledPluginTree(repoRoot, "extensions", "memory-core");

    expectResolvedBundledDirFromRoot({
      repoRoot,
      expectedRelativeDir: "extensions",
    });
  });

  it("keeps built bundled plugins for git-looking trees without pnpm workspace metadata", () => {
    const repoRoot = createOpenClawRoot({
      prefix: "openclaw-bundled-dir-git-no-pnpm-",
      hasExtensions: true,
      hasSrc: true,
      hasDistRuntimeExtensions: true,
      hasDistExtensions: true,
      hasGitCheckout: true,
    });
    seedBundledPluginTree(repoRoot, "extensions");
    seedBundledPluginTree(repoRoot, path.join("dist", "extensions"));
    seedBundledPluginTree(repoRoot, path.join("dist-runtime", "extensions"));

    expectResolvedBundledDirFromRoot({
      repoRoot,
      expectedRelativeDir: path.join("dist-runtime", "extensions"),
    });
  });

  it("reports missing pnpm workspace deps for source checkouts", () => {
    const repoRoot = createOpenClawRoot({
      prefix: "openclaw-bundled-dir-source-deps-",
      hasExtensions: true,
      hasSrc: true,
      hasGitCheckout: true,
      hasPnpmWorkspace: true,
    });
    seedBundledPluginTree(repoRoot, "extensions", "twitch");
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    process.argv[1] = path.join(repoRoot, "openclaw.mjs");

    expect(resolveSourceCheckoutDependencyDiagnostic()).toEqual({
      source: repoRoot,
      message:
        "OpenClaw source checkout detected without pnpm workspace dependencies; run `pnpm install` from the repo root so bundled plugins can load package-local dependencies.",
    });

    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    expect(resolveSourceCheckoutDependencyDiagnostic()).toBeNull();

    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
    fs.mkdirSync(path.join(repoRoot, "node_modules", ".pnpm"), { recursive: true });
    // The diagnostic also scans the real checkout hosting this test run (via
    // module-root resolution), which may itself lack node_modules in nested
    // worktrees; only assert the satisfied fixture is no longer reported.
    expect(
      withPluginCache(createPluginCache(), () => resolveSourceCheckoutDependencyDiagnostic())
        ?.source,
    ).not.toBe(repoRoot);
  });

  it("returns a stable empty bundled plugin directory when bundled plugins are disabled", () => {
    const repoRoot = createOpenClawRoot({
      prefix: "openclaw-bundled-dir-disabled-",
      hasExtensions: true,
      hasSrc: true,
      hasGitCheckout: true,
    });
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    process.argv[1] = "/usr/bin/env";
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;

    const bundledDir = requireBundledDir(resolveBundledPluginsDir());

    expect(fs.existsSync(bundledDir)).toBe(true);
    expect(fs.readdirSync(bundledDir)).toStrictEqual([]);
  });

  it("reuses the prepared bundled root until its cache owner changes", () => {
    const repoRoot = fs.realpathSync(
      createOpenClawRoot({
        prefix: "openclaw-bundled-dir-owner-",
        hasExtensions: true,
        hasSrc: true,
        hasPnpmWorkspace: true,
      }),
    );
    seedBundledPluginTree(repoRoot, "extensions");
    const owner = createPluginCache();
    withPluginCache(owner, () =>
      expectResolvedBundledDirFromRoot({ repoRoot, expectedRelativeDir: "extensions" }),
    );

    const resolveRoot = vi.spyOn(openClawRoot, "resolveOpenClawPackageRootSync");
    const sourceDir = path.join(repoRoot, "extensions");
    expect(withPluginCache(owner, resolveBundledPluginsDir)).toBe(sourceDir);
    seedBundledPluginTree(repoRoot, path.join("dist", "extensions"));
    expect(withPluginCache(owner, resolveBundledPluginsDir)).toBe(sourceDir);
    expect(resolveRoot).not.toHaveBeenCalled();

    expect(withPluginCache(createPluginCache(), resolveBundledPluginsDir)).toBe(
      path.join(repoRoot, "dist", "extensions"),
    );
    expect(withPluginCache(owner, resolveBundledPluginsDir)).toBe(sourceDir);
  });

  it.each(["OPENCLAW_HOME", "HOME", "USERPROFILE", "cwd"] as const)(
    "separates relative override resolution by %s within one cache owner",
    (homeSource) => {
      const homeA = makeRepoRoot("openclaw-bundled-dir-home-a-");
      const homeB = makeRepoRoot("openclaw-bundled-dir-home-b-");
      seedBundledPluginTree(homeA, "bundled", "memory-core");
      seedBundledPluginTree(homeB, "bundled", "discord");
      const envBase = {
        OPENCLAW_BUNDLED_PLUGINS_DIR: homeSource === "cwd" ? "./bundled" : "~/bundled",
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
        VITEST: "true",
      } satisfies NodeJS.ProcessEnv;

      const cwd = vi.spyOn(process, "cwd");
      withPluginCache(createPluginCache(), () => {
        for (const home of [homeA, homeB, homeA]) {
          if (homeSource === "cwd") {
            cwd.mockReturnValue(home);
          }
          const env = homeSource === "cwd" ? envBase : { ...envBase, [homeSource]: home };
          expect(fs.realpathSync(resolveBundledPluginsDir(env) ?? "")).toBe(
            fs.realpathSync(path.join(home, "bundled")),
          );
        }
      });
    },
  );

  it("ignores an existing override under an argv1-derived fake package root", () => {
    const installedRoot = createOpenClawRoot({
      prefix: "openclaw-bundled-dir-argv-override-reject-",
      hasDistExtensions: true,
    });
    seedBundledPluginTree(installedRoot, path.join("dist", "extensions"));

    vi.spyOn(process, "cwd").mockReturnValue(installedRoot);
    process.argv[1] = path.join(installedRoot, "openclaw.mjs");
    process.execArgv.length = 0;
    delete process.env.VITEST;
    delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = path.join(installedRoot, "dist", "extensions");
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;

    const bundledDir = requireBundledDir(resolveBundledPluginsDir());

    expect(fs.realpathSync(bundledDir)).not.toBe(
      fs.realpathSync(path.join(installedRoot, "dist", "extensions")),
    );
  });

  it("rechecks changed override trust within one cache owner", () => {
    // 回搬自上游 #145226 配套测试:原测试只验证了单次解析结果,覆盖不到「同一个 cache owner
    // 内,某个输入字段(这里是 OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR)变化后缓存是否真的
    // 失效重算」这条关键路径——而这正是本次把 JSON.stringify 缓存键换成逐字段比较最容易引入
    // 隐蔽 bug 的地方(漏比较一个字段 = 缓存假命中,返回陈旧结果)。于是改成在同一个
    // withPluginCache owner 内连续翻转 trust 三次(false→true→false),每次都必须拿到对应的
    // 正确结果,才能证明逐字段比较没有漏掉 trustOverride 这一项。
    const overrideRoot = makeRepoRoot("openclaw-bundled-dir-vitest-override-reject-");
    seedBundledPluginTree(overrideRoot, "extensions", "memory-core");

    vi.spyOn(process, "cwd").mockReturnValue(overrideRoot);
    process.argv[1] = "/usr/bin/env";
    process.execArgv.length = 0;
    process.env.VITEST = "true";
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = path.join(overrideRoot, "extensions");
    delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;

    const expectedOverride = fs.realpathSync(path.join(overrideRoot, "extensions"));
    withPluginCache(createPluginCache(), () => {
      for (const trust of [false, true, false]) {
        if (trust) {
          process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
        } else {
          delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
        }
        const bundledDir = fs.realpathSync(requireBundledDir(resolveBundledPluginsDir()));
        if (trust) {
          expect(bundledDir).toBe(expectedOverride);
        } else {
          expect(bundledDir).not.toBe(expectedOverride);
        }
      }
    });
  });

  it("does not let VITEST add cwd to bundled plugin resolution candidates", () => {
    const cwdRepoRoot = createOpenClawRoot({
      prefix: "openclaw-bundled-dir-vitest-cwd-",
      hasExtensions: true,
      hasSrc: true,
      hasGitCheckout: true,
    });
    seedBundledPluginTree(cwdRepoRoot, "extensions", "memory-core");

    vi.spyOn(process, "cwd").mockReturnValue(cwdRepoRoot);
    process.argv[1] = "/usr/bin/env";
    process.execArgv.length = 0;
    process.env.VITEST = "true";
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;

    const bundledDir = requireBundledDir(resolveBundledPluginsDir());

    expect(fs.realpathSync(bundledDir)).not.toBe(
      fs.realpathSync(path.join(cwdRepoRoot, "extensions")),
    );
  });

  it("falls back from a missing override instead of returning an untrusted future path", () => {
    vi.spyOn(process, "cwd").mockReturnValue(makeRepoRoot("openclaw-bundled-dir-missing-cwd-"));
    process.argv[1] = "/usr/bin/env";
    process.execArgv.length = 0;
    delete process.env.VITEST;
    const missingOverride = path.join(
      makeRepoRoot("openclaw-bundled-dir-missing-override-"),
      "extensions",
    );
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = missingOverride;
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;

    const bundledDir = requireBundledDir(resolveBundledPluginsDir());

    expect(path.resolve(bundledDir)).not.toBe(path.resolve(missingOverride));
  });

  it("falls back to argv root when an existing rejected override is unrelated", () => {
    const installedRoot = createOpenClawRoot({
      prefix: "openclaw-bundled-dir-rejected-override-argv-",
      hasDistExtensions: true,
    });
    seedBundledPluginTree(installedRoot, path.join("dist", "extensions"));
    const overrideRoot = makeRepoRoot("openclaw-bundled-dir-rejected-override-");
    seedBundledPluginTree(overrideRoot, "extensions", "memory-core");

    vi.spyOn(process, "cwd").mockReturnValue(makeRepoRoot("openclaw-bundled-dir-rejected-cwd-"));
    process.argv[1] = path.join(installedRoot, "openclaw.mjs");
    process.execArgv.length = 0;
    delete process.env.VITEST;
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = path.join(overrideRoot, "extensions");
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;

    const bundledDir = resolveBundledPluginsDir();

    expect(fs.realpathSync(bundledDir ?? "")).toBe(
      fs.realpathSync(path.join(installedRoot, "dist", "extensions")),
    );
  });

  it("ignores an enclosing checkout reached through node_modules tooling argv1", () => {
    // Nested git worktrees (.worktrees/<pr>, .claude/worktrees/*) have no local
    // node_modules, so vitest workers run with argv1 inside the enclosing
    // checkout's node_modules. That checkout's (possibly stale) bundled plugin
    // trees must never win discovery over the checkout under test.
    const outerRoot = createOpenClawRoot({
      prefix: "openclaw-bundled-dir-enclosing-",
      hasExtensions: true,
      hasSrc: true,
      hasDistExtensions: true,
      hasGitCheckout: true,
      hasPnpmWorkspace: true,
    });
    seedBundledPluginTree(outerRoot, "extensions");
    seedBundledPluginTree(outerRoot, path.join("dist", "extensions"));
    const workerArgv1 = path.join(
      outerRoot,
      "node_modules",
      "vitest",
      "dist",
      "workers",
      "threads.js",
    );
    fs.mkdirSync(path.dirname(workerArgv1), { recursive: true });
    fs.writeFileSync(workerArgv1, "", "utf8");
    const nestedWorktree = path.join(outerRoot, ".worktrees", "pr-1234");
    fs.mkdirSync(nestedWorktree, { recursive: true });

    vi.spyOn(process, "cwd").mockReturnValue(nestedWorktree);
    process.argv[1] = workerArgv1;
    process.execArgv.length = 0;
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;

    const bundledDir = requireBundledDir(resolveBundledPluginsDir());

    expect(fs.realpathSync(bundledDir)).not.toBe(
      fs.realpathSync(path.join(outerRoot, "dist", "extensions")),
    );
    expect(fs.realpathSync(bundledDir)).not.toBe(
      fs.realpathSync(path.join(outerRoot, "extensions")),
    );
  });

  it("does not resolve bundled plugins from cwd when argv1 is not a package root", () => {
    const cwdRepoRoot = createOpenClawRoot({
      prefix: "openclaw-bundled-dir-untrusted-cwd-",
      hasExtensions: true,
      hasSrc: true,
      hasGitCheckout: true,
    });
    fs.mkdirSync(path.join(cwdRepoRoot, "extensions", "memory-core"), { recursive: true });
    fs.writeFileSync(
      path.join(cwdRepoRoot, "extensions", "memory-core", "runtime-api.js"),
      "export const marker = 'untrusted-cwd';\n",
      "utf8",
    );
    vi.spyOn(process, "cwd").mockReturnValue(cwdRepoRoot);
    process.argv[1] = "/usr/bin/env";
    process.execArgv.length = 0;
    delete process.env.VITEST;
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;

    const bundledDir = requireBundledDir(resolveBundledPluginsDir());

    expect(fs.realpathSync(bundledDir)).not.toBe(
      fs.realpathSync(path.join(cwdRepoRoot, "extensions")),
    );
  });

  it.each([
    {
      name: "prefers the running CLI package root over an unrelated cwd checkout",
      createScenario: () => {
        const installedRoot = createOpenClawRoot({
          prefix: "openclaw-bundled-dir-installed-",
          hasDistExtensions: true,
        });
        seedBundledPluginTree(installedRoot, path.join("dist", "extensions"));
        const cwdRepoRoot = createOpenClawRoot({
          prefix: "openclaw-bundled-dir-cwd-",
          hasExtensions: true,
          hasSrc: true,
          hasGitCheckout: true,
        });
        return {
          installedRoot,
          cwd: cwdRepoRoot,
          argv1: path.join(installedRoot, "openclaw.mjs"),
        };
      },
    },
    {
      name: "falls back to the running installed package when the override path is stale",
      createScenario: () => {
        const installedRoot = createOpenClawRoot({
          prefix: "openclaw-bundled-dir-override-",
          hasDistExtensions: true,
        });
        seedBundledPluginTree(installedRoot, path.join("dist", "extensions"));
        return {
          installedRoot,
          argv1: path.join(installedRoot, "openclaw.mjs"),
          bundledDirOverride: path.join(installedRoot, "missing-extensions"),
        };
      },
    },
  ] as const)("$name", ({ createScenario }) => {
    expectInstalledBundledDirScenarioCase(createScenario);
  });
});

/** Resolves the bundled plugin directory for source checkouts, dist builds, and tests. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { isTruthyEnvValue, isVitestRuntimeEnv } from "../infra/env.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { isPathInside } from "../infra/path-guards.js";
import { tryProcessCwd } from "../infra/safe-cwd.js";
import { resolveUserPath } from "../utils.js";
import {
  pluginCacheExistsSync,
  pluginCacheRealpathSync,
  readPluginCacheDirectory,
  refreshPluginCacheStat,
} from "./plugin-cache-files.js";
import { getPluginCache } from "./plugin-cache.js";

const DISABLED_BUNDLED_PLUGINS_DIR = path.join(os.tmpdir(), "openclaw-empty-bundled-plugins");
const TEST_TRUST_BUNDLED_PLUGINS_DIR_ENV = "OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR";

/** Diagnostic emitted when source-checkout bundled plugins lack dependency installs. */
type SourceCheckoutDependencyDiagnostic = {
  source: string;
  message: string;
};

// ADR-0033 任务72第二批（已查上游 src/plugins/bundled-dir.ts 当前实现：逐字节同构，没有缓存，
// 这里不是搬上游、是自己加的等价最小修复）。真实数据二轮复测 CPU profile 里这个函数 self time
// 3.4 秒——它只读一个环境变量再做一次字符串规整比较，单次调用很便宜，但被
// resolveBundledPluginsDir / createResolutionKey 等按"员工 × 模型"的笛卡尔积反复调用（本批同一个
// PR 的 resolveDirectBundledProviderPolicySurface 结构性缓存已经把这条调用链的调用次数砍到约等于
// "distinct provider 数量"，这里再加一层是双保险，覆盖那条结构性缓存覆盖不到的其它调用点，比如
// public-surface-loader.ts 的 createResolutionKey 自己也会直接调用它）。按原始输入字符串做 size-1
// 记忆化：只读 env.OPENCLAW_DISABLE_BUNDLED_PLUGINS 这一个属性，结果只取决于这一个值，跟是从哪个
// env 对象读到的无关，所以按值而不是按 env 对象身份做缓存是安全的——这个值在一次进程生命周期内
// 几乎不变，变了字符串就不相等，直接重算，没有任何假命中风险。
let lastAreBundledPluginsDisabledInput: string | undefined;
let lastAreBundledPluginsDisabledOutput = false;
let lastAreBundledPluginsDisabledInputSeen = false;

/** Returns true when env disables bundled plugin discovery. */
export function areBundledPluginsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const input = env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  if (lastAreBundledPluginsDisabledInputSeen && input === lastAreBundledPluginsDisabledInput) {
    return lastAreBundledPluginsDisabledOutput;
  }
  const raw = normalizeOptionalLowercaseString(input);
  const result = raw === "1" || raw === "true";
  lastAreBundledPluginsDisabledInput = input;
  lastAreBundledPluginsDisabledOutput = result;
  lastAreBundledPluginsDisabledInputSeen = true;
  return result;
}

function resolveDisabledBundledPluginsDir(): string {
  if (!pluginCacheExistsSync(DISABLED_BUNDLED_PLUGINS_DIR)) {
    fs.mkdirSync(DISABLED_BUNDLED_PLUGINS_DIR, { recursive: true });
    refreshPluginCacheStat(DISABLED_BUNDLED_PLUGINS_DIR);
  }
  return DISABLED_BUNDLED_PLUGINS_DIR;
}

function isSourceCheckoutRoot(packageRoot: string): boolean {
  return (
    pluginCacheExistsSync(path.join(packageRoot, "pnpm-workspace.yaml")) &&
    pluginCacheExistsSync(path.join(packageRoot, "src")) &&
    pluginCacheExistsSync(path.join(packageRoot, "extensions"))
  );
}

// 回搬自上游 #155250（ADR-0033 任务 72，与 provider-policy-owners.ts 同一批里当时
// 只搬了后半段，漏了这一处）：原实现先调用两次 isVitestRuntimeEnv（各自最多访问 5 个
// process.env 属性）判断是否处于 vitest 进程，再去看 TEST_TRUST_BUNDLED_PLUGINS_DIR_ENV
// 是否为真——但生产环境下 TEST_TRUST 这个变量几乎永远没设置，先判断它（最多 1-2 次属性
// 访问）就能短路掉后面两次 isVitestRuntimeEnv 调用。resolveBundledPluginsDir() 每次调用
// 都会间接触发这里，而 resolveBundledPluginsDir 又是每次解析 provider 策略（整个模型目录
// 的每个 provider/model 都要查一遍）都会调用的热路径——Windows 上 process.env 属性读取
// 是走系统调用的，比 macOS/Linux 慢一个量级，20 个员工 × 全量模型目录重算时，这里的调用
// 次数线性放大成了秒级甚至分钟级（ADR-0033 任务 72 Windows 实测：resolveProviderPolicySurface
// 单次就能占到约 48 秒）。短路顺序不改变任何输入下的返回值，纯粹是读取次数优化。
export function shouldTrustTestBundledPluginsDirOverride(env: NodeJS.ProcessEnv): boolean {
  const separateEnv = env !== process.env;
  if (
    !isTruthyEnvValue(env[TEST_TRUST_BUNDLED_PLUGINS_DIR_ENV]) &&
    !(separateEnv && isTruthyEnvValue(process.env[TEST_TRUST_BUNDLED_PLUGINS_DIR_ENV]))
  ) {
    return false;
  }
  return isVitestRuntimeEnv(env) || (separateEnv && isVitestRuntimeEnv(process.env));
}

export function hasUsableBundledPluginTree(pluginsDir: string): boolean {
  if (!pluginCacheExistsSync(pluginsDir)) {
    return false;
  }
  try {
    return readPluginCacheDirectory(pluginsDir).some((entry) => {
      if (!entry.isDirectory()) {
        return false;
      }
      const pluginDir = path.join(pluginsDir, entry.name);
      return (
        pluginCacheExistsSync(path.join(pluginDir, "package.json")) ||
        pluginCacheExistsSync(path.join(pluginDir, "openclaw.plugin.json"))
      );
    });
  } catch {
    return false;
  }
}

function safeRealpathSync(targetPath: string): string | null {
  // Trusted bundled containment requires native platform canonicalization.
  return pluginCacheRealpathSync(targetPath, true);
}

function trustedBundledPluginRootsForPackageRoot(packageRoot: string): string[] {
  const roots = [
    path.join(packageRoot, "dist", "extensions"),
    path.join(packageRoot, "dist-runtime", "extensions"),
  ];
  if (isSourceCheckoutRoot(packageRoot)) {
    roots.push(path.join(packageRoot, "extensions"));
  }
  return roots;
}

function resolvePackageRootsForBundledPlugins(): string[] {
  const argvRoot = resolveOpenClawPackageRootSync({ argv1: process.argv[1] });
  const moduleRoot = resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });
  return uniqueStrings([argvRoot, moduleRoot].filter((entry): entry is string => Boolean(entry)));
}

export function resolveSourceCheckoutDependencyDiagnostic(
  env: NodeJS.ProcessEnv = process.env,
): SourceCheckoutDependencyDiagnostic | null {
  if (areBundledPluginsDisabled(env)) {
    return null;
  }
  for (const packageRoot of resolvePackageRootsForBundledPlugins()) {
    if (!isSourceCheckoutRoot(packageRoot)) {
      continue;
    }
    const extensionsDir = path.join(packageRoot, "extensions");
    if (
      !isPluginInPackageBundledRoots({ rootDir: extensionsDir, packageRoot }) ||
      !hasUsableBundledPluginTree(extensionsDir)
    ) {
      continue;
    }
    if (pluginCacheExistsSync(path.join(packageRoot, "node_modules", ".pnpm"))) {
      continue;
    }
    return {
      source: packageRoot,
      message:
        "OpenClaw source checkout detected without pnpm workspace dependencies; run `pnpm install` from the repo root so bundled plugins can load package-local dependencies.",
    };
  }
  return null;
}

function resolveTrustedExistingOverride(resolvedOverride: string): string | null {
  const realOverride = safeRealpathSync(resolvedOverride);
  if (!realOverride) {
    return null;
  }

  const modulePackageRoot = resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });
  if (
    !modulePackageRoot ||
    !isPluginInPackageBundledRoots({ rootDir: realOverride, packageRoot: modulePackageRoot })
  ) {
    return null;
  }
  if (!hasUsableBundledPluginTree(realOverride)) {
    return null;
  }
  return realOverride;
}

/** Checks physical containment in a package's source or compiled plugin trees. */
export function isPluginInPackageBundledRoots(params: {
  rootDir: string;
  packageRoot: string;
}): boolean {
  const realPluginRoot = safeRealpathSync(params.rootDir);
  const realPackageRoot = safeRealpathSync(params.packageRoot);
  if (!realPluginRoot || !realPackageRoot) {
    return false;
  }
  return trustedBundledPluginRootsForPackageRoot(params.packageRoot)
    .map((trustedRoot) => safeRealpathSync(trustedRoot))
    .some(
      (trustedRoot) =>
        trustedRoot !== null &&
        isPathInside(realPackageRoot, trustedRoot) &&
        isPathInside(trustedRoot, realPluginRoot),
    );
}

export function resolveBundledDirFromPackageRoot(packageRoot: string): string | undefined {
  const builtExtensionsDir = path.join(packageRoot, "dist", "extensions");
  // In pnpm source checkouts, prefer the built bundled plugin runtime when it
  // exists so dist gateway runs avoid loading TS plugin entrypoints through jiti.
  // Keep the source tree as the fallback for fresh checkouts before build.
  const runtimeExtensionsDir = path.join(packageRoot, "dist-runtime", "extensions");
  if (isSourceCheckoutRoot(packageRoot)) {
    return [builtExtensionsDir, runtimeExtensionsDir, path.join(packageRoot, "extensions")].find(
      (rootDir) =>
        isPluginInPackageBundledRoots({ rootDir, packageRoot }) &&
        hasUsableBundledPluginTree(rootDir),
    );
  }
  return pluginCacheExistsSync(builtExtensionsDir)
    ? [runtimeExtensionsDir, builtExtensionsDir].find((rootDir) =>
        isPluginInPackageBundledRoots({ rootDir, packageRoot }),
      )
    : undefined;
}

function resolveBundledPluginsDirUncached(env: NodeJS.ProcessEnv): string | undefined {
  if (areBundledPluginsDisabled(env)) {
    return resolveDisabledBundledPluginsDir();
  }

  const override = env.OPENCLAW_BUNDLED_PLUGINS_DIR?.trim();
  let rejectedExistingOverride: string | null = null;
  if (override) {
    const resolvedOverride = resolveUserPath(override, env);
    if (pluginCacheExistsSync(resolvedOverride)) {
      if (shouldTrustTestBundledPluginsDirOverride(env)) {
        return path.resolve(resolvedOverride);
      }
      const trustedOverride = resolveTrustedExistingOverride(resolvedOverride);
      if (trustedOverride) {
        return trustedOverride;
      }
      rejectedExistingOverride = resolvedOverride;
    }
  }

  try {
    const argvRoot = resolveOpenClawPackageRootSync({ argv1: process.argv[1] });
    const rejectedOverrideUsesArgvRoot = Boolean(
      argvRoot &&
      rejectedExistingOverride &&
      isPluginInPackageBundledRoots({
        rootDir: rejectedExistingOverride,
        packageRoot: argvRoot,
      }),
    );
    const safeArgvRoot = rejectedOverrideUsesArgvRoot ? null : argvRoot;
    const moduleRoot = resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });
    const packageRoots = uniqueStrings(
      [safeArgvRoot, moduleRoot].filter((entry): entry is string => Boolean(entry)),
    );
    for (const packageRoot of packageRoots) {
      const bundledDir = resolveBundledDirFromPackageRoot(packageRoot);
      if (bundledDir) {
        return bundledDir;
      }
    }
  } catch {
    // ignore
  }

  // bun --compile: ship a sibling bundled plugin tree next to the executable.
  try {
    const execDir = path.dirname(process.execPath);
    const siblingBuilt = path.join(execDir, "dist", "extensions");
    if (pluginCacheExistsSync(siblingBuilt)) {
      return siblingBuilt;
    }
    const sibling = path.join(execDir, "extensions");
    if (pluginCacheExistsSync(sibling)) {
      return sibling;
    }
  } catch {
    // ignore
  }

  // npm/dev: walk up from this module to find the bundled plugin tree at the package root.
  try {
    let cursor = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i += 1) {
      const candidate = path.join(cursor, "extensions");
      if (pluginCacheExistsSync(candidate)) {
        return candidate;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        break;
      }
      cursor = parent;
    }
  } catch {
    // ignore
  }

  return undefined;
}

export function resolveBundledPluginsDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const disabled = areBundledPluginsDisabled(env);
  const override = disabled ? undefined : env.OPENCLAW_BUNDLED_PLUGINS_DIR?.trim();
  const resolvedOverride = override ? resolveUserPath(override, env) : undefined;
  const trustOverride = shouldTrustTestBundledPluginsDirOverride(env);
  const argv1 = process.argv[1];
  const execPath = process.execPath;
  const cwd = tryProcessCwd();
  const metadata = getPluginCache().metadata;
  const cached = metadata.bundledPluginsDir;
  // 回搬自上游 #145226：原实现每次都 JSON.stringify 整个 7 元组拼缓存键再比较字符串，
  // 命中缓存时这次字符串分配纯属浪费（provider 策略查询对模型目录每个 provider/model 都会
  // 调一次这里）。改成按字段逐一比较——语义不变：任何一项输入变化（cwd 切换、override 改了、
  // gateway 重启换了新 metadata owner 等）都会落空走到下面的 resolveBundledPluginsDirUncached
  // 重新计算；全部相同才直接返回缓存值，省掉这次分配。
  if (
    cached &&
    cached.moduleUrl === import.meta.url &&
    cached.disabled === disabled &&
    cached.resolvedOverride === resolvedOverride &&
    cached.trustOverride === trustOverride &&
    cached.argv1 === argv1 &&
    cached.execPath === execPath &&
    cached.cwd === cwd
  ) {
    return cached.value;
  }
  const value = resolveBundledPluginsDirUncached(env);
  metadata.bundledPluginsDir = {
    moduleUrl: import.meta.url,
    disabled,
    resolvedOverride,
    trustOverride,
    argv1,
    execPath,
    cwd,
    value,
  };
  return value;
}

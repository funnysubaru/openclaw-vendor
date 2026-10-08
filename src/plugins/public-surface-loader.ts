// Loads documented plugin public surfaces while preserving lazy boundaries.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MissingPublicSurfaceError } from "../plugin-sdk/facade-loader.js";
import { areBundledPluginsDisabled, resolveBundledPluginsDir } from "./bundled-dir.js";
import { shouldRejectHardlinkedPluginFiles } from "./hardlink-policy.js";
import { getPluginCacheRoot } from "./plugin-cache.js";
import {
  getCachedPluginModuleLoader,
  loadPluginPublicSurfaceModuleSync,
} from "./plugin-module-loader-cache.js";
import {
  resolveBundledPluginPublicSurfacePath,
  resolvePluginRootPublicSurfacePath,
} from "./public-surface-runtime.js";
import { resolveLoaderPackageRoot } from "./sdk-alias.js";

const OPENCLAW_PACKAGE_ROOT =
  resolveLoaderPackageRoot({
    modulePath: fileURLToPath(import.meta.url),
    moduleUrl: import.meta.url,
  }) ?? fileURLToPath(new URL("../..", import.meta.url));
type PublicSurfaceLocation = {
  modulePath: string;
  boundaryRoot: string;
};

// ADR-0033 任务72第二批本地等价修复（已查上游 src/plugin-sdk/facade-resolution-shared.ts 的
// createFacadeResolutionKey——上游当前实现与我们这里的旧写法同构，同样每次调用都对
// bundledPluginsDir 重新 path.resolve 一次再拼模板字符串，并未解决这处冗余，所以这里不搬
// 上游、自己写最小修复）。createResolutionKey 是 resolvePublicSurfaceLocation 的缓存键计算
// 函数本身，哪怕命中缓存也会被调用一次（见下方 resolvePublicSurfaceLocation），CPU profile
// 实测 path.resolve 这一步单独占 2.7 秒 self time。resolveBundledPluginsDir() 已经被
// #145226 改成命中缓存时返回同一个字符串引用（见 bundled-dir.ts），但 path.resolve 不认
// "同一个引用"这件事、每次都会重新规范化。这里补一层 size-1 的"上一次输入/输出"记忆化：
// 只要 resolveBundledPluginsDir() 这次返回的字符串和上次完全相同（绝大多数调用都是这种
// 情况——它在一次 Gateway 生命周期内几乎不变），直接复用上次 path.resolve 的结果，不重算。
// 安全性：path.resolve 对一条已经是绝对路径的输入是纯函数（resolveBundledPluginsDir 的
// 每条返回路径都已经是绝对路径，详见 bundled-dir.ts），所以按输入字符串严格相等做缓存
// 不会因为 cwd / env 变化产生假命中——一旦 bundledPluginsDir 的值真的变了（override、
// disabled、cwd 等任何会影响它的输入变了），字符串不相等，直接走回 path.resolve 重算。
let lastResolvedBundledPluginsDirInput: string | undefined;
let lastResolvedBundledPluginsDirOutput = "";
function resolveBundledPluginsDirAbsoluteMemoized(bundledPluginsDir: string): string {
  if (bundledPluginsDir === lastResolvedBundledPluginsDirInput) {
    return lastResolvedBundledPluginsDirOutput;
  }
  const resolved = path.resolve(bundledPluginsDir);
  lastResolvedBundledPluginsDirInput = bundledPluginsDir;
  lastResolvedBundledPluginsDirOutput = resolved;
  return resolved;
}

function createResolutionKey(params: {
  dirName: string;
  artifactBasename: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const bundledPluginsDir = resolveBundledPluginsDir(params.env);
  return `${params.dirName}::${params.artifactBasename}::${areBundledPluginsDisabled(params.env)}::${bundledPluginsDir ? resolveBundledPluginsDirAbsoluteMemoized(bundledPluginsDir) : "<default>"}`;
}

function resolvePublicSurfaceLocationUncached(params: {
  dirName: string;
  artifactBasename: string;
  env?: NodeJS.ProcessEnv;
}): PublicSurfaceLocation | null {
  const bundledPluginsDir = resolveBundledPluginsDir(params.env);
  const modulePath = resolveBundledPluginPublicSurfacePath({
    rootDir: OPENCLAW_PACKAGE_ROOT,
    ...(bundledPluginsDir ? { bundledPluginsDir, bundledPluginsDirMode: "explicit" as const } : {}),
    dirName: params.dirName,
    artifactBasename: params.artifactBasename,
    env: params.env,
  });
  if (!modulePath) {
    return null;
  }
  return {
    modulePath,
    boundaryRoot:
      bundledPluginsDir && modulePath.startsWith(path.resolve(bundledPluginsDir) + path.sep)
        ? path.resolve(bundledPluginsDir)
        : OPENCLAW_PACKAGE_ROOT,
  };
}

function resolvePublicSurfaceLocation(params: {
  dirName: string;
  artifactBasename: string;
  env?: NodeJS.ProcessEnv;
}): PublicSurfaceLocation | null {
  const key = createResolutionKey(params);
  const artifacts = getPluginCacheRoot(OPENCLAW_PACKAGE_ROOT).artifacts;
  const cached = artifacts.get(`public:${key}`);
  if (cached !== undefined) {
    return cached;
  }
  const resolved = resolvePublicSurfaceLocationUncached(params);
  artifacts.set(`public:${key}`, resolved);
  return resolved;
}

function loadPublicSurfaceModule(modulePath: string): unknown {
  // A TS require hook can force import-only dependencies through CommonJS resolution.
  // Keep source transforms and built-artifact native loading on the same canonical owner.
  const load = getCachedPluginModuleLoader({
    modulePath,
    importerUrl: import.meta.url,
    preferBuiltDist: true,
    loaderFilename: import.meta.url,
  });
  return load(modulePath);
}

function loadValidatedPublicSurfaceModule(params: {
  modulePath: string;
  boundaryRoot: string;
  boundaryLabel: string;
  surfaceLabel: string;
  origin: "bundled" | "global";
}): object {
  return loadPluginPublicSurfaceModuleSync({
    ...params,
    rejectHardlinks: shouldRejectHardlinkedPluginFiles({
      origin: params.origin,
      rootDir: params.boundaryRoot,
    }),
    loadModule: loadPublicSurfaceModule,
  });
}

function loadBundledPublicSurfaceAtLocation(params: {
  dirName: string;
  artifactBasename: string;
  location: PublicSurfaceLocation;
}): object {
  return loadValidatedPublicSurfaceModule({
    modulePath: params.location.modulePath,
    boundaryRoot: params.location.boundaryRoot,
    boundaryLabel:
      params.location.boundaryRoot === OPENCLAW_PACKAGE_ROOT
        ? "OpenClaw package root"
        : "plugin root",
    surfaceLabel: `bundled plugin public surface ${params.dirName}/${params.artifactBasename}`,
    origin: "bundled",
  });
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Dynamic public artifact loaders use caller-supplied module surface types.
export function loadBundledPluginPublicArtifactModuleSync<T extends object>(params: {
  dirName: string;
  artifactBasename: string;
  env?: NodeJS.ProcessEnv;
}): T {
  const location = resolvePublicSurfaceLocation(params);
  if (!location) {
    throw new MissingPublicSurfaceError(
      `Unable to resolve bundled plugin public surface ${params.dirName}/${params.artifactBasename}`,
    );
  }
  return loadBundledPublicSurfaceAtLocation({ ...params, location }) as T;
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Dynamic public artifact loaders use caller-supplied module surface types.
export function loadPluginPublicArtifactModuleSync<T extends object>(params: {
  pluginRoot: string;
  artifactBasename: string;
  origin?: "bundled" | "global";
}): T {
  const root = getPluginCacheRoot(params.pluginRoot);
  const key = `public:${params.artifactBasename}`;
  let location = root.artifacts.get(key);
  if (location === undefined) {
    const modulePath = resolvePluginRootPublicSurfacePath(params);
    location = modulePath ? { modulePath, boundaryRoot: root.rootDir } : null;
    root.artifacts.set(key, location);
  }
  if (!location) {
    throw new MissingPublicSurfaceError(
      `Unable to resolve plugin public surface ${params.pluginRoot}/${params.artifactBasename}`,
    );
  }
  return loadValidatedPublicSurfaceModule({
    ...location,
    boundaryLabel: "plugin root",
    surfaceLabel: `plugin public surface ${params.artifactBasename}`,
    origin: params.origin ?? "global",
  }) as T;
}

/** Loads the first resolvable bundled public artifact from an ordered candidate list. */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Dynamic public artifact loaders use caller-supplied module surface types.
export function loadBundledPluginPublicArtifactModuleFromCandidatesSync<T extends object>(params: {
  dirName: string;
  artifactCandidates: readonly string[];
  env?: NodeJS.ProcessEnv;
}): T | null {
  for (const artifactBasename of params.artifactCandidates) {
    const location = resolvePublicSurfaceLocation({
      dirName: params.dirName,
      artifactBasename,
      env: params.env,
    });
    if (location) {
      return loadBundledPublicSurfaceAtLocation({
        dirName: params.dirName,
        artifactBasename,
        location,
      }) as T;
    }
  }
  return null;
}

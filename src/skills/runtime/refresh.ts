import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import chokidar, { type FSWatcher } from "chokidar";
import { isDefaultStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveRealpathOrAbsolute } from "../../infra/boundary-path.js";
import { getFileWatchCapacityCode } from "../../infra/fs-watch-errors.js";
import { isPathInside } from "../../infra/path-guards.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { CONFIG_DIR, resolveUserPath } from "../../utils.js";
import {
  resolvePluginSkillRoots,
  resolvePluginSkillRootsFromMetadata,
} from "../loading/plugin-skills.js";
import {
  resolveAllowedSkillSymlinkTargetRealPaths,
  tryRealpath,
} from "../loading/symlink-targets.js";
import {
  normalizeWorkspaceSkillRoots,
  resolveWorkspaceSkillDirectories,
} from "../loading/workspace-skill-roots.js";
import { resolveWorkshopWatchRoots } from "../workshop/skills-root.js";
import { areOrderedArraysEqual } from "./ordered-array-equality.js";
import {
  bumpSkillsSnapshotVersion,
  clearSkillsSnapshotVersionForWorkspace,
  resetSkillsRefreshStateForTest,
  setSkillsChangeListenerErrorHandler,
} from "./refresh-state.js";
import { resolveSkillsWatchPath, toWatchRoot } from "./refresh-watch-path.js";
export { registerSkillsChangeListener } from "./refresh-state.js";

type SkillsPathWatchState = {
  // chokidar 后备/非原生平台使用。原生 recursive fs.watch 覆盖这个 root 时为 undefined。
  watcher?: FSWatcher;
  // macOS/Windows 的单个原生递归 fs.watch,覆盖整个 skill root。每个 chokidar
  // FSWatcher 内部会为同一个 root 分配 FSWatcher/WatchHelper/NodeFsHandler/
  // FSEventWrap 一整组包装对象(2026-10 内存排查实测:90 个 root 时 chokidar
  // 比原生 fs.watch 的常驻内存开销高一个数量级以上),原生 fs.watch 只是一个
  // OS 级 handle,没有这层包装,随员工数线性增长时开销小得多。
  native?: fs.FSWatcher;
  // 统一的"已拆除"旗标,取代原来到处判断 watcher.closed——因为现在一个 root
  // 可能由 chokidar 或原生 fs.watch 其中一种在覆盖,判断逻辑不能绑死某一种。
  disposed: boolean;
  watchRoot: string;
  depth: number;
  // 任务72:一个 workspace 常挂多个 skill root,旧实现里每个 root 的首次
  // ready 都各自独立广播一次(哪怕内容没变),N 个 root 就是 N 次全量
  // chat-metadata 重建。initialScan 把同一 workspace 名下全部 target 的
  // 首次扫描状态汇总,等全部 settle(ready/error)了才统一发一次。
  initialScan: "pending" | "ready" | "error";
  timer?: ReturnType<typeof setTimeout>;
  pendingPath?: string;
  readonly subscribers: Set<string>;
};

type WatchTarget = {
  path: string;
  watchRoot: string;
  depth: number;
};

type WatchTargetCacheEntry = {
  signature: string;
  targets: WatchTarget[];
};

type FileStabilitySnapshot = {
  size: number;
  mtimeMs: number;
};

const log = createSubsystemLogger("gateway/skills");
// Gateway startup imports this owner before serving turns. Shared watcher handles,
// including later rebuilds, must inherit that lifetime rather than the triggering turn.
const runInSkillsWatcherContext = AsyncLocalStorage.snapshot();
const GROUPED_SKILLS_WATCH_DEPTH = 6;
const CONFIGURED_ROOT_WATCH_DEPTH = 2;
const MAX_SYMLINK_WATCH_TARGETS_PER_ROOT = 100;
const MAX_SYMLINK_WATCH_DIRECTORY_SCANS_PER_ROOT = 200;
const MAX_SYMLINK_WATCH_RAW_ENTRIES_PER_ROOT = 2_000;
const RAW_SKILL_FILE_POLL_INTERVAL_MS = 100;
const SKILLS_WATCH_DEBOUNCE_MS = 250;
// 内存排查(2026-10,ADR-0033 任务72后续):macOS 上每个 chokidar FSWatcher 都会
// 分配一整组原生包装对象(FSWatcher/WatchHelper/NodeFsHandler/FSEventWrap),
// 合成探针实测在 90 个 root 规模下单个 chokidar watcher 比单个原生递归
// fs.watch 的常驻内存开销高一个数量级以上。每个员工的 workspace skill root
// 是不可共享的独立目录(不像全局/home skills 根那样被多个员工摊薄),所以
// 员工数越多,这份"每 root 固定开销"就越线性累积。用单个原生递归 fs.watch
// 替换该 root 的 chokidar watcher 不会减少 root 数量,但能大幅降低每个 root
// 的常驻内存底座。
//
// 只在 darwin/win32 开启(镜像上游 memory-core 原生 watcher 对同类问题
// #86613 的平台选择,以及 openclaw 上游 #90647 的思路——本仓按现有结构重写,
// 非逐行搬运):Linux 的 fs.watch({recursive:true}) 底层仍是逐文件 inotify
// 扇出,既没有 chokidar 的包装开销优势,也没有本仓要解决的常驻内存问题,继续
// 用 chokidar。任何平台原生 attach 失败都会退回 chokidar(见
// attachChokidarSkillsWatch 的调用点),不是"原生失败就不再监听"。
const NATIVE_RECURSIVE_SKILLS_WATCH_PLATFORMS = new Set<NodeJS.Platform>(["darwin", "win32"]);

// 现有 51 个单测全都假设"永远是 chokidar"(mock 的是 chokidar.watch,不是
// fs.watch),本仓 CI 跑在 ubuntu 上所以它们不会真的撞见原生路径——但本地在
// macOS/Windows 开发机上跑同一批测试会真的触发原生 fs.watch,断言落空。用
// 一个仅测试可写的覆盖位,让老测试显式关掉原生路径继续验 chokidar 行为,
// 新增的原生路径测试显式打开它,不依赖"CI 恰好是 Linux"这种隐性假设。
let nativeSkillsWatchOverrideForTest: "on" | "off" | undefined;

function nativeRecursiveSkillsWatchSupported(): boolean {
  if (nativeSkillsWatchOverrideForTest) {
    return nativeSkillsWatchOverrideForTest === "on";
  }
  return NATIVE_RECURSIVE_SKILLS_WATCH_PLATFORMS.has(process.platform);
}
// One watcher per unique watched directory. Agent workspaces that include the
// same shared skill root (the global skills dir, the home skills dir, or a
// configured extra/plugin dir) subscribe to the same watcher instead of each
// opening its own, so open file descriptors scale with distinct directories
// rather than with agent count.
const pathWatchers = new Map<string, SkillsPathWatchState>();
let nativeWatchCapacityFailed = false;
// chokidar 与原生 fs.watch 两种后端撞到系统 watch 容量上限时的共同处理:
// 全局只告警一次、拆掉全部 watcher,之后改由 agent 准备阶段刷新技能。
function handleSkillsWatchCapacityExhausted(capacityCode: string): void {
  if (nativeWatchCapacityFailed) {
    return;
  }
  nativeWatchCapacityFailed = true;
  log.warn(
    `skills native watcher capacity exhausted (${capacityCode}); refreshing skills during agent preparation`,
  );
  for (const active of pathWatchers.values()) {
    void teardownSkillsPathWatcher(active);
  }
}
// Watch targets each workspace is currently subscribed to, used to reconcile
// subscriptions and to detect watch-target changes across calls.
const workspaceWatchTargets = new Map<string, WatchTarget[]>();
// A watcher key may include an execution root, but refresh events and versions
// retain the configured agent workspace as their stable public identity.
const workspaceWatchOwnerDirs = new Map<string, string>();
// Resolved nested skill watch roots are filesystem-derived. Cache them so the
// per-turn watcher reconciliation path stays cheap until config or watched
// filesystem changes require a fresh root scan.
const workspaceWatchTargetCache = new Map<string, WatchTargetCacheEntry>();
const workspaceWatchLastEnsuredAt = new Map<string, number>();
// Session turns re-ensure their workspace; entries older than this are treated
// as abandoned subscriptions and evicted by the next ensure call.
const SKILLS_WORKSPACE_WATCH_IDLE_TTL_MS = 60 * 60_000;

setSkillsChangeListenerErrorHandler((err) => {
  log.warn(`skills change listener failed: ${String(err)}`);
});

const DEFAULT_SKILLS_WATCH_IGNORED: RegExp[] = [
  /(^|[\\/])\.git([\\/]|$)/,
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])dist([\\/]|$)/,
  // Python virtual environments and caches
  /(^|[\\/])\.venv([\\/]|$)/,
  /(^|[\\/])venv([\\/]|$)/,
  /(^|[\\/])__pycache__([\\/]|$)/,
  /(^|[\\/])\.mypy_cache([\\/]|$)/,
  /(^|[\\/])\.pytest_cache([\\/]|$)/,
  // Build artifacts and caches
  /(^|[\\/])build([\\/]|$)/,
  /(^|[\\/])\.cache([\\/]|$)/,
];

function resolveWatchTargets(
  workspaceDir: string,
  config: OpenClawConfig | undefined,
  agentId: string | undefined,
  executionWorkspaceDir: string | undefined,
  watcherKey: string,
  pluginMetadataSnapshot: PluginMetadataSnapshot | undefined,
): WatchTarget[] {
  const baseRoots = [workspaceDir, ...(executionWorkspaceDir ? [executionWorkspaceDir] : [])]
    .flatMap((workspace) => resolveWorkspaceSkillDirectories(workspace))
    .map(({ dir, source }) => ({ path: dir, source }));
  baseRoots.push(...resolveWorkshopWatchRoots(config, agentId));
  baseRoots.push({ path: path.join(CONFIG_DIR, "skills"), source: "openclaw-managed" });
  if (isDefaultStateDir()) {
    baseRoots.push({
      path: path.join(os.homedir(), ".agents", "skills"),
      source: "agents-skills-personal",
    });
  }
  const extraDirsRaw = config?.skills?.load?.extraDirs ?? [];
  const extraDirs = extraDirsRaw
    .map((d) => normalizeOptionalString(d) ?? "")
    .filter(Boolean)
    .map((dir) => resolveUserPath(dir));
  const pluginSkillRoots = pluginMetadataSnapshot
    ? resolvePluginSkillRootsFromMetadata({
        workspaceDir,
        config,
        metadataSnapshot: pluginMetadataSnapshot,
      })
    : resolvePluginSkillRoots({ workspaceDir, config });
  const pluginSkillDirs = pluginSkillRoots.map((root) => root.dir);
  const allowedSymlinkTargetRealPaths = resolveAllowedSkillSymlinkTargetRealPaths(config);
  const signature = JSON.stringify({
    basePaths: baseRoots.map((root) => toWatchRoot(root.path)),
    extraDirs: extraDirs.map(toWatchRoot),
    pluginSkillDirs: pluginSkillDirs.map(toWatchRoot),
    allowSymlinkTargets: allowedSymlinkTargetRealPaths,
  });
  const cached = workspaceWatchTargetCache.get(watcherKey);
  if (cached?.signature === signature) {
    return cached.targets;
  }

  const targets = new Map<string, WatchTarget>();
  for (const root of baseRoots) {
    addSkillSourceWatchTargets(
      targets,
      root.path,
      root.source,
      allowedSymlinkTargetRealPaths,
      GROUPED_SKILLS_WATCH_DEPTH,
    );
  }
  for (const resolved of extraDirs) {
    addSkillSourceWatchTargets(targets, resolved, "openclaw-extra", allowedSymlinkTargetRealPaths);
  }
  for (const dir of pluginSkillDirs) {
    addSkillSourceWatchTargets(targets, dir, "openclaw-plugin", allowedSymlinkTargetRealPaths);
  }
  const sortedTargets = Array.from(targets.values()).toSorted((a, b) =>
    a.path.localeCompare(b.path),
  );
  workspaceWatchTargetCache.set(watcherKey, { signature, targets: sortedTargets });
  return sortedTargets;
}

function makeWatchTarget(raw: string, depth: number): WatchTarget {
  const watchPath = toWatchRoot(resolveSkillsWatchPath(raw));
  let watchRoot = watchPath;
  while (!fs.existsSync(watchRoot)) {
    const parent = path.dirname(watchRoot);
    if (parent === watchRoot) {
      break;
    }
    watchRoot = parent;
  }
  return { path: watchPath, watchRoot: toWatchRoot(watchRoot), depth };
}

function addWatchTarget(targets: Map<string, WatchTarget>, raw: string, depth: number): void {
  const target = makeWatchTarget(raw, depth);
  target.depth = Math.max(target.depth, targets.get(target.path)?.depth ?? 0);
  targets.set(target.path, target);
}

function addSkillRootWatchTargets(
  targets: Map<string, WatchTarget>,
  root: string,
  rootDepth: number,
): string {
  addWatchTarget(targets, root, rootDepth);
  const companionSkillsRoot = path.join(root, "skills");
  addWatchTarget(targets, companionSkillsRoot, GROUPED_SKILLS_WATCH_DEPTH);
  return companionSkillsRoot;
}

function addSkillSourceWatchTargets(
  targets: Map<string, WatchTarget>,
  root: string,
  source: string,
  allowedSymlinkTargetRealPaths: readonly string[],
  rootDepth = path.basename(root) === "skills"
    ? GROUPED_SKILLS_WATCH_DEPTH
    : CONFIGURED_ROOT_WATCH_DEPTH,
): void {
  const companionSkillsRoot = addSkillRootWatchTargets(targets, root, rootDepth);
  // Both bounded scans share the source's containment identity for this preparation.
  // Trusted symlink leaves below remain registration-only, never recursive scans.
  const rootRealPath = resolveRealpathOrAbsolute(root);
  addTrustedSymlinkSkillWatchTargets(
    targets,
    root,
    source,
    allowedSymlinkTargetRealPaths,
    rootDepth,
    rootRealPath,
    rootRealPath,
  );
  addTrustedSymlinkSkillWatchTargets(
    targets,
    companionSkillsRoot,
    source,
    allowedSymlinkTargetRealPaths,
    GROUPED_SKILLS_WATCH_DEPTH,
    rootRealPath,
    resolveRealpathOrAbsolute(companionSkillsRoot),
  );
}

function addTrustedSymlinkSkillWatchTargets(
  targets: Map<string, WatchTarget>,
  root: string,
  source: string,
  allowedSymlinkTargetRealPaths: readonly string[],
  maxDepth: number,
  containmentRootRealPath: string,
  rootRealPath: string,
): void {
  try {
    if (
      fs.lstatSync(root).isSymbolicLink() &&
      isTrustedSymlinkSkillTarget(
        source,
        containmentRootRealPath,
        rootRealPath,
        allowedSymlinkTargetRealPaths,
      )
    ) {
      addSkillRootWatchTargets(targets, rootRealPath, maxDepth);
    }
  } catch {
    return;
  }
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let watched = 0;
  let directoryScans = 0;
  let rawEntries = 0;
  for (const queued of queue) {
    if (
      watched >= MAX_SYMLINK_WATCH_TARGETS_PER_ROOT ||
      directoryScans >= MAX_SYMLINK_WATCH_DIRECTORY_SCANS_PER_ROOT ||
      rawEntries >= MAX_SYMLINK_WATCH_RAW_ENTRIES_PER_ROOT
    ) {
      break;
    }
    const current = queued;
    if (!current) {
      continue;
    }
    const scan = readBudgetedDirEntries(
      current.dir,
      MAX_SYMLINK_WATCH_RAW_ENTRIES_PER_ROOT - rawEntries,
    );
    directoryScans += 1;
    rawEntries += scan.scannedEntryCount;
    if (!scan.ok) {
      continue;
    }
    for (const entry of scan.entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (watched >= MAX_SYMLINK_WATCH_TARGETS_PER_ROOT) {
        break;
      }
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const childPath = path.join(current.dir, entry.name);
      if (DEFAULT_SKILLS_WATCH_IGNORED.some((re) => re.test(childPath))) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        const targetRealPath = tryRealpath(childPath);
        if (
          targetRealPath &&
          isTrustedSymlinkSkillTarget(
            source,
            containmentRootRealPath,
            targetRealPath,
            allowedSymlinkTargetRealPaths,
          )
        ) {
          addSkillRootWatchTargets(targets, targetRealPath, GROUPED_SKILLS_WATCH_DEPTH);
          watched += 1;
        }
        continue;
      }
      if (entry.isDirectory() && current.depth < maxDepth) {
        queue.push({ dir: childPath, depth: current.depth + 1 });
      }
    }
  }
}

function readBudgetedDirEntries(
  dir: string,
  maxEntries: number,
):
  | { ok: true; entries: fs.Dirent[]; scannedEntryCount: number }
  | { ok: false; scannedEntryCount: number } {
  const entries: fs.Dirent[] = [];
  const limit = Math.max(0, maxEntries);
  let handle: fs.Dir | undefined;
  try {
    handle = fs.opendirSync(dir);
    for (let scanned = 0; scanned < limit; scanned += 1) {
      const entry = handle.readSync();
      if (!entry) {
        return { ok: true, entries, scannedEntryCount: scanned };
      }
      entries.push(entry);
    }
    return { ok: true, entries, scannedEntryCount: limit };
  } catch {
    return { ok: false, scannedEntryCount: 0 };
  } finally {
    handle?.closeSync();
  }
}

function isTrustedSymlinkSkillTarget(
  source: string,
  rootRealPath: string,
  targetRealPath: string,
  allowedSymlinkTargetRealPaths: readonly string[],
): boolean {
  if (source === "openclaw-managed" || source === "agents-skills-personal") {
    return true;
  }
  return (
    isPathInside(rootRealPath, targetRealPath) ||
    allowedSymlinkTargetRealPaths.some((root) => isPathInside(root, targetRealPath))
  );
}

function shouldIgnoreSkillsWatchPath(
  watchPath: string,
  stats?: { isDirectory?: () => boolean; isSymbolicLink?: () => boolean },
  usePolling = false,
): boolean {
  if (DEFAULT_SKILLS_WATCH_IGNORED.some((re) => re.test(watchPath))) {
    return true;
  }
  if (stats?.isDirectory?.() || stats?.isSymbolicLink?.()) {
    return false;
  }
  if (!stats) {
    return false;
  }
  if (usePolling && isSkillFileWatchPath(watchPath)) {
    return false;
  }
  // Regular files are surfaced through raw directory events below. Letting
  // chokidar include SKILL.md here registers per-file watchers and leaks FDs.
  return true;
}

function isSkillFileWatchPath(watchPath: string): boolean {
  if (DEFAULT_SKILLS_WATCH_IGNORED.some((re) => re.test(watchPath))) {
    return false;
  }
  const normalized = watchPath.replaceAll("\\", "/");
  return path.posix.basename(normalized) === "SKILL.md";
}

function getRawWatchedPath(details: unknown): string | undefined {
  return typeof details === "object" &&
    details !== null &&
    typeof (details as { watchedPath?: unknown }).watchedPath === "string"
    ? (details as { watchedPath: string }).watchedPath
    : undefined;
}

function rawPathToString(rawPath: unknown): string | undefined {
  if (typeof rawPath === "string") {
    return rawPath || undefined;
  }
  if (Buffer.isBuffer(rawPath)) {
    const decoded = rawPath.toString();
    return decoded || undefined;
  }
  return undefined;
}

function resolveRawSkillsWatchPath(rawPath: string, details: unknown): string | undefined {
  if (path.isAbsolute(rawPath)) {
    return rawPath;
  }
  const watchedPath = getRawWatchedPath(details);
  return watchedPath ? path.join(watchedPath, rawPath) : undefined;
}

function readFileStabilitySnapshot(filePath: string): FileStabilitySnapshot | undefined {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs } : undefined;
  } catch {
    return undefined;
  }
}

async function waitForStableSkillFile(
  filePath: string,
  stabilityMs: number,
  // 原来直接接 chokidar 的 FSWatcher 只为了读 .closed;原生 fs.watch 路径没有
  // 这个对象,改成由调用方传一个取值函数,两种后端共用同一份稳定性等待逻辑。
  isDisposed: () => boolean,
): Promise<void> {
  if (isDisposed() || stabilityMs <= 0) {
    return;
  }
  let previous = readFileStabilitySnapshot(filePath);
  if (!previous) {
    return;
  }
  let stableForMs = 0;
  while (stableForMs < stabilityMs) {
    const delayMs = Math.min(RAW_SKILL_FILE_POLL_INTERVAL_MS, stabilityMs - stableForMs);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    });
    // Closing a watcher retires raw polling, even while the file keeps changing.
    const next = isDisposed() ? undefined : readFileStabilitySnapshot(filePath);
    if (!next) {
      return;
    }
    if (next.size === previous.size && next.mtimeMs === previous.mtimeMs) {
      stableForMs += delayMs;
      continue;
    }
    previous = next;
    stableForMs = 0;
  }
}

function resolveSkillsWatcherUsePolling(): boolean {
  const envPolling = process.env.CHOKIDAR_USEPOLLING;
  if (envPolling === undefined) {
    const platform: string = process.platform;
    return platform === "os400";
  }
  const normalized = envPolling.toLowerCase();
  return Boolean(normalized) && normalized !== "false" && normalized !== "0";
}

function createSkillsPathWatcher(target: WatchTarget): SkillsPathWatchState {
  const usePolling = resolveSkillsWatcherUsePolling();

  const state: SkillsPathWatchState = {
    watchRoot: target.watchRoot,
    depth: target.depth,
    initialScan: "pending",
    disposed: false,
    subscribers: new Set<string>(),
  };

  const publishChange = (watcherKey: string, changedPath?: string) => {
    workspaceWatchTargetCache.delete(watcherKey);
    bumpSkillsSnapshotVersion({
      workspaceDir: workspaceWatchOwnerDirs.get(watcherKey) ?? watcherKey,
      reason: "watch",
      changedPath,
    });
  };

  // 只有某个 subscriber 的全部 target 都结算完(ready/error)才发一次;
  // state 被新 watcher 取代或已拆除(disposed)时放弃,避免对作废的 watcher 发布。
  // disposed 是跨 chokidar/原生 fs.watch 两种后端的统一判据,不再直接读
  // watcher.closed——原生 fs.watch 覆盖这个 root 时根本没有 chokidar watcher。
  const settleInitialScan = (result: "ready" | "error") => {
    if (
      state.disposed ||
      pathWatchers.get(target.path) !== state ||
      state.initialScan === "ready" ||
      state.initialScan === result
    ) {
      return;
    }
    state.initialScan = result;
    for (const watcherKey of state.subscribers) {
      const targets = workspaceWatchTargets.get(watcherKey);
      const allSettled = targets?.every((entry) => {
        const current = pathWatchers.get(entry.path);
        return current && !current.disposed && current.initialScan !== "pending";
      });
      if (allSettled) {
        publishChange(watcherKey);
      }
    }
  };

  const schedule = (changedPath?: string) => {
    // File-stability work may finish after this subscription has been closed.
    if (state.disposed) {
      return;
    }
    state.pendingPath = changedPath ?? state.pendingPath;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      const pendingPath = state.pendingPath;
      state.pendingPath = undefined;
      state.timer = undefined;
      // Fan the change out to every workspace subscribed to this directory so a
      // shared skill root refreshes the snapshot for all agents that use it.
      for (const watcherKey of state.subscribers) {
        publishChange(watcherKey, pendingPath);
      }
    }, SKILLS_WATCH_DEBOUNCE_MS);
  };
  const scheduleRawSkillFile = (changedPath: string) => {
    void waitForStableSkillFile(changedPath, SKILLS_WATCH_DEBOUNCE_MS, () => state.disposed)
      .catch((err: unknown) => {
        log.warn(`skills watcher stability check failed (${changedPath}): ${String(err)}`);
      })
      .then(() => schedule(changedPath));
  };

  // chokidar 后备/非原生平台路径:原来的实现原样保留,只是从"watcher 变量"
  // 改成读/写共享的 state.watcher + state.disposed,好让原生 fs.watch 失败时
  // 能复用同一套 schedule/settleInitialScan 退回这条路径。
  const attachChokidarSkillsWatch = () => {
    if (state.disposed || state.watcher) {
      return;
    }
    // Chokidar's missing-root fallback retains only the final basename, so it
    // misses creation through multiple absent parents. Watch the existing prefix
    // and restrict traversal to the logical root and its ancestor chain.
    const watcher = runInSkillsWatcherContext(() =>
      chokidar.watch(target.watchRoot, {
        ignoreInitial: true,
        followSymlinks: false,
        usePolling,
        // Skill root precedence and grouped discovery use the same bounded depth,
        // so watcher invalidation must observe that whole decision surface.
        depth:
          target.depth +
          path.relative(target.watchRoot, target.path).split(path.sep).filter(Boolean).length,
        awaitWriteFinish: {
          stabilityThreshold: SKILLS_WATCH_DEBOUNCE_MS,
          pollInterval: 100,
        },
        ignored: (watchPath, stats) =>
          shouldIgnoreSkillsWatchPath(watchPath, stats, usePolling) ||
          (!isPathInside(target.path, watchPath) && !isPathInside(watchPath, target.path)),
      }),
    );
    state.watcher = watcher;

    // ignoreInitial suppresses writes discovered before native watches are ready.
    // 不再让每个 root 的 ready 各自广播;汇总到 settleInitialScan,对齐上游
    // PR #146480 的思路(按本仓结构重写,非逐行搬运)。
    watcher.on("ready", () => settleInitialScan("ready"));
    watcher.on("all", (_event, changedPath) => {
      if (isPathInside(target.path, changedPath) || isPathInside(changedPath, target.path)) {
        schedule(changedPath);
      }
    });
    watcher.on("raw", (_eventName, rawPath, details) => {
      const rawPathText = rawPathToString(rawPath);
      if (!rawPathText) {
        const watchedPath = getRawWatchedPath(details);
        if (watchedPath && isPathInside(target.path, watchedPath)) {
          schedule(watchedPath);
        }
        return;
      }
      const changedPath = resolveRawSkillsWatchPath(rawPathText, details);
      if (
        changedPath &&
        isPathInside(target.path, changedPath) &&
        isSkillFileWatchPath(changedPath)
      ) {
        if (usePolling) {
          return;
        }
        scheduleRawSkillFile(changedPath);
      }
    });
    watcher.on("error", (err) => {
      if (state.disposed) {
        return;
      }
      const capacityCode = usePolling ? undefined : getFileWatchCapacityCode(err);
      if (capacityCode) {
        handleSkillsWatchCapacityExhausted(capacityCode);
        return;
      }
      log.warn(`skills watcher error (${target.path}): ${String(err)}`);
      // 一个 root 扫描失败不该让同一 workspace 的其它健康 root 永远等不到
      // 结算——用 "error" 结算这个 target,其余 target 该怎么判还怎么判。
      settleInitialScan("error");
    });
  };

  // 内存排查修复:macOS/Windows 上用单个原生递归 fs.watch 覆盖整个 root,
  // 不开 chokidar,省掉 chokidar 每个 root 固定的包装对象开销(见上面
  // NATIVE_RECURSIVE_SKILLS_WATCH_PLATFORMS 的注释)。usePolling 时沿用
  // chokidar(轮询语义和原生事件不是一回事,不在本次改动范围)。
  const attachNativeSkillsWatch = (): boolean => {
    if (state.disposed || usePolling || !nativeRecursiveSkillsWatchSupported()) {
      return false;
    }
    let native: fs.FSWatcher;
    try {
      native = fs.watch(target.watchRoot, { recursive: true }, (_eventType, filename) => {
        if (state.disposed) {
          return;
        }
        const name = rawPathToString(filename);
        if (!name) {
          // 文件名缺失(部分平台的部分事件会这样):无法判断具体改了哪个
          // 文件,保守起见整棵树都当作变了,语义上对应 chokidar raw 事件里
          // rawPath 为空时走 watchedPath 兜底的那一支。
          schedule();
          return;
        }
        const full = path.join(target.watchRoot, name);
        if (!(isPathInside(target.path, full) || isPathInside(full, target.path))) {
          return;
        }
        let stats: fs.Stats | undefined;
        try {
          stats = fs.lstatSync(full);
        } catch {
          stats = undefined;
        }
        // 直接复用 chokidar 的 ignored 判据,两种后端过滤口径一致:
        // node_modules/.git/.venv 等忽略目录里的变动不刷新;现存常规文件也被
        // "忽略",其中只有 SKILL.md 这类文件走稳定性等待再刷新(对应 chokidar
        // 的 raw 事件分支,isSkillFileWatchPath 对忽略目录同样返回 false)。
        if (shouldIgnoreSkillsWatchPath(full, stats)) {
          if (stats && isSkillFileWatchPath(full)) {
            scheduleRawSkillFile(full);
          }
          return;
        }
        // 目录/符号链接的增删,或路径已经不存在(常规文件被删除也会落到这
        // 里,因为 lstatSync 失败拿不到 stats)——对应 chokidar 的
        // add/addDir/unlink/unlinkDir,直接触发刷新,不用等稳定性。
        schedule(full);
      });
    } catch (err) {
      log.warn(
        `skills native watcher could not start on ${target.watchRoot}: ${String(err)}; falling back to chokidar`,
      );
      return false;
    }
    state.native = native;
    native.on("error", (err) => {
      if (state.disposed || state.native !== native) {
        return;
      }
      const capacityCode = getFileWatchCapacityCode(err);
      if (capacityCode) {
        handleSkillsWatchCapacityExhausted(capacityCode);
        return;
      }
      log.warn(`skills native watcher error (${target.watchRoot}): ${String(err)}`);
      // Node 文档:原生 fs.watch 出错后这个 watcher 实例不再可用。关掉它,
      // 补一次刷新覆盖可能错过的事件,再退回 chokidar 继续覆盖这个 root,
      // 而不是让它从此失去监听。
      state.native = undefined;
      try {
        native.close();
      } catch {
        // best effort
      }
      schedule();
      attachChokidarSkillsWatch();
    });
    // 原生 fs.watch 没有"初始扫描"这个阶段——attach 成功就立刻能收事件,
    // 不像 chokidar 要等 ready。用 queueMicrotask 推迟到 createSkillsPathWatcher
    // 返回、调用方把这个 state 写进 pathWatchers 之后才结算,否则
    // settleInitialScan 里 `pathWatchers.get(target.path) !== state` 的守卫
    // 会在 state 还没登记时误判成"已作废"而丢弹这次结算。
    queueMicrotask(() => settleInitialScan("ready"));
    return true;
  };

  if (!attachNativeSkillsWatch()) {
    attachChokidarSkillsWatch();
  }

  return state;
}

async function teardownSkillsPathWatcher(state: SkillsPathWatchState): Promise<void> {
  // disposed 先置位:两种后端的 close 都是尽力而为、可能抛错/可能是异步的,
  // 任何还在飞的回调(含正在跑的 scheduleRawSkillFile 稳定性等待)靠这个旗标
  // 立刻放弃,不依赖 close() 真正落地的时机。
  state.disposed = true;
  clearTimeout(state.timer);
  if (state.native) {
    const native = state.native;
    state.native = undefined;
    try {
      native.close();
    } catch {
      // Closing watchers is best effort, including during replacement and shutdown.
    }
  }
  if (!state.watcher) {
    return;
  }
  try {
    const wasClosed = state.watcher.closed;
    const closing = state.watcher.close();
    if (!wasClosed) {
      // Chokidar removes listeners before pending scans settle. Their late errors
      // belong to the retired watcher and must not become unhandled events.
      state.watcher.on("error", () => {});
    }
    await closing;
  } catch {
    // Closing watchers is best effort, including during replacement and shutdown.
  }
}

function subscribeWorkspaceToPath(workspaceDir: string, watchTarget: WatchTarget): void {
  const existing = pathWatchers.get(watchTarget.path);
  if (
    existing &&
    existing.watchRoot === watchTarget.watchRoot &&
    existing.depth >= watchTarget.depth
  ) {
    existing.subscribers.add(workspaceDir);
    return;
  }
  if (existing) {
    // A changed ancestor or deeper target needs a rebuilt watcher, preserving subscribers.
    const next = createSkillsPathWatcher({
      ...watchTarget,
      depth: Math.max(existing.depth, watchTarget.depth),
    });
    for (const subscriber of existing.subscribers) {
      next.subscribers.add(subscriber);
    }
    next.subscribers.add(workspaceDir);
    void teardownSkillsPathWatcher(existing);
    pathWatchers.set(watchTarget.path, next);
    return;
  }
  const state = createSkillsPathWatcher(watchTarget);
  state.subscribers.add(workspaceDir);
  pathWatchers.set(watchTarget.path, state);
}

function unsubscribeWorkspaceFromPath(workspaceDir: string, watchTarget: WatchTarget): void {
  const state = pathWatchers.get(watchTarget.path);
  if (!state) {
    return;
  }
  state.subscribers.delete(workspaceDir);
  if (state.subscribers.size === 0) {
    void teardownSkillsPathWatcher(state);
    pathWatchers.delete(watchTarget.path);
  }
}

function disposeWorkspaceWatchState(
  watcherKey: string,
  watchTargets: readonly WatchTarget[] = workspaceWatchTargets.get(watcherKey) ?? [],
): void {
  const workspaceDir = workspaceWatchOwnerDirs.get(watcherKey) ?? watcherKey;
  const hadWatchTargets = watchTargets.length > 0;
  for (const watchTarget of watchTargets) {
    unsubscribeWorkspaceFromPath(watcherKey, watchTarget);
  }
  workspaceWatchTargets.delete(watcherKey);
  workspaceWatchOwnerDirs.delete(watcherKey);
  workspaceWatchTargetCache.delete(watcherKey);
  workspaceWatchLastEnsuredAt.delete(watcherKey);
  if (hadWatchTargets) {
    // Watcher disposal creates an unwatched interval; mark the workspace dirty
    // so the next turn rebuilds skills even if file events were missed.
    bumpSkillsSnapshotVersion({ workspaceDir, reason: "watch-targets" });
  }
  clearSkillsSnapshotVersionForWorkspace(workspaceDir);
}

function evictIdleWorkspaceWatchStates(now: number): void {
  const cutoff = now - SKILLS_WORKSPACE_WATCH_IDLE_TTL_MS;
  for (const [workspaceDir, lastEnsuredAt] of workspaceWatchLastEnsuredAt) {
    if (lastEnsuredAt < cutoff) {
      disposeWorkspaceWatchState(workspaceDir);
    }
  }
}

export function ensureSkillsWatcher(params: {
  workspaceDir: string;
  executionWorkspaceDir?: string;
  config?: OpenClawConfig;
  agentId?: string;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
}) {
  const workspaceDir = params.workspaceDir.trim();
  if (!workspaceDir) {
    return;
  }
  const { executionWorkspaceDir } = normalizeWorkspaceSkillRoots({
    agentWorkspaceDir: workspaceDir,
    executionWorkspaceDir: params.executionWorkspaceDir,
  });
  const watcherKey = JSON.stringify([workspaceDir, executionWorkspaceDir, params.agentId]);
  workspaceWatchOwnerDirs.set(watcherKey, workspaceDir);
  const now = Date.now();
  const watchEnabled = params.config?.skills?.load?.watch !== false;
  const previousTargets = workspaceWatchTargets.get(watcherKey) ?? [];

  if (!watchEnabled) {
    disposeWorkspaceWatchState(watcherKey, previousTargets);
    evictIdleWorkspaceWatchStates(now);
    return;
  }

  workspaceWatchLastEnsuredAt.set(watcherKey, now);
  if (nativeWatchCapacityFailed) {
    // Both skill caches use this version. Rebuild at the existing preparation
    // boundary while native observation is unavailable, without reopening watches.
    workspaceWatchTargetCache.delete(watcherKey);
    bumpSkillsSnapshotVersion({ workspaceDir, reason: "watch" });
    evictIdleWorkspaceWatchStates(now);
    return;
  }
  const watchTargets = resolveWatchTargets(
    workspaceDir,
    params.config,
    params.agentId,
    executionWorkspaceDir,
    watcherKey,
    params.pluginMetadataSnapshot,
  );
  // resolveWatchTargets returns stable sorted order, so positional equality is intentional.
  const targetsUnchanged = areOrderedArraysEqual(
    previousTargets,
    watchTargets,
    (previous, next) =>
      previous.path === next.path &&
      previous.watchRoot === next.watchRoot &&
      previous.depth === next.depth,
  );
  const watcherDepthsCoverTargets = watchTargets.every(
    (watchTarget) => (pathWatchers.get(watchTarget.path)?.depth ?? -1) >= watchTarget.depth,
  );
  if (targetsUnchanged && watcherDepthsCoverTargets) {
    evictIdleWorkspaceWatchStates(now);
    return;
  }
  const nextTargetKeys = new Set(watchTargets.map((target) => target.path));
  for (const watchTarget of previousTargets) {
    if (!nextTargetKeys.has(watchTarget.path)) {
      unsubscribeWorkspaceFromPath(watcherKey, watchTarget);
    }
  }
  for (const watchTarget of watchTargets) {
    subscribeWorkspaceToPath(watcherKey, watchTarget);
  }
  workspaceWatchTargets.set(watcherKey, watchTargets);

  // Acquisition must invalidate reads cached during an unwatched interval,
  // before the first consumer runs or the asynchronous initial scan completes.
  if (!targetsUnchanged) {
    bumpSkillsSnapshotVersion({
      workspaceDir,
      reason: "watch-targets",
      changedPath: watchTargets.map((target) => target.path).join("|"),
    });
  }
  evictIdleWorkspaceWatchStates(now);
}

export async function closeSkillsWatchers(resetState = false): Promise<void> {
  if (resetState) {
    resetSkillsRefreshStateForTest();
  }
  const active = Array.from(pathWatchers.values());
  nativeWatchCapacityFailed = false;
  pathWatchers.clear();
  workspaceWatchTargets.clear();
  workspaceWatchOwnerDirs.clear();
  workspaceWatchTargetCache.clear();
  workspaceWatchLastEnsuredAt.clear();
  await Promise.all(active.map(teardownSkillsPathWatcher));
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.skillsRefreshTestApi")] = {
    resetSkillsRefreshForTest: () => {
      // 每个测试文件 afterEach 都会调 reset,顺手清掉覆盖位,不必各自再写一行。
      nativeSkillsWatchOverrideForTest = undefined;
      return closeSkillsWatchers(true);
    },
    setNativeSkillsWatchOverrideForTest: (forced: "on" | "off" | undefined) => {
      nativeSkillsWatchOverrideForTest = forced;
    },
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

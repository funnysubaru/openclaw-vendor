// ADR-0033 任务72:多个 skill root 的 chokidar "ready" 必须合并成一次广播。
// 单独开一个测试文件(而不是塞进已经逼近 oxlint max-lines 上限的
// refresh.test.ts),结构照搬那个文件自己已有的 beforeAll/beforeEach 套路。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillsChangeEvent } from "./refresh-state.js";
import { createSkillsWatcherMock } from "./refresh.watcher.test-support.js";

const { createdWatchers, watchMock, watchForSkillRoot } = createSkillsWatcherMock();

vi.mock("chokidar", () => ({ default: { watch: watchMock } }));
vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
  resolvePluginSkillRootsFromMetadata: () => [],
}));

let refreshModule: typeof import("./refresh.js");
let refreshTestSupport: typeof import("./refresh.test-support.js");
let fixtureRoot: string;
let fixtureWorkspaceDir: string;

async function createFixtureDirectory(relativePath: string): Promise<string> {
  const directory = path.join(fixtureRoot, relativePath);
  await fs.mkdir(directory, { recursive: true });
  return directory;
}

// 订阅 skills 变更广播,返回一个随事件增长的数组,供断言"发了几次、发给谁"。
function recordSkillsChanges(): SkillsChangeEvent[] {
  const seen: SkillsChangeEvent[] = [];
  refreshModule.registerSkillsChangeListener((change) => {
    seen.push(change);
  });
  return seen;
}

// 让除 last 以外的全部 watcher 先 ready——包括 resolveWatchTargets 给
// workspace 自身目录建的那个,只数 extraDirs 会漏掉它。
function emitReadyExcept(last: (typeof createdWatchers)[number]): void {
  for (const watcher of createdWatchers) {
    if (watcher !== last) {
      watcher.emit("ready");
    }
  }
}

describe("ensureSkillsWatcher ready coalescing", () => {
  beforeAll(async () => {
    refreshModule = await import("./refresh.js");
    refreshTestSupport = await import("./refresh.test-support.js");
  });

  beforeEach(async () => {
    watchMock.mockClear();
    createdWatchers.length = 0;
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watch-ready-coalesce-"));
    fixtureWorkspaceDir = await createFixtureDirectory("workspace");
    await createFixtureDirectory("workspace/skills");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await refreshTestSupport.resetSkillsRefreshForTest();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("fans out shared-directory change to every subscribed workspace", async () => {
    vi.useFakeTimers();
    const secondWorkspace = await createFixtureDirectory("second-workspace");
    const sharedRoot = await createFixtureDirectory("shared");
    const config = { skills: { load: { extraDirs: [sharedRoot] } } };
    const seen = recordSkillsChanges();
    refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir, config });
    refreshModule.ensureSkillsWatcher({ workspaceDir: secondWorkspace, config });
    seen.length = 0;
    const changedPath = path.join(sharedRoot, "demo", "SKILL.md");
    const watcher = watchForSkillRoot(sharedRoot).watcher;
    watcher.emit("all", "change", changedPath);
    await vi.advanceTimersByTimeAsync(250);

    expect(seen).toEqual([
      { workspaceDir: fixtureWorkspaceDir, reason: "watch", changedPath },
      { workspaceDir: secondWorkspace, reason: "watch", changedPath },
    ]);
  });

  // 任务72修复:单个 workspace 的某一个 root 单独 ready 不再立刻广播——必须
  // 等这个 workspace 名下全部 root 都结算完才发一次(settleInitialScan)。
  // 所以这里要先把两个 workspace 自己主目录的 watcher 都 ready 掉,再让
  // shared root 最后一个 ready,才能等到汇总后的那一次 fanout。
  it("fans out shared-directory ready only after every root for a workspace settles", async () => {
    vi.useFakeTimers();
    const secondWorkspace = await createFixtureDirectory("second-workspace");
    const sharedRoot = await createFixtureDirectory("shared");
    const config = { skills: { load: { extraDirs: [sharedRoot] } } };
    const seen = recordSkillsChanges();
    refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir, config });
    refreshModule.ensureSkillsWatcher({ workspaceDir: secondWorkspace, config });
    seen.length = 0;
    const sharedWatcher = watchForSkillRoot(sharedRoot).watcher;
    emitReadyExcept(sharedWatcher);
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toEqual([]);

    sharedWatcher.emit("ready");
    await vi.advanceTimersByTimeAsync(250);

    expect(seen).toEqual([
      { workspaceDir: fixtureWorkspaceDir, reason: "watch", changedPath: undefined },
      { workspaceDir: secondWorkspace, reason: "watch", changedPath: undefined },
    ]);
  });

  // 任务72回归测试:一个 workspace 自己名下挂了多个 skill root(常见于
  // 多个 extraDirs),每个 root 各自独立的 chokidar "ready" 不该各自触发一次
  // 全量广播——只有全部 root 都 settle 完才发一次。修复前这里会看到 N 次
  // "watch" 事件(N = root 数),修复后只有 1 次。
  it("coalesces one workspace's multiple independent skill roots into a single ready broadcast", async () => {
    vi.useFakeTimers();
    const rootA = await createFixtureDirectory("multi-root-a");
    const rootB = await createFixtureDirectory("multi-root-b");
    const rootC = await createFixtureDirectory("multi-root-c");
    const config = { skills: { load: { extraDirs: [rootA, rootB, rootC] } } };
    const seen = recordSkillsChanges();
    refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir, config });
    seen.length = 0;

    const watcherC = watchForSkillRoot(rootC).watcher;
    emitReadyExcept(watcherC);
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toEqual([]);

    // 最后一个 root ready,全部 root 都结算完,这才发一次——不是四次。
    watcherC.emit("ready");
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toEqual([
      { workspaceDir: fixtureWorkspaceDir, reason: "watch", changedPath: undefined },
    ]);
  });
});

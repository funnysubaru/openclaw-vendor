// 内存排查(2026-10,ADR-0033 任务72后续):macOS/Windows 上用单个原生递归
// fs.watch 覆盖一个 skill root,取代一组 chokidar 包装对象,参见
// refresh.ts 里 NATIVE_RECURSIVE_SKILLS_WATCH_PLATFORMS 的注释。
// 这里只验证"原生路径确实被用上、确实还能检测变化、失败时确实退回
// chokidar"这三件事本身——跨平台(darwin/win32)语义靠 override 强制
// 打开,不依赖本仓 CI 恰好是哪个宿主机 OS。
import nativeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillsChangeEvent } from "./refresh-state.js";
import { createSkillsWatcherMock } from "./refresh.watcher.test-support.js";

const { watchMock } = createSkillsWatcherMock();

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

describe("ensureSkillsWatcher native recursive fs.watch", () => {
  beforeAll(async () => {
    refreshModule = await import("./refresh.js");
    refreshTestSupport = await import("./refresh.test-support.js");
  });

  beforeEach(async () => {
    watchMock.mockClear();
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watch-native-"));
    fixtureWorkspaceDir = await createFixtureDirectory("workspace");
    await createFixtureDirectory("workspace/skills");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await refreshTestSupport.resetSkillsRefreshForTest();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("uses native recursive fs.watch per root instead of chokidar when forced on", async () => {
    refreshTestSupport.setNativeSkillsWatchOverrideForTest("on");
    const watchSpy = vi.spyOn(nativeFs, "watch");
    refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir });
    // 一次 ensureSkillsWatcher 会给好几个 skill root(全局/home/workspace 自己的
    // 等)各开一个watcher,所以不是恰好 1 次——关键断言是"一次 chokidar.watch
    // 都没调"和"每次原生 attach 都带 recursive:true",而不是具体次数。
    expect(watchMock).not.toHaveBeenCalled();
    expect(watchSpy.mock.calls.length).toBeGreaterThan(0);
    for (const call of watchSpy.mock.calls) {
      expect(call[1]).toMatchObject({ recursive: true });
    }
  });

  it("detects a SKILL.md change through the native watcher and triggers a refresh", async () => {
    refreshTestSupport.setNativeSkillsWatchOverrideForTest("on");
    vi.useFakeTimers();
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => {
      if (change.workspaceDir === fixtureWorkspaceDir) {
        seen.push(change);
      }
    });
    refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir });
    const skillDir = path.join(fixtureWorkspaceDir, "skills", "native-proof");
    await fs.mkdir(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, "SKILL.md");
    // 目录新建走 schedule() 直接刷新分支(对应 chokidar 的 addDir),不需要
    // 等 awaitWriteFinish 式的稳定性窗口。
    await vi.waitFor(
      () => {
        vi.advanceTimersByTime(300);
        expect(seen.length).toBeGreaterThan(0);
      },
      { timeout: 3_000, interval: 10 },
    );
    seen.length = 0;
    await fs.writeFile(skillFile, "# native proof\n");
    // SKILL.md 本身走 scheduleRawSkillFile 的稳定性等待分支,需要真实时间
    // 流逝(内部用 setTimeout + 真实轮询读 mtime/size),所以这里切回真实计时器。
    vi.useRealTimers();
    await vi.waitFor(
      () => {
        expect(seen.some((change) => change.changedPath === skillFile)).toBe(true);
      },
      { timeout: 3_000 },
    );
  });

  it("falls back to chokidar when the native watcher fails to attach", async () => {
    refreshTestSupport.setNativeSkillsWatchOverrideForTest("on");
    const watchSpy = vi.spyOn(nativeFs, "watch").mockImplementation(() => {
      throw new Error("simulated native watch attach failure");
    });
    refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir });
    // 每一个 root 的原生 attach 都失败,所以每一个都该退回 chokidar——
    // 两边调用次数应该一致,而不是"一次失败就整体放弃监听"。
    expect(watchSpy.mock.calls.length).toBeGreaterThan(0);
    expect(watchMock).toHaveBeenCalledTimes(watchSpy.mock.calls.length);
  });
});

// PR #124 review（164399 回搬）Important 1 的回归锁：164399 退休的是"扫描/导入"嵌套
// <workspace>/.openclaw/workspace-state.json，不是"记忆它存在过"。这四条用例把第一轮
// ensureAgentWorkspace 在"只有嵌套残留"这一具体场景下的实际行为钉死，覆盖 review 列出
// 的三种 sqlite/ensureBootstrapFiles 组合，外加一条"已有 BOOTSTRAP.md 不被删"的加强
// 用例。单独拆成这个文件，避免把 workspace.test.ts 顶到 oxlint max-lines(1000) 上限。
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { makeTempWorkspace, writeWorkspaceFile } from "../test-helpers/workspace.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resetLegacyWorkspaceStateCheckForTest } from "./workspace-legacy-state.test-support.js";
import { mergeWorkspaceSetupState, readWorkspaceStateSnapshot } from "./workspace-state-store.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
  ensureAgentWorkspace,
} from "./workspace.js";

let testState: OpenClawTestState | undefined;

beforeEach(async () => {
  resetLegacyWorkspaceStateCheckForTest();
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-workspace-legacy-sidecar-",
  });
});

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  resetLegacyWorkspaceStateCheckForTest();
  await testState?.cleanup();
  testState = undefined;
});

// 164399 退休的嵌套旧布局：<workspace>/.openclaw/workspace-state.json。写它只是为了
// 模拟 3.12 时代残留在用户机器上的文件，不代表 Doctor/运行时还会去读它。
function nestedLegacyWorkspaceStatePath(dir: string): string {
  return path.join(dir, ".openclaw", "workspace-state.json");
}

async function writeNestedLegacyWorkspaceState(dir: string, state: unknown): Promise<void> {
  const nestedPath = nestedLegacyWorkspaceStatePath(dir);
  await fs.mkdir(path.dirname(nestedPath), { recursive: true });
  await fs.writeFile(nestedPath, `${JSON.stringify(state)}\n`);
}

async function readWorkspaceState(dir: string): Promise<{
  version: number;
  bootstrapSeededAt?: string;
  setupCompletedAt?: string;
}> {
  return readWorkspaceStateSnapshot(dir).setup;
}

async function expectBootstrapSeeded(dir: string) {
  await expect(fs.access(path.join(dir, DEFAULT_BOOTSTRAP_FILENAME))).resolves.toBeUndefined();
  const state = await readWorkspaceState(dir);
  expect(state.bootstrapSeededAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
}

async function expectPathMissing(filePath: string): Promise<void> {
  await expect(fs.access(filePath)).rejects.toHaveProperty("code", "ENOENT");
}

describe("ensureAgentWorkspace with a retired nested .openclaw/workspace-state.json sidecar", () => {
  it("does not reseed or delete BOOTSTRAP.md when SQLite setup is already completed alongside a retired nested sidecar (164399)", async () => {
    // sqlite 已经有完整 setup 行（例如旧版本曾经导入过，或 Doctor 迁移过）：
    // 既不会重播 BOOTSTRAP.md，也不会去碰这份嵌套残留文件。
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await writeNestedLegacyWorkspaceState(tempDir, {
      version: 1,
      bootstrapSeededAt: "2026-03-11T07:29:46.972Z",
    });
    const seededAt = "2026-03-15T14:30:17.984Z";
    const completedAt = "2026-06-12T02:32:12.448Z";
    mergeWorkspaceSetupState(tempDir, {
      bootstrapSeededAt: seededAt,
      setupCompletedAt: completedAt,
    });
    // 已完成 onboarding 的真实工作区常态：画像文件已偏离模板，没有 BOOTSTRAP.md。
    await writeWorkspaceFile({
      dir: tempDir,
      name: DEFAULT_IDENTITY_FILENAME,
      content: "custom identity",
    });
    await writeWorkspaceFile({ dir: tempDir, name: DEFAULT_USER_FILENAME, content: "custom user" });
    const nestedBefore = await fs.readFile(nestedLegacyWorkspaceStatePath(tempDir), "utf-8");

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

    await expectPathMissing(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME));
    const nestedAfter = await fs.readFile(nestedLegacyWorkspaceStatePath(tempDir), "utf-8");
    expect(nestedAfter).toBe(nestedBefore);
    expect(readWorkspaceStateSnapshot(tempDir).setup).toEqual({
      version: 1,
      bootstrapSeededAt: seededAt,
      setupCompletedAt: completedAt,
    });
  });

  it("seeds BOOTSTRAP.md on first contact when SQLite setup is empty and only a retired nested sidecar exists (164399 known behavior, not a regression to fix here)", async () => {
    // sqlite 没有任何 setup 行、画像文件仍是模板：ensureBootstrapFiles:true 会把
    // 它当全新工作区播种 BOOTSTRAP.md。这是 164399 本身的预期行为——退休的是
    // "扫描导入嵌套文件"，不是"记住已经 onboarding 过"；这条用例如实锁住当前
    // 行为，不代表要在这个 PR 里新增"单独读嵌套文件挡重播"的逻辑（超出 164399
    // 范围，Yuiclaw 也用不到，见下一条用例）。
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await writeNestedLegacyWorkspaceState(tempDir, {
      version: 1,
      bootstrapSeededAt: "2026-03-11T07:29:46.972Z",
    });
    const nestedBefore = await fs.readFile(nestedLegacyWorkspaceStatePath(tempDir), "utf-8");

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

    await expectBootstrapSeeded(tempDir);
    const nestedAfter = await fs.readFile(nestedLegacyWorkspaceStatePath(tempDir), "utf-8");
    expect(nestedAfter).toBe(nestedBefore);
    const state = await readWorkspaceState(tempDir);
    expect(state.setupCompletedAt).toBeUndefined();
  });

  it("skips bootstrap seeding entirely via ensureBootstrapFiles:false, even with only a retired nested sidecar present (Yuiclaw's skipBootstrap:true path)", async () => {
    // Yuiclaw 的 gateway-config-builder.ts:253 永远写 agents.defaults.skipBootstrap:
    // true，对应这里的 ensureBootstrapFiles:false——会在 workspace.ts 的早退分支
    // 直接返回（现在在 :1012 附近，具体行号随改动漂移），根本到不了上一条用例里
    // 会写 BOOTSTRAP.md 的播种逻辑。这才是 Yuiclaw 真实机器上会走的路径，用这条
    // 用例把它和"ensureBootstrapFiles:true 时会播种"的行为分开锁住，不抛错。
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await writeNestedLegacyWorkspaceState(tempDir, {
      version: 1,
      bootstrapSeededAt: "2026-03-11T07:29:46.972Z",
    });
    const nestedBefore = await fs.readFile(nestedLegacyWorkspaceStatePath(tempDir), "utf-8");

    await expect(
      ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: false }),
    ).resolves.toMatchObject({ dir: tempDir, bootstrapPending: false });

    await expectPathMissing(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME));
    await expectPathMissing(path.join(tempDir, DEFAULT_AGENTS_FILENAME));
    const nestedAfter = await fs.readFile(nestedLegacyWorkspaceStatePath(tempDir), "utf-8");
    expect(nestedAfter).toBe(nestedBefore);
    expect(readWorkspaceStateSnapshot(tempDir).setupExists).toBe(false);
  });

  it("never deletes an existing BOOTSTRAP.md via the skipBootstrap path, even with a divergent profile and a retired nested sidecar", async () => {
    // 加强用例：空 sqlite + 已有 BOOTSTRAP.md + 画像已偏离模板 + skipBootstrap
    // 路径——ensureBootstrapFiles:false 的早退分支从不调用会删除 BOOTSTRAP.md 的
    // reconcileWorkspaceBootstrapCompletionState，这里直接验证文件原样保留。
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await writeNestedLegacyWorkspaceState(tempDir, {
      version: 1,
      bootstrapSeededAt: "2026-03-11T07:29:46.972Z",
    });
    await writeWorkspaceFile({
      dir: tempDir,
      name: DEFAULT_BOOTSTRAP_FILENAME,
      content: "existing bootstrap\n",
    });
    await writeWorkspaceFile({
      dir: tempDir,
      name: DEFAULT_IDENTITY_FILENAME,
      content: "custom identity",
    });

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: false });

    expect(await fs.readFile(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME), "utf-8")).toBe(
      "existing bootstrap\n",
    );
  });
});

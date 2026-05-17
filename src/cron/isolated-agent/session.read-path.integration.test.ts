import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionStore, saveSessionStore, updateSessionStore } from "../../config/sessions.js";
import { readSessionMessages } from "../../gateway/session-utils.fs.js";
import { resolveCronSession } from "./session.js";

/**
 * B1 集成回归 — panel-* sessionKey 复用时清掉 stale sessionFile,
 * 然后 chat.history read-path 能读到新 jsonl 而非旧 jsonl。
 *
 * 1.15.244 修复 Yuiclaw 2026-05-16 Ralph Lauren cron tab 空白事故:
 *
 * 事故复现条件:
 *   1) panel-* sessionKey entry 历史落库为 sessionId=A + sessionFile="/path/B.jsonl"
 *      (字段错位 — A.jsonl 是新写入, B.jsonl 是历史 stale 路径)
 *   2) cron 触发 resolveCronSession → PR-B 复用 sessionId=A,但旧 sessionFile 通过
 *      ...entry spread 持续保留写回
 *   3) panel UI 调 chat.history → readSessionMessages 优先用 sessionFile 候选
 *      → 命中 B.jsonl (旧) → 永远看不到 A.jsonl (新) 内容
 *
 * B1 修复:
 *   resolveCronSession 在 panel-* 分支后 delete sessionEntry.sessionFile,
 *   写回 sessions.json 时字段消失,下次 readSessionMessages 走 sessionsDir +
 *   sessionId 标准 fallback,自动指向 A.jsonl。
 *
 * 这条测试分 2 层断言:
 *   Step 1 (持久化形态层): resolveCronSession → updateSessionStore → reload
 *     sessions.json,断言 entry 没有 sessionFile own property
 *   Step 2 (read-path 层): 用 reload 的 entry 调 readSessionMessages,断言
 *     返回 messages 含 NEW_MARKER 不含 OLD_MARKER
 *
 * 与 cron/isolated-agent/session.test.ts 的拆分:
 *   - session.test.ts: 纯逻辑用例 (mock loadSessionStore, 不碰文件系统)
 *   - 本文件: 集成端到端 (真实 tmp 文件系统 + 真实 sessions.json + 真实
 *     readSessionMessages read-path)
 */

const PANEL_KEY = "agent:custom-cbd0fe4a:user:06148fa3-9aa3-4b28-b1b1-3513ada1dc9e:panel-d1e7fc49";
const OLD_MARKER = "B1_TEST_OLD_TRANSCRIPT_MARKER";
const NEW_MARKER = "B1_TEST_NEW_TRANSCRIPT_MARKER";

function writeJsonl(filePath: string, lines: unknown[]): void {
  fs.writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join("\n"), "utf-8");
}

describe("B1 integration: panel-* reuse → persist → readSessionMessages reads new jsonl", () => {
  let tmpDir: string;
  let sessionsDir: string;
  let storePath: string;
  let oldJsonlPath: string;
  let newJsonlPath: string;
  const NEW_SESSION_ID = "27031159-490d-442e-94a6-eb70275cca6f";
  const OLD_SESSION_ID = "53258a3e-9cd2-4fb0-ac63-464db5d24d4f";

  beforeAll(async () => {
    // 模拟 yuiclaw 真实 layout:
    //   <tmpDir>/sessions/sessions.json
    //   <tmpDir>/sessions/<NEW_SESSION_ID>.jsonl   ← cron 刚写入,vendor fallback 会用
    //   <tmpDir>/sessions/<OLD_SESSION_ID>.jsonl   ← stale,entry.sessionFile 指向它
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-b1-readpath-"));
    sessionsDir = path.join(tmpDir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    storePath = path.join(sessionsDir, "sessions.json");
    newJsonlPath = path.join(sessionsDir, `${NEW_SESSION_ID}.jsonl`);
    oldJsonlPath = path.join(sessionsDir, `${OLD_SESSION_ID}.jsonl`);

    // 旧 jsonl: 含 OLD_MARKER
    writeJsonl(oldJsonlPath, [
      { type: "session", version: 1, id: OLD_SESSION_ID },
      { message: { role: "user", content: OLD_MARKER } },
      { message: { role: "assistant", content: "old reply" } },
    ]);
    // 新 jsonl: 含 NEW_MARKER (这就是 cron 实际写入的位置)
    writeJsonl(newJsonlPath, [
      { type: "session", version: 1, id: NEW_SESSION_ID },
      { message: { role: "user", content: NEW_MARKER } },
      { message: { role: "assistant", content: "new reply" } },
    ]);
    // 模拟事故的 sessions.json 形态: sessionId 已经是新的 (1.15.239 PR-B 让它在
    // panel-* 上 reuse,所以 cron 触发后不滚走),但 sessionFile 仍指向旧绝对路径
    // (历史 rollover / 其它写入路径留下);写回时 stale 状态被 ...entry spread 持续保留。
    await saveSessionStore(storePath, {
      [PANEL_KEY]: {
        sessionId: NEW_SESSION_ID,
        sessionFile: oldJsonlPath, // 绝对路径,真实事故形态
        updatedAt: Date.now() - 10_000,
        systemSent: true,
      },
    });
  });

  afterAll(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("Step 1: resolveCronSession + persist → reloaded sessions.json no longer has sessionFile own property", async () => {
    // 触发 cron isolated-agent 路径 (forceNew: true 是 isolated 默认)
    const cronSession = resolveCronSession({
      cfg: {
        session: {
          // 用 explicit store path,绕过 cfg 解析逻辑
          store: storePath,
        },
      } as unknown as OpenClawConfig,
      sessionKey: PANEL_KEY,
      agentId: "custom-cbd0fe4a",
      nowMs: Date.now(),
      forceNew: true,
    });

    // 复用 sessionId 验证 PR-B 行为不退化
    expect(cronSession.sessionEntry.sessionId).toBe(NEW_SESSION_ID);

    // B1 修复点直接断言: 返回的 sessionEntry 上 sessionFile own property 消失
    expect("sessionFile" in cronSession.sessionEntry).toBe(false);

    // 模拟 cron/isolated-agent/run.ts:persistSessionEntry 写回 store
    await updateSessionStore(cronSession.storePath, (store) => {
      store[PANEL_KEY] = cronSession.sessionEntry;
    });

    // reload sessions.json (跳过 cache 拿最新)
    const reloaded = loadSessionStore(storePath, { skipCache: true });
    const reloadedEntry = reloaded[PANEL_KEY];
    expect(reloadedEntry).toBeDefined();
    // 持久化形态层: 写回后字段不应出现在 JSON 中
    expect("sessionFile" in reloadedEntry).toBe(false);
    // sessionId 保持复用
    expect(reloadedEntry?.sessionId).toBe(NEW_SESSION_ID);
  });

  test("Step 2: readSessionMessages on reloaded entry returns NEW_MARKER (not OLD_MARKER)", () => {
    // 拿 Step 1 写回后的 entry,模拟 chat.history 的实际调用
    const reloaded = loadSessionStore(storePath, { skipCache: true });
    const entry = reloaded[PANEL_KEY];
    expect(entry).toBeDefined();

    // 关键断言: entry.sessionFile 应该是 undefined (字段已 omit),所以 readSessionMessages
    // 会走 sessionsDir + sessionId 标准 fallback,而不是用 stale 路径
    const messages = readSessionMessages(entry.sessionId, storePath, entry.sessionFile);

    // 序列化后 grep marker (messages 是 unknown[],各种 content 形态都接住)
    const serialized = JSON.stringify(messages);
    expect(serialized).toContain(NEW_MARKER);
    expect(serialized).not.toContain(OLD_MARKER);
  });

  test("Step 3 (sanity): if we manually pass stale sessionFile (pre-B1 behavior), readSessionMessages reads OLD_MARKER", () => {
    // 这一条不是 B1 的修复目标,而是"反向证明":确认 readSessionMessages 在 sessionFile
    // 字段存在且指向旧 jsonl 时确实会优先读旧文件 (验证 B1 删字段是必要的 — 不删的话 read
    // path 会持续命中旧 jsonl)。
    const messages = readSessionMessages(NEW_SESSION_ID, storePath, oldJsonlPath);
    const serialized = JSON.stringify(messages);
    expect(serialized).toContain(OLD_MARKER); // 旧 jsonl 命中
    expect(serialized).not.toContain(NEW_MARKER); // 新 jsonl 没被读
  });
});

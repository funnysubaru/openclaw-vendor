// Home isolation tests validate HOME and state directory isolation.
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createConfigIO } from "../src/config/config.js";
import { CONFIG_PATH, STATE_DIR } from "../src/config/paths.js";
import { resolveStateDir } from "../src/config/state-dir.js";
import { CONFIG_DIR } from "../src/utils.js";

describe("shared test setup home isolation", () => {
  it("routes default config IO through the per-worker temp home", () => {
    const testHome = process.env.OPENCLAW_TEST_HOME;
    if (!testHome) {
      throw new Error("OPENCLAW_TEST_HOME must be set by the test setup");
    }
    expect(process.env.HOME).toBe(testHome);
    expect(process.env.USERPROFILE).toBe(testHome);
    expect(createConfigIO().configPath).toBe(path.join(testHome, ".openclaw", "openclaw.json"));
  });

  it("keeps os.homedir() and explicit-env state dirs inside the per-worker temp home", () => {
    const testHome = process.env.OPENCLAW_TEST_HOME;
    if (!testHome) {
      throw new Error("OPENCLAW_TEST_HOME must be set by the test setup");
    }
    // threads 池里 os.homedir() 默认读进程级真实 HOME；调用方传入不含 HOME 的显式 env 时
    // resolveStateDir 会回退到它。这里锁住：回退结果必须仍在临时 home 内，绝不指向真实 ~/.openclaw。
    expect(os.homedir()).toBe(testHome);
    expect(resolveStateDir({} as NodeJS.ProcessEnv)).toBe(path.join(testHome, ".openclaw"));
  });

  it("re-pins import-time path constants to the per-worker temp home", () => {
    const testHome = process.env.OPENCLAW_TEST_HOME;
    if (!testHome) {
      throw new Error("OPENCLAW_TEST_HOME must be set by the test setup");
    }
    // 这些常量在模块 import 时就算好；setup 文件的 import 会被提升到 HOME 隔离之前执行，
    // worker 里第一个测试文件拿到的会是隔离前的 HOME（裸跑 vitest 时就是真实 ~/.openclaw）。
    // 单独跑本文件时它就是 worker 的第一个文件，正好覆盖这个时序。
    expect(STATE_DIR).toBe(path.join(testHome, ".openclaw"));
    expect(CONFIG_DIR).toBe(path.join(testHome, ".openclaw"));
    expect(CONFIG_PATH).toBe(path.join(testHome, ".openclaw", "openclaw.json"));
  });
});

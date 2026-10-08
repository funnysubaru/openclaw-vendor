// Home isolation tests validate HOME and state directory isolation.
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createConfigIO } from "../src/config/config.js";
import { resolveStateDir } from "../src/config/state-dir.js";

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
});

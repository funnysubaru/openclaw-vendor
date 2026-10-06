/** Runtime-config publication coverage loaded by the startup plugin suite. */
import { afterEach, describe, expect, it } from "vitest";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  resetConfigRuntimeState,
  setAppliedRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { testing } from "./server-startup-bootstrap.js";

const { publishGatewayPluginRuntimeConfigAtStartup, buildStartupDatabaseSchemaPreflightOptions } =
  testing;

afterEach(() => {
  resetConfigRuntimeState();
});

describe("Gateway startup runtime config publication", () => {
  it("replaces the pre-activation snapshot with the exact plugin runtime config", () => {
    const sourceConfig = {
      agents: { defaults: { model: "openai/gpt-5.2" } },
    } as OpenClawConfig;
    const preActivationConfig = structuredClone(sourceConfig);
    const pluginRuntimeConfig = {
      ...preActivationConfig,
      plugins: {
        entries: {
          openai: { enabled: true },
        },
      },
    } as OpenClawConfig;
    setAppliedRuntimeConfigSnapshot(preActivationConfig, sourceConfig);

    publishGatewayPluginRuntimeConfigAtStartup({
      runtimeConfig: pluginRuntimeConfig,
      sourceConfig,
    });

    expect(getRuntimeConfigSnapshot()).toBe(pluginRuntimeConfig);
    expect(getRuntimeConfigSourceSnapshot()).toBe(sourceConfig);
  });
});

describe("ADR-0033 任务84(a): state.schema-preflight 只查全局状态库", () => {
  it("把 scope 固定为 state，不重复查员工库", () => {
    const signal = new AbortController().signal;
    const env = { FAKE: "1" } as unknown as NodeJS.ProcessEnv;

    const options = buildStartupDatabaseSchemaPreflightOptions({
      signal,
      env,
      stateSchemaVersion: 7,
      agentSchemaVersion: 3,
    });

    // 这是本次改动的核心断言：去掉 `scope: "state"` 或把它改成别的值，这条测试就会红。
    expect(options.scope).toBe("state");
    expect(options.signal).toBe(signal);
    expect(options.env).toBe(env);
    expect(options.supportedVersions).toEqual({ state: 7, agent: 3 });
  });

  it("signal 缺省时透传 undefined，不强塞一个假 signal", () => {
    const options = buildStartupDatabaseSchemaPreflightOptions({
      env: {} as NodeJS.ProcessEnv,
      stateSchemaVersion: 1,
      agentSchemaVersion: 1,
    });

    expect(options.signal).toBeUndefined();
    expect(options.scope).toBe("state");
  });
});

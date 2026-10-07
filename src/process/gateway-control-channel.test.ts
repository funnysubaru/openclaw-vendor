// Yuiclaw fork：Windows 优雅关闭控制通道的监听边界用例。
//   - fd 解析 / 自我重启 stdio 的唯一实现在根目录 node-runtime-recovery.mjs，边界矩阵在
//     src/infra/node-runtime-recovery.test.ts；这里只确认转出的是同一份实现。
//   - listenForGatewayControlShutdown 用真实 readline + PassThrough：fake readline 模拟不出
//     「input 报错 → Interface 再 emit 一次 error」这条转发链（2026-10-07 owner review）。
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import * as launcher from "../../node-runtime-recovery.mjs";
import {
  GATEWAY_CONTROL_FD_ENV,
  listenForGatewayControlShutdown,
  parseGatewayControlFd,
  resolveRespawnStdioWithControlFd,
} from "./gateway-control-channel.js";

const SENTINEL = "__openclaw_stdin_shutdown__";

const flush = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

describe("gateway control channel exports", () => {
  it("re-exports the launcher implementation instead of a copy", () => {
    expect(GATEWAY_CONTROL_FD_ENV).toBe("OPENCLAW_CONTROL_FD");
    expect(parseGatewayControlFd).toBe(launcher.parseGatewayControlFd);
    expect(resolveRespawnStdioWithControlFd).toBe(launcher.resolveLauncherRespawnStdio);
  });
});

describe("listenForGatewayControlShutdown", () => {
  it("fires onShutdown only for the sentinel line", async () => {
    const input = new PassThrough();
    const onShutdown = vi.fn();
    listenForGatewayControlShutdown({
      input,
      ownsInput: true,
      sentinel: SENTINEL,
      onShutdown,
      onError: vi.fn(),
    });
    input.write("hello\n");
    await flush();
    expect(onShutdown).not.toHaveBeenCalled();
    input.write(`  ${SENTINEL}  \n`);
    await flush();
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it("degrades on an input error instead of throwing an unhandled readline error", async () => {
    const input = new PassThrough();
    const onError = vi.fn();
    const onShutdown = vi.fn();
    listenForGatewayControlShutdown({
      input,
      ownsInput: true,
      sentinel: SENTINEL,
      onShutdown,
      onError,
    });
    // 真实 createInterface 会把 input 的 error 转发到 Interface；没人接时这里会以
    // Unhandled 'error' event 抛出，测试进程直接失败。
    input.emit("error", new Error("pipe broken"));
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(input.destroyed).toBe(true);
    // 拆掉之后再来的迟到错误也要被吞掉，不再重复记日志。
    input.emit("error", new Error("late"));
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onShutdown).not.toHaveBeenCalled();
  });

  it("does not destroy an input it does not own (legacy stdin)", () => {
    const input = new PassThrough();
    const { close } = listenForGatewayControlShutdown({
      input,
      ownsInput: false,
      sentinel: SENTINEL,
      onShutdown: vi.fn(),
      onError: vi.fn(),
    });
    close();
    close();
    expect(input.destroyed).toBe(false);
  });
});

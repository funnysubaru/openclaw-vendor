import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnWithFallbackMock, killProcessTreeMock, createWindowsStreamDecoderMock } = vi.hoisted(
  () => ({
    spawnWithFallbackMock: vi.fn(),
    killProcessTreeMock: vi.fn(),
    createWindowsStreamDecoderMock: vi.fn(),
  }),
);

vi.mock("../../spawn-utils.js", () => ({
  spawnWithFallback: spawnWithFallbackMock,
}));

vi.mock("../../kill-tree.js", () => ({
  killProcessTree: killProcessTreeMock,
}));

// Yuiclaw PR-B（R4/组件6）：mock 掉真实的 createWindowsStreamDecoder，只验证 child.ts
// 有没有正确"为 stdout/stderr 各建一个独立解码器实例、并把每个 chunk 交给对应解码器"，
// 不在这里重复测解码算法本身的正确性（那部分在 windows-encoding.test.ts 里独立覆盖）。
vi.mock("../../windows-encoding.js", () => ({
  createWindowsStreamDecoder: createWindowsStreamDecoderMock,
}));

let createChildAdapter: typeof import("./child.js").createChildAdapter;

function createStubChild(pid = 1234) {
  const child = new EventEmitter() as ChildProcess;
  child.stdin = new PassThrough() as ChildProcess["stdin"];
  child.stdout = new PassThrough() as ChildProcess["stdout"];
  child.stderr = new PassThrough() as ChildProcess["stderr"];
  Object.defineProperty(child, "pid", { value: pid, configurable: true });
  Object.defineProperty(child, "killed", { value: false, configurable: true, writable: true });
  const killMock = vi.fn(() => true);
  child.kill = killMock as ChildProcess["kill"];
  return { child, killMock };
}

async function createAdapterHarness(params?: {
  pid?: number;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
}) {
  const { child, killMock } = createStubChild(params?.pid);
  spawnWithFallbackMock.mockResolvedValue({
    child,
    usedFallback: false,
  });
  const adapter = await createChildAdapter({
    argv: params?.argv ?? ["node", "-e", "setTimeout(() => {}, 1000)"],
    env: params?.env,
    stdinMode: "pipe-open",
  });
  return { adapter, killMock, child };
}

describe("createChildAdapter", () => {
  const originalServiceMarker = process.env.OPENCLAW_SERVICE_MARKER;

  beforeAll(async () => {
    ({ createChildAdapter } = await import("./child.js"));
  });

  beforeEach(() => {
    spawnWithFallbackMock.mockClear();
    killProcessTreeMock.mockClear();
    delete process.env.OPENCLAW_SERVICE_MARKER;
    // 默认给一个"原样 toString + flush 恒空"的桩解码器（等价于改动前的
    // chunk.toString()，flush 无缓冲状态可吐），让不关心编码逻辑的既有用例
    // （kill/env 相关）继续按原语义跑；需要断言解码/flush 细节的用例会自己
    // 覆盖这个默认实现。createWindowsStreamDecoder 现在返回 {decode, flush}
    // 对象（PR-B review Minor#1/F1 后的接口），不再是裸函数。
    createWindowsStreamDecoderMock.mockReset();
    createWindowsStreamDecoderMock.mockImplementation(() => ({
      decode: (chunk: Buffer) => chunk.toString(),
      flush: () => "",
    }));
  });

  afterAll(() => {
    if (originalServiceMarker === undefined) {
      delete process.env.OPENCLAW_SERVICE_MARKER;
    } else {
      process.env.OPENCLAW_SERVICE_MARKER = originalServiceMarker;
    }
  });

  it("uses process-tree kill for default SIGKILL", async () => {
    const { adapter, killMock } = await createAdapterHarness({ pid: 4321 });

    const spawnArgs = spawnWithFallbackMock.mock.calls[0]?.[0] as {
      options?: { detached?: boolean };
      fallbacks?: Array<{ options?: { detached?: boolean } }>;
    };
    // On Windows, detached defaults to false (headless Scheduled Task compat);
    // on POSIX, detached is true with a no-detach fallback.
    if (process.platform === "win32") {
      expect(spawnArgs.options?.detached).toBe(false);
      expect(spawnArgs.fallbacks).toEqual([]);
    } else {
      expect(spawnArgs.options?.detached).toBe(true);
      expect(spawnArgs.fallbacks?.[0]?.options?.detached).toBe(false);
    }

    adapter.kill();

    expect(killProcessTreeMock).toHaveBeenCalledWith(4321);
    expect(killMock).not.toHaveBeenCalled();
  });

  it("uses direct child.kill for non-SIGKILL signals", async () => {
    const { adapter, killMock } = await createAdapterHarness({ pid: 7654 });

    adapter.kill("SIGTERM");

    expect(killProcessTreeMock).not.toHaveBeenCalled();
    expect(killMock).toHaveBeenCalledWith("SIGTERM");
  });

  it("disables detached mode in service-managed runtime", async () => {
    process.env.OPENCLAW_SERVICE_MARKER = "openclaw";

    await createAdapterHarness({ pid: 7777 });

    const spawnArgs = spawnWithFallbackMock.mock.calls[0]?.[0] as {
      options?: { detached?: boolean };
      fallbacks?: Array<{ options?: { detached?: boolean } }>;
    };
    expect(spawnArgs.options?.detached).toBe(false);
    expect(spawnArgs.fallbacks ?? []).toEqual([]);
  });

  it("keeps inherited env when no override env is provided", async () => {
    await createAdapterHarness({
      pid: 3333,
      argv: ["node", "-e", "process.exit(0)"],
    });

    const spawnArgs = spawnWithFallbackMock.mock.calls[0]?.[0] as {
      options?: { env?: NodeJS.ProcessEnv };
    };
    expect(spawnArgs.options?.env).toBeUndefined();
  });

  it("passes explicit env overrides as strings", async () => {
    await createAdapterHarness({
      pid: 4444,
      argv: ["node", "-e", "process.exit(0)"],
      env: { FOO: "bar", COUNT: "12", DROP_ME: undefined },
    });

    const spawnArgs = spawnWithFallbackMock.mock.calls[0]?.[0] as {
      options?: { env?: Record<string, string> };
    };
    expect(spawnArgs.options?.env).toEqual({ FOO: "bar", COUNT: "12" });
  });

  describe("Windows 代码页解码接线（R4/组件6）", () => {
    it("为 stdout / stderr 各建一个独立的流式解码器实例", async () => {
      await createAdapterHarness({ pid: 5555 });

      // 两条流各自独立 createWindowsStreamDecoder() 一次（不能共用一个实例，
      // 否则 stdout/stderr 交替到达时会互相污染对方缓存的"未完成字节"状态）。
      expect(createWindowsStreamDecoderMock).toHaveBeenCalledTimes(2);
    });

    it("stdout 的每个 chunk 都交给它专属的解码器，listener 收到解码后的结果", async () => {
      const stdoutDecode = vi.fn((chunk: Buffer) => `stdout:${chunk.toString()}`);
      const stderrDecode = vi.fn((chunk: Buffer) => `stderr:${chunk.toString()}`);
      createWindowsStreamDecoderMock
        .mockReset()
        .mockReturnValueOnce({ decode: stdoutDecode, flush: () => "" })
        .mockReturnValueOnce({ decode: stderrDecode, flush: () => "" });

      const { adapter, child } = await createAdapterHarness({ pid: 6666 });

      const receivedStdout: string[] = [];
      const receivedStderr: string[] = [];
      adapter.onStdout((chunk) => receivedStdout.push(chunk));
      adapter.onStderr((chunk) => receivedStderr.push(chunk));

      // createStubChild 用 PassThrough 实打实赋值给 child.stdout/stderr（见本文件顶部），
      // 只是 ChildProcess 类型本身把这两个字段声明成 `| null`；这里断言非空是安全的。
      child.stdout!.emit("data", Buffer.from("hello"));
      child.stderr!.emit("data", Buffer.from("world"));

      expect(stdoutDecode).toHaveBeenCalledWith(Buffer.from("hello"));
      expect(stderrDecode).toHaveBeenCalledWith(Buffer.from("world"));
      // stdout 的 chunk 绝不会被喂给 stderr 的解码器，反之亦然——两条流严格隔离。
      expect(stdoutDecode).not.toHaveBeenCalledWith(Buffer.from("world"));
      expect(stderrDecode).not.toHaveBeenCalledWith(Buffer.from("hello"));
      expect(receivedStdout).toEqual(["stdout:hello"]);
      expect(receivedStderr).toEqual(["stderr:world"]);
    });
  });

  describe("流结束时 flush 解码器残留字节（PR-B review Minor#1/F1）", () => {
    it("close 事件触发后，各自解码器的 flush() 非空结果会补投给对应 listener", async () => {
      const stdoutFlush = vi.fn(() => "尾");
      const stderrFlush = vi.fn(() => "");
      createWindowsStreamDecoderMock
        .mockReset()
        .mockReturnValueOnce({ decode: (chunk: Buffer) => chunk.toString(), flush: stdoutFlush })
        .mockReturnValueOnce({ decode: (chunk: Buffer) => chunk.toString(), flush: stderrFlush });

      const { adapter, child } = await createAdapterHarness({ pid: 8888 });

      const receivedStdout: string[] = [];
      const receivedStderr: string[] = [];
      adapter.onStdout((chunk) => receivedStdout.push(chunk));
      adapter.onStderr((chunk) => receivedStderr.push(chunk));

      // 模拟进程真正结束：触发 close 事件。
      child.emit("close", 0, null);

      // stdout 的 flush() 返回非空 "尾" → 必须补投给 listener；
      // stderr 的 flush() 返回空串 → 不应该触发一次空字符串的 listener 回调
      // （避免下游把"空字符串"误当成一条真实数据处理）。
      expect(stdoutFlush).toHaveBeenCalledTimes(1);
      expect(stderrFlush).toHaveBeenCalledTimes(1);
      expect(receivedStdout).toEqual(["尾"]);
      expect(receivedStderr).toEqual([]);
    });

    it("close 早于 onStdout 注册时不报错（listener 尚未挂上，flush 结果被安全丢弃而非崩溃）", async () => {
      createWindowsStreamDecoderMock
        .mockReset()
        .mockReturnValueOnce({ decode: (chunk: Buffer) => chunk.toString(), flush: () => "尾" })
        .mockReturnValueOnce({ decode: (chunk: Buffer) => chunk.toString(), flush: () => "" });

      const { child } = await createAdapterHarness({ pid: 1010 });

      // 故意不调用 adapter.onStdout(...)，直接触发 close——不应该抛错。
      expect(() => child.emit("close", 0, null)).not.toThrow();
    });
  });
});

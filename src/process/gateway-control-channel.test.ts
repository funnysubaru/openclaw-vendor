// Yuiclaw fork：Windows 优雅关闭控制管道的边界用例。
//   - fd 解析：0-2 是标准流必须拒绝（否则回到 stdin 方案的子进程继承卡死问题），其它非整数 /
//     非法值一律视为未开启；
//   - 自我重启外壳的 stdio：有可用控制 fd 才转传到里层同一 fd 号，否则保持上游的 "inherit"
//     并删掉里层 env，绝不能让转传失败拖垮 gateway 启动。
import { describe, expect, it } from "vitest";
import {
  parseGatewayControlFd,
  resolveRespawnStdioWithControlFd,
} from "./gateway-control-channel.js";

describe("parseGatewayControlFd", () => {
  it("accepts integers from 3 upward", () => {
    expect(parseGatewayControlFd("3")).toBe(3);
    expect(parseGatewayControlFd(" 4 ")).toBe(4);
  });

  it.each([undefined, "", "0", "1", "2", "-3", "3.5", "abc", "3abc", "1e3"])(
    "rejects %j",
    (value) => {
      expect(parseGatewayControlFd(value)).toBeUndefined();
    },
  );
});

describe("resolveRespawnStdioWithControlFd", () => {
  it("keeps upstream inherit behavior when no control fd is configured", () => {
    const env = { A: "1" };
    const result = resolveRespawnStdioWithControlFd(env, () => true);
    expect(result.stdio).toBe("inherit");
    expect(result.env).toBe(env);
  });

  it("forwards an open control fd to the same fd number in the child", () => {
    const env = { OPENCLAW_CONTROL_FD: "3", A: "1" };
    const result = resolveRespawnStdioWithControlFd(env, (fd) => fd === 3);
    expect(result.stdio).toEqual(["inherit", "inherit", "inherit", 3]);
    expect(result.env).toEqual({ OPENCLAW_CONTROL_FD: "3", A: "1" });
  });

  it("pads gaps with ignore for higher fd numbers", () => {
    const result = resolveRespawnStdioWithControlFd({ OPENCLAW_CONTROL_FD: "5" }, () => true);
    expect(result.stdio).toEqual(["inherit", "inherit", "inherit", "ignore", "ignore", 5]);
  });

  it("drops the env var when the wrapper does not hold the fd", () => {
    const result = resolveRespawnStdioWithControlFd(
      { OPENCLAW_CONTROL_FD: "3", A: "1" },
      () => false,
    );
    expect(result.stdio).toBe("inherit");
    expect(result.env).toEqual({ A: "1" });
  });

  it.each(["0", "2", "abc"])("drops invalid control fd %j without probing", (value) => {
    let probed = false;
    const result = resolveRespawnStdioWithControlFd({ OPENCLAW_CONTROL_FD: value }, () => {
      probed = true;
      return true;
    });
    expect(probed).toBe(false);
    expect(result.stdio).toBe("inherit");
    expect(result.env).toEqual({});
  });
});

import { describe, expect, it } from "vitest";
import {
  createWindowsStreamDecoder,
  decodeCapturedOutputBuffer,
  parseWindowsCodePage,
} from "./windows-encoding.js";

// 判断当前跑测试的机器（Node 版本 / ICU 数据）是否支持 gbk TextDecoder——
// 全量 ICU 才带非 UTF 家族的遗留编码，某些精简构建可能不支持，测试要能优雅降级
// 而不是在这类环境下误报失败（沿用 invoke.sanitize-env.test.ts 已有的判定写法）。
function detectGbkSupport(): boolean {
  try {
    void new TextDecoder("gbk");
    return true;
  } catch {
    return false;
  }
}

describe("parseWindowsCodePage", () => {
  it("从英文 chcp 输出解析代码页", () => {
    expect(parseWindowsCodePage("Active code page: 936")).toBe(936);
  });

  it("从中文 chcp 输出解析代码页", () => {
    expect(parseWindowsCodePage("活动代码页: 65001")).toBe(65001);
  });

  it("解析不到数字时返回 null", () => {
    expect(parseWindowsCodePage("no code page")).toBeNull();
  });

  it("空字符串返回 null", () => {
    expect(parseWindowsCodePage("")).toBeNull();
  });
});

describe("decodeCapturedOutputBuffer（整段 buffer 一次性解码，node-host 用法）", () => {
  const gbkSupported = detectGbkSupport();

  it("非 win32 平台直接当 UTF-8，不做任何转换", () => {
    const buffer = Buffer.from("测试 unicode", "utf8");
    const decoded = decodeCapturedOutputBuffer({
      buffer,
      platform: "darwin",
      windowsEncoding: "gbk", // 即便传了 windowsEncoding，非 win32 也应早返回、忽略它
    });
    expect(decoded).toBe("测试 unicode");
  });

  it("win32 + 代码页是 UTF-8 时直接当 UTF-8", () => {
    const buffer = Buffer.from("hello", "utf8");
    const decoded = decodeCapturedOutputBuffer({
      buffer,
      platform: "win32",
      windowsEncoding: "utf-8",
    });
    expect(decoded).toBe("hello");
  });

  it("win32 + GBK 代码页时按 GBK 正确解码中文", () => {
    // "测试～；" 的 GBK 字节序列（与 invoke.sanitize-env.test.ts 历史用例保持一致的测试向量）。
    const raw = Buffer.from([0xb2, 0xe2, 0xca, 0xd4, 0xa1, 0xab, 0xa3, 0xbb]);
    const decoded = decodeCapturedOutputBuffer({
      buffer: raw,
      platform: "win32",
      windowsEncoding: "gbk",
    });
    if (!gbkSupported) {
      expect(decoded).toContain("�");
      return;
    }
    expect(decoded).toBe("测试～；");
  });

  it("代码页探测不到（null）时退回 UTF-8", () => {
    const buffer = Buffer.from("plain ascii", "utf8");
    const decoded = decodeCapturedOutputBuffer({
      buffer,
      platform: "win32",
      windowsEncoding: null,
    });
    expect(decoded).toBe("plain ascii");
  });

  it("不受支持的 encoding label 兜底回退 UTF-8，不抛错", () => {
    const buffer = Buffer.from("fallback", "utf8");
    const decoded = decodeCapturedOutputBuffer({
      buffer,
      platform: "win32",
      windowsEncoding: "not-a-real-encoding",
    });
    expect(decoded).toBe("fallback");
  });
});

describe("createWindowsStreamDecoder（B2.4 风险处置：流式 chunk 解码，supervisor adapter 用法）", () => {
  const gbkSupported = detectGbkSupport();

  it("非 win32：每个 chunk 独立走 UTF-8 toString，无状态", () => {
    const decode = createWindowsStreamDecoder({ platform: "darwin" });
    expect(decode(Buffer.from("第一段", "utf8"))).toBe("第一段");
    expect(decode(Buffer.from("第二段", "utf8"))).toBe("第二段");
  });

  it('win32 + UTF-8 代码页：等价于 chunk.toString("utf8")', () => {
    const decode = createWindowsStreamDecoder({ platform: "win32", windowsEncoding: "utf-8" });
    expect(decode(Buffer.from("hello", "utf8"))).toBe("hello");
  });

  it("win32 + GBK：完整 chunk（未跨边界）能正确解出中文", () => {
    if (!gbkSupported) {
      return;
    }
    const decode = createWindowsStreamDecoder({ platform: "win32", windowsEncoding: "gbk" });
    // "测试" 的 GBK 字节
    const chunk = Buffer.from([0xb2, 0xe2, 0xca, 0xd4]);
    expect(decode(chunk)).toBe("测试");
  });

  it("核心场景：GBK 双字节字符被切在两个 chunk 边界之间时仍能正确拼出（不产出半个字符的替换符）", () => {
    if (!gbkSupported) {
      return;
    }
    // "测试" 的 GBK 字节 [0xb2, 0xe2, 0xca, 0xd4]，故意从中间切成两段模拟
    // Node 流式 pipe 把一个字符切在两个 data 事件之间的真实场景。
    const decode = createWindowsStreamDecoder({ platform: "win32", windowsEncoding: "gbk" });
    const firstHalf = decode(Buffer.from([0xb2])); // "测" 字的第一个字节，尚不构成完整字符
    const secondHalf = decode(Buffer.from([0xe2, 0xca, 0xd4])); // 续上后半段 + "试" 的完整字节

    // 流式解码：前半段单独喂时不应产出错误的替换符（应为空——字节不完整，解码器持有状态等续传）。
    expect(firstHalf).toBe("");
    // 后续 chunk 到达后，解码器拼接前面缓存的字节，正确解出完整的"测试"，而非乱码/替换符。
    expect(secondHalf).toBe("测试");
  });

  it("若目标机器不支持该 encoding（如精简 ICU），兜底回退 chunk.toString，不抛错", () => {
    const decode = createWindowsStreamDecoder({
      platform: "win32",
      windowsEncoding: "not-a-real-encoding",
    });
    expect(decode(Buffer.from("fallback", "utf8"))).toBe("fallback");
  });

  it("两个独立实例互不干扰（模拟 stdout/stderr 各自持有状态）", () => {
    if (!gbkSupported) {
      return;
    }
    const decodeA = createWindowsStreamDecoder({ platform: "win32", windowsEncoding: "gbk" });
    const decodeB = createWindowsStreamDecoder({ platform: "win32", windowsEncoding: "gbk" });

    // A 只喂半个字符（缓存悬空字节），B 完整喂一个不相关的字符——两者应互不影响。
    decodeA(Buffer.from([0xb2]));
    expect(decodeB(Buffer.from([0xb2, 0xe2, 0xca, 0xd4]))).toBe("测试");
    // A 补齐后应该还能正确拼出自己缓存的那半个字符，不受 B 的调用干扰。
    expect(decodeA(Buffer.from([0xe2]))).toBe("测");
  });
});

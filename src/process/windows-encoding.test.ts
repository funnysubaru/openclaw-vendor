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

  // Yuiclaw 补丁（Windows 兼容性修复 Fix B）回归护栏：真实观测到的 bug 是子进程
  // （如 ppt-master 的 run_engine.py，用 configure_utf8_stdio() 强制 UTF-8 输出）
  // 与本模块"按控制台代码页解码"的假设互相打架——控制台代码页探测到 936（简体
  // 中文 GBK），但子进程实际写出的字节是合法 UTF-8，若仍按 GBK 解码会把中文
  // 「确认页已启动…」解成乱码「纭椤靛凡鍚姩…」。这条测试锁死修复后的正确行为：
  // UTF-8 字节即使在 windowsEncoding=gbk 下也应该被优先识别、正确解出。
  it("Fix B 回归护栏：UTF-8 字节 + 代码页=gbk(936) 时优先按 UTF-8 正确解出中文", () => {
    const text = "确认页已启动…";
    const buffer = Buffer.from(text, "utf8");
    const decoded = decodeCapturedOutputBuffer({
      buffer,
      platform: "win32",
      windowsEncoding: "gbk",
    });
    expect(decoded).toBe(text);
  });

  it("真 GBK 字节 + 代码页=gbk(936) 时仍按 GBK 正确解码（UTF-8 优先探测不应误伤真代码页数据）", () => {
    // "测试～；" 的 GBK 字节序列，与上面已有用例保持一致的测试向量——这些字节
    // 本身不构成合法 UTF-8（0xb2 不是任何合法 UTF-8 序列的首字节），所以 Fix B
    // 的 UTF-8 优先探测不会误判，仍然落到原有的 GBK 解码路径。
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

  // code review Important#3 回应：looksLikeUtf8 的启发式（"能被严格 UTF-8 解码器
  // 完整接受"）不是万无一失的——理论上存在一小撮 GBK 字节序列，恰好也构成合法
  // UTF-8，会被误判。这条测试用一个**真实构造出来的碰撞向量**把这个已知、已在
  // 代码注释里承认的风险钉成可复现的回归测试：字节 [0xC2, 0xA9] 作为 GBK 解码是
  // "漏"（U+6F0F），作为严格 UTF-8 解码是"©"（U+00A9）——两种解读都不报错，是一次
  // 真实的编码碰撞，不是编造的极端值。
  //
  // 这条测试的意义**不是要修掉这个碰撞**（本设计从一开始就接受这个取舍，见
  // decodeCapturedOutputBuffer 顶部模块注释），而是把"当前接受的误判行为"钉死成
  // 显式断言——如果未来有人重构 looksLikeUtf8 的判定逻辑（比如加长度阈值、换判定
  // 算法）意外改变了这个碰撞场景的结果，这条测试会失败，逼着改动者明确意识到
  // "这个已知取舍被动了"，而不是悄悄地行为漂移。
  it("Important#3 回归护栏：已知的 UTF-8/GBK 碰撞向量——记录当前接受的误判行为，不是要修掉它", () => {
    const collidingBytes = Buffer.from([0xc2, 0xa9]);
    const decoded = decodeCapturedOutputBuffer({
      buffer: collidingBytes,
      platform: "win32",
      windowsEncoding: "gbk",
    });
    // 当前设计：UTF-8 优先，这两个字节被解成 "©"，而不是 GBK 语境下"正确"的
    // "漏"。这是已接受的启发式局限，不是本 PR 要修的 bug。
    expect(decoded).toBe("©");
  });

  it("纯 ASCII 内容不受 Fix B 的 UTF-8 探测影响（无非 ASCII 字节，跳过判定直接走原逻辑）", () => {
    const buffer = Buffer.from("plain ascii output", "utf8");
    const decoded = decodeCapturedOutputBuffer({
      buffer,
      platform: "win32",
      windowsEncoding: "gbk",
    });
    expect(decoded).toBe("plain ascii output");
  });

  it("非 win32 平台不受 Fix B 影响（早返回逻辑不变）", () => {
    const text = "确认页已启动…";
    const buffer = Buffer.from(text, "utf8");
    const decoded = decodeCapturedOutputBuffer({
      buffer,
      platform: "darwin",
      windowsEncoding: "gbk",
    });
    expect(decoded).toBe(text);
  });
});

describe("createWindowsStreamDecoder（B2.4 风险处置：流式 chunk 解码，supervisor adapter 用法）", () => {
  const gbkSupported = detectGbkSupport();

  it("非 win32：每个 chunk 独立走 UTF-8 toString，无状态", () => {
    const decoder = createWindowsStreamDecoder({ platform: "darwin" });
    expect(decoder.decode(Buffer.from("第一段", "utf8"))).toBe("第一段");
    expect(decoder.decode(Buffer.from("第二段", "utf8"))).toBe("第二段");
  });

  it('win32 + UTF-8 代码页：等价于 chunk.toString("utf8")', () => {
    const decoder = createWindowsStreamDecoder({ platform: "win32", windowsEncoding: "utf-8" });
    expect(decoder.decode(Buffer.from("hello", "utf8"))).toBe("hello");
  });

  it("win32 + GBK：完整 chunk（未跨边界）能正确解出中文", () => {
    if (!gbkSupported) {
      return;
    }
    const decoder = createWindowsStreamDecoder({ platform: "win32", windowsEncoding: "gbk" });
    // "测试" 的 GBK 字节
    const chunk = Buffer.from([0xb2, 0xe2, 0xca, 0xd4]);
    expect(decoder.decode(chunk)).toBe("测试");
  });

  it("核心场景：GBK 双字节字符被切在两个 chunk 边界之间时仍能正确拼出（不产出半个字符的替换符）", () => {
    if (!gbkSupported) {
      return;
    }
    // "测试" 的 GBK 字节 [0xb2, 0xe2, 0xca, 0xd4]，故意从中间切成两段模拟
    // Node 流式 pipe 把一个字符切在两个 data 事件之间的真实场景。
    const decoder = createWindowsStreamDecoder({ platform: "win32", windowsEncoding: "gbk" });
    const firstHalf = decoder.decode(Buffer.from([0xb2])); // "测" 字的第一个字节，尚不构成完整字符
    const secondHalf = decoder.decode(Buffer.from([0xe2, 0xca, 0xd4])); // 续上后半段 + "试" 的完整字节

    // 流式解码：前半段单独喂时不应产出错误的替换符（应为空——字节不完整，解码器持有状态等续传）。
    expect(firstHalf).toBe("");
    // 后续 chunk 到达后，解码器拼接前面缓存的字节，正确解出完整的"测试"，而非乱码/替换符。
    expect(secondHalf).toBe("测试");
  });

  it("若目标机器不支持该 encoding（如精简 ICU），兜底回退 chunk.toString，不抛错", () => {
    const decoder = createWindowsStreamDecoder({
      platform: "win32",
      windowsEncoding: "not-a-real-encoding",
    });
    expect(decoder.decode(Buffer.from("fallback", "utf8"))).toBe("fallback");
  });

  it("两个独立实例互不干扰（模拟 stdout/stderr 各自持有状态）", () => {
    if (!gbkSupported) {
      return;
    }
    const decoderA = createWindowsStreamDecoder({ platform: "win32", windowsEncoding: "gbk" });
    const decoderB = createWindowsStreamDecoder({ platform: "win32", windowsEncoding: "gbk" });

    // A 只喂半个字符（缓存悬空字节），B 完整喂一个不相关的字符——两者应互不影响。
    decoderA.decode(Buffer.from([0xb2]));
    expect(decoderB.decode(Buffer.from([0xb2, 0xe2, 0xca, 0xd4]))).toBe("测试");
    // A 补齐后应该还能正确拼出自己缓存的那半个字符，不受 B 的调用干扰。
    expect(decoderA.decode(Buffer.from([0xe2]))).toBe("测");
  });

  // Yuiclaw 补丁（Windows 兼容性修复 Fix B，流式路径）：与 decodeCapturedOutputBuffer
  // 同源的回归护栏——子进程可能已经强制 UTF-8 输出，代码页=gbk 时不应该把合法的
  // UTF-8 字节误判/误解成 GBK。
  describe("Fix B：UTF-8 优先探测（子进程实际输出 UTF-8，但控制台代码页探测到 gbk）", () => {
    it("单个 chunk 内的合法 UTF-8 字节，即使代码页=gbk 也应优先判定为 UTF-8 并正确解出", () => {
      const decoder = createWindowsStreamDecoder({ platform: "win32", windowsEncoding: "gbk" });
      const chunk = Buffer.from("确认页已启动", "utf8");
      expect(decoder.decode(chunk)).toBe("确认页已启动");
    });

    it("UTF-8 多字节字符被切在两个 chunk 边界之间，仍能正确拼出（不被误判成 GBK 半字节）", () => {
      const decoder = createWindowsStreamDecoder({ platform: "win32", windowsEncoding: "gbk" });
      // "测试" 的 UTF-8 字节：e6 b5 8b (测) e8 af 95 (试)，共 6 字节。
      const full = Buffer.from("测试", "utf8");
      const firstChunk = full.subarray(0, 2); // e6 b5 —— "测" 字前两个字节，尚不构成完整字符
      const secondChunk = full.subarray(2); // 8b e8 af 95 —— 续上 "测" 的尾字节 + 完整的 "试"

      const firstOut = decoder.decode(firstChunk);
      const secondOut = decoder.decode(secondChunk);

      // 字节不完整：探测器与真实解码器都应该只是缓存、不产出乱码/替换符。
      expect(firstOut).toBe("");
      expect(secondOut).toBe("测试");
    });

    it("先收到纯 ASCII chunk，后续 chunk 才出现 UTF-8 非 ASCII 字节，仍应正确判定为 UTF-8（unresolved 状态跨多个 chunk 保持）", () => {
      const decoder = createWindowsStreamDecoder({ platform: "win32", windowsEncoding: "gbk" });
      // 纯 ASCII：无判别信号，resolvedMode 应仍停留在 unresolved，但输出已经正确。
      expect(decoder.decode(Buffer.from("loading", "utf8"))).toBe("loading");
      // 出现非 ASCII 字节且严格 UTF-8 校验通过：判定为 UTF-8，正确解出中文。
      expect(decoder.decode(Buffer.from("完成", "utf8"))).toBe("完成");
    });

    it("真 GBK 字节仍按 GBK 正确解码，不被 UTF-8 优先探测误伤", () => {
      if (!gbkSupported) {
        return;
      }
      const decoder = createWindowsStreamDecoder({ platform: "win32", windowsEncoding: "gbk" });
      // "测试" 的 GBK 字节——0xb2 不是任何合法 UTF-8 序列的首字节，探测必然失败，
      // 正确落到 GBK 分支（与既有测试 "win32 + GBK：完整 chunk" 断言一致）。
      const chunk = Buffer.from([0xb2, 0xe2, 0xca, 0xd4]);
      expect(decoder.decode(chunk)).toBe("测试");
    });

    // code review Important#3 回应：与 decodeCapturedOutputBuffer 同源的已知碰撞
    // 向量（字节 [0xC2, 0xA9]：GBK 解读是"漏"，严格 UTF-8 解读是"©"，两种解读都
    // 不报错）。流式路径同样接受这个取舍——记录当前行为，不是要修掉它。
    it("Important#3 回归护栏：已知的 UTF-8/GBK 碰撞向量在流式路径下的行为", () => {
      const decoder = createWindowsStreamDecoder({ platform: "win32", windowsEncoding: "gbk" });
      const collidingBytes = Buffer.from([0xc2, 0xa9]);
      expect(decoder.decode(collidingBytes)).toBe("©");
    });

    // code review Minor#3 回应：三态机的"未判定→已判定 UTF-8"是单向、不可逆的
    // deliberate trade-off（见 createWindowsStreamDecoder 函数级注释"判定之后
    // ……不再重新判断"）——一旦某个 chunk 含非 ASCII 字节且通过严格 UTF-8 校验，
    // 后续所有 chunk 都会被当作 UTF-8 处理，即使后面来的其实是货真价实的 GBK
    // 字节，也不会被重新识别、切回 GBK 解码。
    //
    // code review Minor#4 回应：这条测试同时覆盖"先 UTF-8 中文、后 GBK"混合流的
    // 已知限制——不是要修掉它（真实场景里同一个子进程中途切换输出编码本身就
    // 极其反常，不值得为此增加状态机复杂度），而是把这个限制用可复现的断言钉
    // 下来，防止未来有人在不知情的情况下改变这个行为。
    it("Minor#3/#4：一旦提交为 UTF-8 就不可反悔——先 UTF-8 中文、后真 GBK 字节的混合流会把 GBK 部分解花（已知限制，非本 PR 待修 bug）", () => {
      if (!gbkSupported) {
        return;
      }
      const decoder = createWindowsStreamDecoder({ platform: "win32", windowsEncoding: "gbk" });
      // 第一个 chunk：合法 UTF-8 中文，触发提交为 "utf8" 模式。
      expect(decoder.decode(Buffer.from("完成", "utf8"))).toBe("完成");
      // 第二个 chunk：货真价实的 GBK 字节（"测试"），但解码器已经提交为 UTF-8，
      // 不会重新判定——非 fatal 的 UTF-8 解码器会把这些字节当无效序列，
      // 逐字节吐出 U+FFFD 替换符，而不是正确的 "测试"。这是已知、已接受的限制。
      const mangled = decoder.decode(Buffer.from([0xb2, 0xe2, 0xca, 0xd4]));
      expect(mangled).not.toBe("测试");
      expect(mangled).toContain("�");
    });

    // 对应修复过程中发现的真实设计缺陷（不是假设性风险）：如果直接复用 fatal:true
    // 的探测器本身作为"判定为 UTF-8 之后"的正式解码器，flush() 在真正被截断的
    // UTF-8 尾部字节上会直接抛错、被外层 try/catch 吞掉变成空字符串——而不是像
    // GBK 分支那样吐出 U+FFFD 替换符，破坏了 F1 既定的 flush() 契约（"截断的尾部
    // 字符必须被替换成 U+FFFD 吐出，不能静默丢弃"）。这条测试锁死正确行为：
    // UTF-8 分支的 flush() 语义必须和 GBK 分支对称——非 fatal、吐替换符、不抛错。
    it("flush() 契约对称性：UTF-8 字符被截断在流末尾时，flush() 吐出 U+FFFD 而非静默丢弃/抛错", () => {
      const decoder = createWindowsStreamDecoder({ platform: "win32", windowsEncoding: "gbk" });
      const full = Buffer.from("测", "utf8"); // e6 b5 8b，3 字节
      const truncated = full.subarray(0, 2); // e6 b5 —— 只喂前两个字节，模拟进程被 SIGKILL

      const midStream = decoder.decode(truncated);
      expect(midStream).toBe(""); // 尚不完整，无输出

      const tail = decoder.flush();
      expect(tail.length).toBeGreaterThan(0);
      expect(tail).toContain("�");
    });

    it("flush() 契约对称性：完整的 UTF-8 字符流（没有被截断），flush() 返回空字符串", () => {
      const decoder = createWindowsStreamDecoder({ platform: "win32", windowsEncoding: "gbk" });
      expect(decoder.decode(Buffer.from("完成", "utf8"))).toBe("完成");
      expect(decoder.flush()).toBe("");
    });
  });

  // PR-B review Minor#1（F1）：流结束时 flush 残留字节，避免进程被杀/管道意外关闭
  // 场景下截断在缓冲区末尾的最后半个多字节字符被静默丢弃。
  describe("flush()（F1：流结束时吐出残留的未完成字节）", () => {
    it("核心场景：GBK 字符被截断在流末尾（进程被杀/管道意外关闭），flush() 前 decode 不出字符，flush() 后吐出该字符", () => {
      if (!gbkSupported) {
        return;
      }
      const decoder = createWindowsStreamDecoder({ platform: "win32", windowsEncoding: "gbk" });
      // "测" 字 GBK 两字节 [0xb2, 0xe2]，只喂第一个字节就模拟流结束（如进程被 SIGKILL）。
      const midStream = decoder.decode(Buffer.from([0xb2]));
      expect(midStream).toBe("");

      // flush() 之前不该凭空吐出任何东西——上面已经断言过 decode() 本身为空。
      // 调用 flush() 后，WHATWG Encoding 规范要求把这个不完整序列替换成 U+FFFD 吐出，
      // 而不是永远悬空、被静默丢弃。
      const tail = decoder.flush();
      expect(tail.length).toBeGreaterThan(0);
      expect(tail).toContain("�");
    });

    it("完整字符流（没有被截断）：flush() 返回空字符串，不会凭空多吐字符", () => {
      if (!gbkSupported) {
        return;
      }
      const decoder = createWindowsStreamDecoder({ platform: "win32", windowsEncoding: "gbk" });
      expect(decoder.decode(Buffer.from([0xb2, 0xe2, 0xca, 0xd4]))).toBe("测试");
      // 已经是完整字符，解码器内部没有残留的未完成字节，flush 应为空。
      expect(decoder.flush()).toBe("");
    });

    it("非 win32 / UTF-8 代码页路径：flush() 恒返回空字符串（没有跨 chunk 状态可 flush）", () => {
      const nonWin = createWindowsStreamDecoder({ platform: "darwin" });
      nonWin.decode(Buffer.from("任意内容", "utf8"));
      expect(nonWin.flush()).toBe("");

      const utf8OnWin = createWindowsStreamDecoder({ platform: "win32", windowsEncoding: "utf-8" });
      utf8OnWin.decode(Buffer.from("任意内容", "utf8"));
      expect(utf8OnWin.flush()).toBe("");
    });

    it("重复调用 flush() 是安全的，第二次不会重复吐出同一段残留字节", () => {
      if (!gbkSupported) {
        return;
      }
      const decoder = createWindowsStreamDecoder({ platform: "win32", windowsEncoding: "gbk" });
      decoder.decode(Buffer.from([0xb2])); // 留一个悬空字节
      const firstFlush = decoder.flush();
      expect(firstFlush.length).toBeGreaterThan(0);
      const secondFlush = decoder.flush();
      expect(secondFlush).toBe("");
    });
  });
});

/**
 * 静态源码不变量守卫：Anthropic 别名映射必须保持在函数体内（TDZ 防护）
 *
 * 背景：
 *   `normalizeAnthropicModelId` 的 Anthropic 别名对象（含 "sonnet-4.6": "claude-sonnet-4-6"
 *   等条目）原本是模块顶层的 `const ANTHROPIC_MODEL_ALIASES`。当 context.ts 在 import
 *   阶段做 eager warmup 时，bundler 的初始化顺序可能导致该 const 尚未初始化就被引用，
 *   从而抛出 TDZ ReferenceError（Temporal Dead Zone）。
 *
 *   修复方式：将别名对象移入函数体内，作为局部对象字面量，使其与模块初始化顺序无关。
 *
 *   本测试的目的：静态断言该不变量始终成立——别名映射只存在于函数体内，
 *   不出现在模块顶层——以便在有人将其"优化回"模块顶层 const 时立即报错。
 *   (运行时 smoke 无法可靠复现此 bug，因为它依赖 bundle 初始化顺序。)
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// 解析 model-selection.ts 的绝对路径（与测试文件同目录）
const sourceFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "model-selection.ts");

/**
 * 从完整源码中提取 `normalizeAnthropicModelId` 函数体文本。
 * 使用括号计数法定位函数的开始大括号到匹配的闭合大括号，
 * 足够精确地覆盖这个简单的非嵌套函数。
 *
 * 返回函数体文本（含首尾大括号），若未找到则返回 null。
 */
function extractFunctionBody(source: string, fnName: string): string | null {
  const fnStart = source.indexOf(`function ${fnName}`);
  if (fnStart === -1) {
    return null;
  }
  // 找到函数声明后第一个 `{`
  const openBrace = source.indexOf("{", fnStart);
  if (openBrace === -1) {
    return null;
  }
  let depth = 0;
  for (let i = openBrace; i < source.length; i++) {
    if (source[i] === "{") {
      depth++;
    } else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        // 返回从开括号到闭括号（含）的子字符串
        return source.slice(openBrace, i + 1);
      }
    }
  }
  return null;
}

describe("model-selection TDZ guard — Anthropic alias map must stay function-local", () => {
  const source = readFileSync(sourceFile, "utf8");

  it("source file contains the normalizeAnthropicModelId function", () => {
    expect(source).toContain("function normalizeAnthropicModelId");
  });

  it("alias sentinel literal appears inside the normalizeAnthropicModelId function body", () => {
    const body = extractFunctionBody(source, "normalizeAnthropicModelId");
    expect(body, "could not extract normalizeAnthropicModelId function body").not.toBeNull();

    // 用 "claude-sonnet-4-6" 作为别名映射的 sentinel — 这是 TDZ 修复后唯一应当
    // 存在于函数体内的 Anthropic canonical model ID。
    expect(body).toContain('"claude-sonnet-4-6"');
  });

  it("alias sentinel does NOT appear at module scope (outside the function body)", () => {
    // 原理：从源码中删去整个 normalizeAnthropicModelId 函数体后，
    // 剩余文本不应包含 "claude-sonnet-4-6"。
    // 若有人将别名对象移回模块顶层 const，删去函数体后它仍可见，测试即报红。
    const body = extractFunctionBody(source, "normalizeAnthropicModelId");
    expect(body, "could not extract normalizeAnthropicModelId function body").not.toBeNull();

    const sourceWithoutFnBody = source.replace(body as string, "/* REMOVED_FN_BODY */");

    expect(
      sourceWithoutFnBody,
      [
        '别名映射 sentinel "claude-sonnet-4-6" 出现在模块顶层（函数体之外）。',
        "这违反了 TDZ 守卫不变量：别名对象必须是函数局部变量，",
        "不能是模块顶层 const，否则在 bundle 初始化时可能触发 TDZ ReferenceError。",
      ].join(" "),
    ).not.toContain('"claude-sonnet-4-6"');
  });
});

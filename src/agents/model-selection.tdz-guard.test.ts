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
 *
 * ── 守卫的有效范围（刻意的、有限的作用域）────────────────────────────────
 *
 *   本守卫仅能检测以下具体情形：
 *     ✓ 别名映射被放回 model-selection.ts **同一文件**的模块顶层 `const`
 *
 *   以下情形本守卫 **无法** 检测：
 *     ✗ 别名表被提取到另一个模块的顶层 `const`（例如新建 `anthropic-aliases.ts`）——
 *       `extractFunctionBody` 只读取 model-selection.ts 一个文件
 *     ✗ 模块级 lazy getter / singleton 持有别名映射——TDZ 不变量在技术上仍满足，
 *       但守卫不关心这一点
 *     ✗ `normalizeAnthropicModelId` 被改写为箭头函数（`const normalizeAnthropicModelId = ...`）——
 *       `extractFunctionBody` 靠 `function <name>` 定位，箭头函数形式找不到，
 *       会返回 null 并让 "contains the function" 测试直接失败（相当于早期警报），
 *       但 "not at module scope" 测试的断言将在 null 路径上被跳过
 *
 *   这些限制是刻意接受的：本守卫只为最常见的"把 const 移回顶层"的手滑情形提供防护，
 *   不试图覆盖所有重构路径。如果 normalizeAnthropicModelId 将来被大幅重写，
 *   应同步更新本守卫的实现。
 * ────────────────────────────────────────────────────────────────────────────
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
 *
 * ── 脆弱性说明（已知限制，刻意接受）────────────────────────────────────
 *   括号计数法是朴素实现：它**不会跳过**字符串字面量或注释中的 `{` / `}` 字符。
 *   对于当前 `normalizeAnthropicModelId` 这个简单函数体（无复杂嵌套、无含括号的
 *   字符串字面量）来说精度足够。
 *   若将来函数体变复杂（深层嵌套对象、模板字面量中含括号等），括号计数可能提前
 *   或延迟结束，导致提取范围出错。届时应考虑换用 AST（如 TypeScript Compiler API
 *   或 tree-sitter）以获得更可靠的函数体定位。
 * ────────────────────────────────────────────────────────────────────────────
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

import { asRecord } from "@openclaw/normalization-core/record-coerce";
import type { Tool } from "../types.js";

// 回搬自上游 openclaw PR #191561（merge 7b0cfe35941f）的 google-tool-parameters.ts，逻辑逐字保留。
// Yuiclaw 改动只有两处：① 我们 pin 上的 normalization-core 还没有 isStringArray，下面本地补一个等价实现；
// ② 新增 isGeminiToolParameterAliasModel，让 OpenRouter 等走 openai-completions 的 Gemini 也复用这套别名
// （上游只接了 Google 原生传输层，见 ADR-0033 任务 150）。
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * openai-completions 传输层是否要对这个模型做保留字参数别名。
 * 判据只看模型 id 里有没有 "gemini"：直连 Google 的 OpenAI 兼容端点是 `gemini-2.5-flash`，
 * OpenRouter 是 `google/gemini-2.5-flash-lite`，两种写法都要命中。
 * 别名是可逆的（发出前改名、回包后还原），误命中非 Gemini 模型也不会改变工具语义，只是参数名多个下划线。
 */
export function isGeminiToolParameterAliasModel(modelId: string): boolean {
  return /gemini/i.test(modelId);
}

// Gemini 2.5 can emit MALFORMED_FUNCTION_CALL for Python keyword parameters.
// Only function parameters are renamed; nested objects are user data.
const PYTHON_KEYWORDS = new Set(
  (
    "False None True and as assert async await break class continue def del elif else except " +
    "finally for from global if import in is lambda nonlocal not or pass raise return try while with yield"
  ).split(" "),
);

function parameterNames(parameters: Record<string, unknown>): Map<string, string> {
  const properties = asRecord(parameters.properties);
  const names = new Map<string, string>();
  for (const name of Object.keys(properties)) {
    if (!PYTHON_KEYWORDS.has(name)) {
      continue;
    }
    let alias = `${name}_`;
    while (Object.hasOwn(properties, alias)) {
      alias += "_";
    }
    names.set(name, alias);
  }
  return names;
}

export function googleToolParameters(parameters: Tool["parameters"]): Record<string, unknown> {
  const schema = asRecord(parameters);
  const names = parameterNames(schema);
  if (names.size === 0) {
    return schema;
  }
  const projected: Record<string, unknown> = {
    ...schema,
    properties: Object.fromEntries(
      Object.entries(asRecord(schema.properties)).map(([name, propertySchema]) => [
        names.get(name) ?? name,
        propertySchema,
      ]),
    ),
  };
  for (const key of ["required", "propertyOrdering"] as const) {
    const value = schema[key];
    if (isStringArray(value)) {
      projected[key] = value.map((name) => names.get(name) ?? name);
    }
  }
  return projected;
}

export function mapGoogleToolArguments(
  tools: Tool[] | undefined,
  toolName: string,
  args: Record<string, unknown>,
  direction: "encode" | "decode",
): Record<string, unknown> {
  const tool = tools?.find((candidate) => candidate.name === toolName);
  if (!tool) {
    return args;
  }
  const names = parameterNames(asRecord(tool.parameters));
  if (names.size === 0) {
    return args;
  }
  const mapping =
    direction === "encode" ? names : new Map([...names].map(([name, alias]) => [alias, name]));
  return Object.fromEntries(
    Object.entries(args).map(([name, value]) => [mapping.get(name) ?? name, value]),
  );
}

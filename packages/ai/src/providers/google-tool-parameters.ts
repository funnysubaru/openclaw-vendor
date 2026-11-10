import { asRecord } from "@openclaw/normalization-core/record-coerce";

// 源自上游 openclaw PR #191561（merge 7b0cfe35941f）的 google-tool-parameters.ts：保留字清单、
// 别名规则（`name_`，撞名继续加 `_`）、「只改函数顶层参数、嵌套对象是用户数据不动」的边界都与上游一致。
//
// Yuiclaw 的差异（ADR-0033 任务 150，vendor PR #153 review）：
// - 上游只接了 Google 原生传输层；这里供 openai-completions（OpenRouter 的 google/gemini-* 等）使用。
// - 上游从原始 tool.parameters 的根 properties 算映射。completions 发出去的是投影 + 规范化后的 schema
//   （会展开根 $ref、把根 anyOf 合成 properties、读 toJSON 快照），原始对象和实际出站形态可能对不上。
//   所以这里改为：调用方在「最终出站 schema」上算一次映射，出站改名、历史编码、回包还原三处共用这一份。
// - 函数顶层字段除了根 properties，还包括根 allOf/anyOf/oneOf 分支里的 properties；避碰和改名都要算上，
//   否则 `in` 可能被改成分支里已有的 `in_`，两个参数压成一个、不能还原。

// Gemini 2.5 can emit MALFORMED_FUNCTION_CALL for Python keyword parameters.
// Only function parameters are renamed; nested objects are user data.
const PYTHON_KEYWORDS = new Set(
  (
    "False None True and as assert async await break class continue def del elif else except " +
    "finally for from global if import in is lambda nonlocal not or pass raise return try while with yield"
  ).split(" "),
);

const COMBINATOR_KEYS = ["allOf", "anyOf", "oneOf"] as const;

/** 原名 → 别名；空表示这个工具不用改名。 */
export type ToolParameterAliases = ReadonlyMap<string, string>;

/**
 * openai-completions 传输层是否要对这个模型做保留字参数别名。
 * 判据只看模型 id 里有没有 "gemini"：直连 Google 的 OpenAI 兼容端点是 `gemini-2.5-flash`，
 * OpenRouter 是 `google/gemini-2.5-flash-lite`，两种写法都要命中。
 * 别名是可逆的（发出前改名、回包后还原），误命中非 Gemini 模型也不会改变工具语义，只是参数名多个下划线。
 */
export function isGeminiToolParameterAliasModel(modelId: string): boolean {
  return /gemini/i.test(modelId);
}

/** 函数顶层的各个「对象层」：根本身 + 根上组合关键字（可多层嵌套组合）里的分支。 */
function topLevelObjectLayers(schema: Record<string, unknown>): Record<string, unknown>[] {
  const layers = [schema];
  for (const key of COMBINATOR_KEYS) {
    const branches = schema[key];
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        layers.push(...topLevelObjectLayers(asRecord(branch)));
      }
    }
  }
  return layers;
}

/** 在最终出站 schema 上算保留字参数的别名；所有顶层字段名都参与避碰。 */
export function resolveToolParameterAliases(schema: unknown): ToolParameterAliases {
  const layers = topLevelObjectLayers(asRecord(schema));
  const taken = new Set(layers.flatMap((layer) => Object.keys(asRecord(layer.properties))));
  const aliases = new Map<string, string>();
  for (const name of taken) {
    if (!PYTHON_KEYWORDS.has(name)) {
      continue;
    }
    let alias = `${name}_`;
    while (taken.has(alias)) {
      alias += "_";
    }
    taken.add(alias);
    aliases.set(name, alias);
  }
  return aliases;
}

function renameLayer(
  layer: Record<string, unknown>,
  aliases: ToolParameterAliases,
): Record<string, unknown> {
  const renamed: Record<string, unknown> = { ...layer };
  if (layer.properties && typeof layer.properties === "object") {
    renamed.properties = Object.fromEntries(
      Object.entries(asRecord(layer.properties)).map(([name, propertySchema]) => [
        aliases.get(name) ?? name,
        propertySchema,
      ]),
    );
  }
  for (const key of ["required", "propertyOrdering"] as const) {
    const value = layer[key];
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      renamed[key] = value.map((name: string) => aliases.get(name) ?? name);
    }
  }
  for (const key of COMBINATOR_KEYS) {
    const branches = layer[key];
    if (Array.isArray(branches)) {
      renamed[key] = branches.map((branch) =>
        branch && typeof branch === "object" && !Array.isArray(branch)
          ? renameLayer(branch as Record<string, unknown>, aliases)
          : branch,
      );
    }
  }
  return renamed;
}

/** 按别名改写函数顶层参数（根 + 组合分支），不改嵌套对象，也不改传入的原 schema。 */
export function applyToolParameterAliases<T>(schema: T, aliases: ToolParameterAliases): T {
  if (aliases.size === 0 || !schema || typeof schema !== "object" || Array.isArray(schema)) {
    return schema;
  }
  return renameLayer(schema as Record<string, unknown>, aliases) as T;
}

/** encode：原名 → 别名（历史 tool_call 重放）；decode：别名 → 原名（模型回包交给工具执行前）。 */
export function mapToolArgumentsWithAliases(
  aliases: ToolParameterAliases | undefined,
  args: Record<string, unknown>,
  direction: "encode" | "decode",
): Record<string, unknown> {
  if (!aliases || aliases.size === 0) {
    return args;
  }
  const mapping =
    direction === "encode"
      ? aliases
      : new Map([...aliases].map(([name, alias]) => [alias, name] as const));
  return Object.fromEntries(
    Object.entries(args).map(([name, value]) => [mapping.get(name) ?? name, value]),
  );
}

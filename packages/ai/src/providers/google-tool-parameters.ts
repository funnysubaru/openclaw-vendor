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

// 引用关键字：`$recursiveRef`/`$dynamicRef` 指回 `#` 同样是递归结构，要参与递归检测；
// 它们指向锚点或 `#`，不是 `#/properties/...` 指针，改写时会原样保留。
const REF_KEYWORDS = new Set(["$ref", "$recursiveRef", "$dynamicRef"]);

// 这些关键字的值是数据（字面量、示例），里面出现 `$ref` 键也不是 schema 引用，不改写。
const DATA_KEYWORDS = new Set(["const", "default", "enum", "example", "examples"]);

/**
 * 用外部数据（模型回包、工具 schema）里的键往对象上写值时一律走这里：建成自有数据属性。
 * 普通赋值 `obj[key] = v` 遇到合法字段名 `__proto__` 会触发继承的 setter，字段直接丢失（vendor PR #153 第五轮 review）。
 */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** 原名 → 别名；空表示这个工具不用改名。 */
export type ToolParameterAliases = ReadonlyMap<string, string>;

/**
 * openai-completions 传输层是否要对这个模型做保留字参数别名。
 * 判据只看模型 id 里有没有 "gemini"：直连 Google 的 OpenAI 兼容端点是 `gemini-2.5-flash`，
 * OpenRouter 是 `google/gemini-2.5-flash-lite`，两种写法都要命中。
 * 别名是可逆的（发出前改名、回包后还原），误命中非 Gemini 模型也不会改变工具语义，只是参数名多个下划线。
 * 局限：id 里不含 "gemini" 的 Gemini（自定义别名、代理改名）不会命中，仍按原名发送。
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

/**
 * schema 里有没有引用重新指回「函数顶层对象层」（`#`、`#/allOf/0` 这类递归结构）。
 * 有的话，嵌套数据也会套用改过名的顶层，而回包只还原顶层，嵌套层会留着别名交给工具，
 * 所以这种工具整体不做别名（vendor PR #153 第四轮自检）。
 */
function reentersTopLevel(schema: unknown): boolean {
  let reenters = false;
  mapSchemaRefs(schema, (ref) => {
    reenters ||= /^#(?:\/(?:allOf|anyOf|oneOf)\/\d+)*\/?$/.test(ref);
    return ref;
  });
  return reenters;
}

/** 在最终出站 schema 上算保留字参数的别名；所有顶层字段名都参与避碰。 */
export function resolveToolParameterAliases(schema: unknown): ToolParameterAliases {
  if (reentersTopLevel(schema)) {
    return new Map();
  }
  const layers = topLevelObjectLayers(asRecord(schema));
  // required / propertyOrdering 里出现的名字也算占用：只在 required 里出现的 `in_` 不能被拿来当 `in` 的别名。
  const taken = new Set<string>();
  for (const layer of layers) {
    for (const name of Object.keys(asRecord(layer.properties))) {
      taken.add(name);
    }
    for (const key of ["required", "propertyOrdering"] as const) {
      const names = layer[key];
      if (Array.isArray(names)) {
        for (const name of names) {
          if (typeof name === "string") {
            taken.add(name);
          }
        }
      }
    }
  }
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

// 范围：只改 properties / required / propertyOrdering 和组合分支。if/then/else、not、dependentRequired 里
// 提到的顶层字段名不跟着改（Gemini 函数声明基本不支持这些关键字）。
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

/**
 * 把指向「被改名的函数顶层参数」的本地 JSON Pointer 改成别名，其它引用原样返回。
 * 顶层参数所在位置是：根或根上组合分支（可多层）里的 `properties/<名字>`，与 topLevelObjectLayers 一致；
 * 嵌套对象里的同名字段是用户数据，指向它们的引用不动。
 */
function rewriteLocalRef(ref: string, aliases: ToolParameterAliases): string {
  if (!ref.startsWith("#/")) {
    return ref;
  }
  const tokens = ref
    .slice(2)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
  let i = 0;
  // 沿组合关键字 + 下标往下走，停在某个顶层对象层。
  while (
    (COMBINATOR_KEYS as readonly string[]).includes(tokens[i] ?? "") &&
    /^\d+$/.test(tokens[i + 1] ?? "")
  ) {
    i += 2;
  }
  const alias = tokens[i] === "properties" ? aliases.get(tokens[i + 1] ?? "") : undefined;
  if (alias === undefined) {
    return ref;
  }
  tokens[i + 1] = alias;
  return `#/${tokens.map((token) => token.replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

// 这些关键字的值是「名字 → 子 schema」表：表里的键是字段名，不是关键字。
const NAME_MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  // 草案 07：字段名 → 子 schema 或字段名数组。
  "dependencies",
]);

/**
 * 遍历整个 schema，对每个 `$ref` 字符串调用 mapRef；有改动的路径才复制，不改传入对象。
 * 改写引用和检测递归引用都走这里，保证两处对「哪里是引用、哪里是数据」的判断一致（vendor PR #153 第四轮 review）：
 * - 名字表（properties、$defs 等）里的键是字段名，字段可能就叫 `default`/`const`，照常往下遍历；
 * - schema 层上的 const/default/enum/examples 是字面数据，里面形如 `$ref` 的内容不是引用，跳过。
 */
function mapSchemaRefs(node: unknown, mapRef: (ref: string) => string, isNameMap = false): unknown {
  if (Array.isArray(node)) {
    const next = node.map((item) => mapSchemaRefs(item, mapRef));
    return next.some((item, index) => item !== node[index]) ? next : node;
  }
  if (!node || typeof node !== "object") {
    return node;
  }
  let copy: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(node)) {
    let next: unknown;
    if (isNameMap) {
      next = mapSchemaRefs(value, mapRef);
    } else if (REF_KEYWORDS.has(key) && typeof value === "string") {
      next = mapRef(value);
    } else if (DATA_KEYWORDS.has(key)) {
      next = value;
    } else {
      next = mapSchemaRefs(value, mapRef, NAME_MAP_KEYWORDS.has(key));
    }
    if (next !== value) {
      copy ??= { ...(node as Record<string, unknown>) };
      setOwn(copy, key, next);
    }
  }
  return copy ?? node;
}

/**
 * 按别名改写函数顶层参数（根 + 组合分支），不改嵌套对象，也不改传入的原 schema。
 * direct 路径不展开引用，所以同时改写指向被改名参数的本地 `$ref`（如 `#/properties/in` → `#/properties/in_`），
 * 否则引用会悬空（vendor PR #153 第三轮 review）。
 */
export function applyToolParameterAliases<T>(schema: T, aliases: ToolParameterAliases): T {
  if (aliases.size === 0 || !schema || typeof schema !== "object" || Array.isArray(schema)) {
    return schema;
  }
  return mapSchemaRefs(renameLayer(schema as Record<string, unknown>, aliases), (ref) =>
    rewriteLocalRef(ref, aliases),
  ) as T;
}

/** encode：原名 → 别名（历史 tool_call 重放）；decode：别名 → 原名（模型回包交给工具执行前）。 */
export function mapToolArgumentsWithAliases(
  aliases: ToolParameterAliases | undefined,
  args: Record<string, unknown>,
  direction: "encode" | "decode",
): Record<string, unknown> {
  // 历史里参数可能缺失或不是对象（如 undefined），这种情况原样返回，不让请求构建抛错。
  if (!aliases || aliases.size === 0 || !args || typeof args !== "object" || Array.isArray(args)) {
    return args;
  }
  const mapping =
    direction === "encode"
      ? aliases
      : new Map([...aliases].map(([name, alias]) => [alias, name] as const));
  // 映射来的键优先：回包里同时有 `in_`（schema 声明的）和 `in` 时，以 `in_` 的值为准，与键顺序无关。
  const mapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(args)) {
    const target = mapping.get(name);
    if (target !== undefined) {
      setOwn(mapped, target, value);
    } else if (!Object.hasOwn(mapped, name)) {
      setOwn(mapped, name, value);
    }
  }
  return mapped;
}

// 已确认的工具调用块 → 它的参数别名。传输层收尾还原时登记；runner 的「工具参数修复」包装器会拿原始
// delta 文本（里面是 `in_` 这类别名）重新解析并写回块上，写回前必须按这里还原，否则会把已还原的参数
// 覆盖回别名（vendor PR #153 自检发现）。按块对象登记，只影响确实改过名的块。
// 挂在 globalThis 上：传输层（相对路径）和 runner（@openclaw/ai/internal/openai）经两条导入路径用到这张表，
// 打包时若被拆成两份模块副本，各自 new 一张就查不到对方登记的别名。
const ALIAS_REGISTRY_KEY = Symbol.for("openclaw.toolCallArgumentAliasesByBlock");
const aliasRegistryHost = globalThis as {
  [ALIAS_REGISTRY_KEY]?: WeakMap<object, ToolParameterAliases>;
};
const toolCallArgumentAliasesByBlock = (aliasRegistryHost[ALIAS_REGISTRY_KEY] ??= new WeakMap());

/** 传输层在工具调用确认、参数还原后调用：记下这个块用过的别名。 */
export function rememberToolCallArgumentAliases(
  block: object,
  aliases: ToolParameterAliases,
): void {
  toolCallArgumentAliasesByBlock.set(block, aliases);
}

/** 往已确认的工具调用块写参数前调用：若该块登记过别名，把别名键还原成原名；否则原样返回。 */
export function decodeToolCallArgumentsForBlock(
  block: object,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return mapToolArgumentsWithAliases(toolCallArgumentAliasesByBlock.get(block), args, "decode");
}

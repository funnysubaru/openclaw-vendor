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

// 顶层对象层（根 + allOf/anyOf/oneOf 分支）只允许出现这些自有键。改名只改 properties / required /
// propertyOrdering 和组合分支；其余关键字只要可能按字段名约束顶层（$ref 目标、patternProperties、
// if/then/else、not、对象字面量的 const/enum/default/examples、OpenAPI discriminator……），改名后就会
// 和参数对不上：要么撞名把两个参数压成一个，要么约束静默失效或恒为假（vendor PR #153 第九、十轮 review）。
// 用白名单而不是黑名单：以后遇到没列出的关键字，默认整个工具不改名，不靠逐个补漏。
// - 只描述层本身、不涉及字段名的：type、description、title、$schema、$id、$comment、deprecated、
//   readOnly、writeOnly、minProperties、maxProperties；
// - additionalProperties / unevaluatedProperties：只约束「没列出的字段」，改名后别名已在 properties 里；
// - $defs / definitions：只存放定义；参数内部指向它们的引用由 planRefAfterRenaming 单独检查，
//   顶层自身带 $ref 不在白名单里，会直接不改名；
// - default、examples 不在白名单：值是对象时里面的键就是字段名，改名不会同步改它们。
const SAFE_TOP_LEVEL_KEYS = new Set([
  "type",
  "properties",
  "required",
  "propertyOrdering",
  "additionalProperties",
  "unevaluatedProperties",
  ...COMBINATOR_KEYS,
  "description",
  "title",
  "$schema",
  "$id",
  "$comment",
  "deprecated",
  "readOnly",
  "writeOnly",
  "minProperties",
  "maxProperties",
  "$defs",
  "definitions",
]);

/** 顶层任一层出现白名单以外的键时返回原因（带键名，进 debug 日志）；都在白名单里返回 undefined。 */
function unsafeTopLevelReason(layers: Record<string, unknown>[]): string | undefined {
  for (const layer of layers) {
    for (const key of Object.keys(layer)) {
      if (!SAFE_TOP_LEVEL_KEYS.has(key)) {
        return `top-level layer has non-allowlisted keyword ${JSON.stringify(key)}`;
      }
    }
  }
  return undefined;
}

/**
 * 解析一个 schema 引用（RFC 3986 片段 + RFC 6901）。只认本文档内的引用：`#...`、空引用、按根 `$id` 写的引用。
 * 规则：先对片段做百分号解码，再按 `/` 拆段、`~1`→`/`、`~0`→`~` 反转义。
 * 外部文档、锚点（`#name`）、百分号编码不合法等无法确定的写法返回 undefined。
 * 改写和递归检测都只走这一个函数（vendor PR #153 第八轮 review 收口）。
 */
type ParsedLocalRef = { base: string; tokens: string[]; percentEncoded: boolean };

function parseLocalRef(ref: string, rootId: string | undefined): ParsedLocalRef | undefined {
  const hash = ref.indexOf("#");
  const base = hash === -1 ? ref : ref.slice(0, hash);
  if (base !== "" && base !== rootId) {
    return undefined;
  }
  const fragment = hash === -1 ? "" : ref.slice(hash + 1);
  let pointer: string;
  try {
    pointer = decodeURIComponent(fragment);
  } catch {
    return undefined;
  }
  if (pointer !== "" && !pointer.startsWith("/")) {
    return undefined;
  }
  const tokens =
    pointer === ""
      ? []
      : pointer
          .slice(1)
          .split("/")
          .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
  return { base, tokens, percentEncoded: fragment.includes("%") };
}

/** parseLocalRef 的逆过程：原引用带百分号编码的逐段重新编码，保证再解析落在同一个目标上。 */
function formatLocalRef({ base, tokens, percentEncoded }: ParsedLocalRef): string {
  const encode = percentEncoded ? encodeURIComponent : (token: string) => token;
  return `${base}#${tokens
    .map((token) => `/${encode(token.replaceAll("~", "~0").replaceAll("/", "~1"))}`)
    .join("")}`;
}

/** 按指针段在 schema 里取值；只走自有属性，取不到返回 undefined。 */
function resolvePointer(schema: unknown, tokens: string[]): unknown {
  let node: unknown = schema;
  for (const token of tokens) {
    if (!node || typeof node !== "object" || !Object.hasOwn(node, token)) {
      return undefined;
    }
    node = (node as Record<string, unknown>)[token];
  }
  return node;
}

/**
 * 判断一个引用在改名之后怎么处理：返回改写后的引用（不受影响时就是原引用），
 * 或返回 { unsafe: 原因 }，表示这个工具不能安全改名。不安全的情况：
 * - 写法无法确定（外部文档、锚点、编码不合法）或指针在 schema 里解析不到；
 * - 指回函数顶层对象层（`#`、`#/allOf/0` 等递归结构）：嵌套数据也会套用改过名的顶层，回包只还原顶层；
 * - 指向某层整张 properties 表：表的键被改名，引用目标的内容跟着变。
 * 指向被改名参数（`.../properties/in/...`）的引用把那一段换成别名，其余段原样保留。
 */
function planRefAfterRenaming(
  ref: string,
  schema: unknown,
  rootId: string | undefined,
  aliases: ToolParameterAliases,
): string | { unsafe: string } {
  const parsed = parseLocalRef(ref, rootId);
  if (!parsed) {
    return { unsafe: `unsupported ref ${JSON.stringify(ref)}` };
  }
  if (resolvePointer(schema, parsed.tokens) === undefined) {
    return { unsafe: `unresolvable ref ${JSON.stringify(ref)}` };
  }
  const { tokens } = parsed;
  let i = 0;
  // 沿组合关键字 + 下标往下走，停在某个顶层对象层。
  while (
    (COMBINATOR_KEYS as readonly string[]).includes(tokens[i] ?? "") &&
    /^\d+$/.test(tokens[i + 1] ?? "")
  ) {
    i += 2;
  }
  if (i === tokens.length) {
    return { unsafe: `ref re-enters the top level ${JSON.stringify(ref)}` };
  }
  if (tokens[i] !== "properties") {
    return ref;
  }
  if (i + 1 === tokens.length) {
    return { unsafe: `ref targets a renamed properties map ${JSON.stringify(ref)}` };
  }
  const alias = aliases.get(tokens[i + 1] ?? "");
  if (alias === undefined) {
    return ref;
  }
  const renamedTokens = [...tokens];
  renamedTokens[i + 1] = alias;
  return formatLocalRef({ ...parsed, tokens: renamedTokens });
}

function rootIdOf(schema: unknown): string | undefined {
  const id = asRecord(schema).$id;
  return typeof id === "string" ? id : undefined;
}

/**
 * 在最终出站 schema 上算保留字参数的别名；所有顶层字段名都参与避碰。
 * 只要 schema 里有任何引用不能确定地解析或改写，整个工具不改名，原因交给 onSkip（调用方记 debug 日志）：
 * 宁可这个工具在 Gemini 上偶发 MALFORMED_FUNCTION_CALL，也不发出引用悬空的 schema。
 */
export function resolveToolParameterAliases(
  schema: unknown,
  onSkip?: (reason: string) => void,
): ToolParameterAliases {
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
  if (aliases.size === 0) {
    return aliases;
  }
  const openReason = unsafeTopLevelReason(layers);
  if (openReason !== undefined) {
    onSkip?.(openReason);
    return new Map();
  }
  // 逐个检查 schema 里的引用（含 $recursiveRef / $dynamicRef），有一个不安全就整体放弃改名。
  const rootId = rootIdOf(schema);
  let unsafe: string | undefined;
  mapSchemaRefs(schema, (ref) => {
    if (unsafe === undefined) {
      const plan = planRefAfterRenaming(ref, schema, rootId, aliases);
      if (typeof plan !== "string") {
        unsafe = plan.unsafe;
      }
    }
    return ref;
  });
  if (unsafe !== undefined) {
    onSkip?.(unsafe);
    return new Map();
  }
  return aliases;
}

// 范围：只改 properties / required / propertyOrdering 和组合分支。顶层出现白名单（SAFE_TOP_LEVEL_KEYS）
// 以外的关键字时，resolveToolParameterAliases 已整体放弃改名，走不到这里。
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
  // 引用里的指针段写的是原名，所以按「改名前」的 schema 解析；不安全的引用原样保留
  // （resolveToolParameterAliases 已保证真正用到的别名表不会遇到这种引用）。
  const rootId = rootIdOf(schema);
  return mapSchemaRefs(renameLayer(schema as Record<string, unknown>, aliases), (ref) => {
    const plan = planRefAfterRenaming(ref, schema, rootId, aliases);
    return typeof plan === "string" ? plan : ref;
  }) as T;
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

/**
 * runner 在纠正工具名（`default_api.automations` → `automations`）、把文本形式的工具调用提升成块之后调用：
 * 按块「当前的」名字查这一轮请求的别名表，还原参数并登记。传输层只按回包里的原始名字还原，
 * 名字被纠正或块是 runner 新建的都会漏（vendor PR #153 合并前自检）。还原是幂等的，重复调用无害。
 */
export function decodeToolCallBlockByName(
  block: { name?: unknown; arguments?: unknown },
  aliasesByTool: ReadonlyMap<string, ToolParameterAliases>,
): void {
  const aliases = typeof block.name === "string" ? aliasesByTool.get(block.name) : undefined;
  if (!aliases || !block.arguments || typeof block.arguments !== "object") {
    return;
  }
  block.arguments = mapToolArgumentsWithAliases(
    aliases,
    block.arguments as Record<string, unknown>,
    "decode",
  );
  toolCallArgumentAliasesByBlock.set(block, aliases);
}

/** 往已确认的工具调用块写参数前调用：若该块登记过别名，把别名键还原成原名；否则原样返回。 */
export function decodeToolCallArgumentsForBlock(
  block: object,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return mapToolArgumentsWithAliases(toolCallArgumentAliasesByBlock.get(block), args, "decode");
}

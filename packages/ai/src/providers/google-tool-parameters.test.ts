import { describe, expect, it } from "vitest";
import {
  applyToolParameterAliases,
  mapToolArgumentsWithAliases,
  resolveToolParameterAliases,
} from "./google-tool-parameters.js";

// vendor PR #153 第四轮自检：引用指回函数顶层（递归结构）时，嵌套数据也会套用改过名的顶层，
// 回包只还原顶层会把嵌套层的别名交给工具，所以这类工具整体不做别名。
describe("resolveToolParameterAliases", () => {
  it("renames keyword parameters when no reference re-enters the top level", () => {
    expect(
      resolveToolParameterAliases({
        type: "object",
        properties: { in: { type: "string" }, copy: { $ref: "#/properties/in" } },
      }),
    ).toEqual(new Map([["in", "in_"]]));
  });

  it.each(["#", "#/", "#/allOf/0", "#/anyOf/1/oneOf/0"])(
    "skips aliasing when a nested $ref points back to the top level (%s)",
    (ref) => {
      expect(
        resolveToolParameterAliases({
          type: "object",
          properties: { in: { type: "string" }, child: { $ref: ref } },
          anyOf: [{}, { oneOf: [{ properties: { x: {} } }] }],
          allOf: [{ properties: { from: {} } }],
        }).size,
      ).toBe(0);
    },
  );

  it("ignores $ref-shaped literal data", () => {
    expect(
      resolveToolParameterAliases({
        type: "object",
        properties: { in: { type: "string" }, literal: { const: { $ref: "#" } } },
      }),
    ).toEqual(new Map([["in", "in_"]]));
  });
});

// vendor PR #153 第五轮自检：名字表与关键字的其余边界、避碰、还原优先级。
describe("schema traversal edge cases", () => {
  it("treats draft-07 dependencies as a name map and example as literal data", () => {
    const schema = {
      type: "object",
      properties: {
        in: { type: "string" },
        // 顶层带 dependencies 会整体不改名（第九轮），这里放在参数内部，只测遍历时把它当名字表。
        other: {
          type: "object",
          dependencies: { default: { properties: { x: { $ref: "#/properties/in" } } } },
          // 顶层 example 不在白名单（第十轮），放进参数内部，只测它按字面数据跳过。
          example: { $ref: "#" },
        },
      },
    };
    const aliases = resolveToolParameterAliases(schema);
    expect(aliases).toEqual(new Map([["in", "in_"]]));
    expect(
      applyToolParameterAliases(schema, aliases).properties.other.dependencies.default.properties.x
        .$ref,
    ).toBe("#/properties/in_");
  });

  it.each(["$recursiveRef", "$dynamicRef"])("skips aliasing when %s re-enters the root", (key) => {
    expect(
      resolveToolParameterAliases({
        type: "object",
        properties: { in: { type: "string" }, child: { [key]: "#" } },
      }).size,
    ).toBe(0);
  });

  it("avoids alias names that only appear in required", () => {
    expect(
      resolveToolParameterAliases({
        type: "object",
        properties: { in: { type: "string" } },
        required: ["in", "in_"],
      }),
    ).toEqual(new Map([["in", "in__"]]));
  });

  it("prefers the aliased key when decoding regardless of key order", () => {
    const aliases = new Map([["in", "in_"]]);
    expect(mapToolArgumentsWithAliases(aliases, { in_: "A", in: "B" }, "decode")).toEqual({
      in: "A",
    });
    expect(mapToolArgumentsWithAliases(aliases, { in: "B", in_: "A" }, "decode")).toEqual({
      in: "A",
    });
  });
});

// vendor PR #153 第五轮 review：参数或 schema 里合法的自有字段 `__proto__` 不能因为普通赋值触发继承 setter 而丢失。
describe("own __proto__ keys", () => {
  const aliases = new Map([["in", "in_"]]);
  const ownProto = (value: object) => Object.getOwnPropertyDescriptor(value, "__proto__")?.value;

  it("keeps an own __proto__ argument when encoding and decoding", () => {
    const encoded = mapToolArgumentsWithAliases(
      aliases,
      JSON.parse('{"__proto__":{"x":1},"in":"a"}') as Record<string, unknown>,
      "encode",
    );
    expect(ownProto(encoded)).toEqual({ x: 1 });
    expect(encoded["in_"]).toBe("a");
    expect(Object.getPrototypeOf(encoded)).toBe(Object.prototype);
    const decoded = mapToolArgumentsWithAliases(
      aliases,
      JSON.parse('{"__proto__":{"x":1},"in_":"a"}') as Record<string, unknown>,
      "decode",
    );
    expect(ownProto(decoded)).toEqual({ x: 1 });
    expect(decoded.in).toBe("a");
  });

  it("keeps an own __proto__ property while rewriting refs below it", () => {
    const schema = JSON.parse(
      '{"type":"object","properties":{"in":{"type":"string"},"__proto__":{"$ref":"#/properties/in"}}}',
    ) as Record<string, any>;
    const renamed = applyToolParameterAliases(schema, resolveToolParameterAliases(schema));
    expect(Object.keys(renamed.properties)).toEqual(["in_", "__proto__"]);
    expect(ownProto(renamed.properties)).toEqual({ $ref: "#/properties/in_" });
    expect(ownProto(schema.properties)).toEqual({ $ref: "#/properties/in" });
  });
});

// vendor PR #153 合并前自检：其它指回根的写法、百分号编码的指针。
describe("root references and percent-encoded pointers", () => {
  it.each([
    { name: "empty $ref", schema: { properties: { in: {}, kids: { items: { $ref: "" } } } } },
    {
      name: "$ref to the root $id",
      schema: { $id: "urn:t", properties: { in: {}, kids: { items: { $ref: "urn:t" } } } },
    },
    {
      name: "$ref to the root $id with an empty fragment",
      schema: { $id: "urn:t", properties: { in: {}, kids: { items: { $ref: "urn:t#" } } } },
    },
    {
      name: "percent-encoded #",
      schema: { properties: { in: {}, kids: { $ref: "#/%61llOf/0" } } },
    },
  ])("skips aliasing for $name", ({ schema }) => {
    expect(resolveToolParameterAliases({ type: "object", ...schema }).size).toBe(0);
  });

  it("rewrites percent-encoded pointers to renamed parameters", () => {
    const schema = {
      type: "object",
      properties: { in: { type: "string" }, other: { $ref: "#/properties/%69n" } },
    };
    const renamed = applyToolParameterAliases(schema, resolveToolParameterAliases(schema));
    expect(renamed.properties.other.$ref).toBe("#/properties/in_");
  });
});

// vendor PR #153 第七轮 review：改写后的引用必须重新做 URI fragment 编码，改名前后解析到同一个目标。
describe("URI fragment encoding of rewritten refs", () => {
  /** RFC 6901 §6：先对 fragment 做百分号解码，再按 JSON Pointer 拆分、反转义。 */
  const resolve = (root: unknown, ref: string) =>
    decodeURIComponent(ref.slice(1))
      .split("/")
      .slice(1)
      .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"))
      .reduce<any>((node, token) => node?.[token], root);

  it.each([
    "#/properties/in/properties/rate%252Fday",
    "#/properties/in/properties/a%20b",
    "#/properties/in/properties/x~1y",
    "#/properties/%69n/properties/rate%252Fday",
  ])("keeps %s resolving to the same target after renaming", (ref) => {
    const schema = {
      type: "object",
      properties: {
        in: {
          type: "object",
          properties: {
            "rate%2Fday": { type: "number" },
            "a b": { type: "boolean" },
            "x/y": { type: "integer" },
          },
        },
        other: { $ref: ref },
      },
    };
    const target = resolve(schema, ref);
    expect(target).toBeDefined();
    const renamed = applyToolParameterAliases(schema, resolveToolParameterAliases(schema));
    expect(renamed.properties.other.$ref).not.toBe(ref);
    expect(resolve(renamed, renamed.properties.other.$ref)).toBe(target);
  });

  it("leaves refs with invalid percent-encoding unchanged", () => {
    const schema = {
      type: "object",
      properties: { in: { type: "string" }, other: { $ref: "#/properties/in/%zz" } },
    };
    const renamed = applyToolParameterAliases(schema, resolveToolParameterAliases(schema));
    expect(renamed.properties.other.$ref).toBe("#/properties/in/%zz");
  });
});

// vendor PR #153 第八轮 review 收口：各种引用写法要么改名前后解析到同一目标，要么整个工具不改名。
// 解析器按 RFC 3986 片段 + RFC 6901 独立实现，不复用被测代码。
describe("ref forms: same target after renaming, or no renaming at all", () => {
  const resolveRef = (root: Record<string, any>, ref: string): unknown => {
    const hash = ref.indexOf("#");
    const base = hash === -1 ? ref : ref.slice(0, hash);
    if (base !== "" && base !== root.$id) {
      return undefined;
    }
    let pointer: string;
    try {
      pointer = decodeURIComponent(hash === -1 ? "" : ref.slice(hash + 1));
    } catch {
      return undefined;
    }
    if (pointer === "") {
      return root;
    }
    if (!pointer.startsWith("/")) {
      return undefined;
    }
    return pointer
      .slice(1)
      .split("/")
      .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"))
      .reduce<any>(
        (node, token) => (node && Object.hasOwn(node, token) ? node[token] : undefined),
        root,
      );
  };

  const makeSchema = (ref: string) => ({
    $id: "urn:t",
    type: "object",
    properties: {
      in: {
        type: "object",
        properties: {
          "a b": { type: "boolean" },
          "rate%2Fday": { type: "number" },
          "x/y": { type: "integer" },
          "t~s": { type: "null" },
        },
      },
      other: { $ref: ref },
    },
    $defs: { Wrapper: { type: "string" } },
  });

  it.each([
    "#/properties/in",
    "#/properties/in/properties/a b",
    "#/properties/in/properties/a%20b",
    "#/properties/in/properties/rate%252Fday",
    "#%2Fproperties%2Fin",
    "#%2Fproperties/in/properties/x~1y",
    "#/properties/%69n",
    "#/properties/in/properties/x~1y",
    "#/properties/in/properties/t~0s",
    "urn:t#/properties/in",
    "urn:t#%2Fproperties%2Fin",
    "#/$defs/Wrapper",
  ])("renames and keeps %j resolving to the same target", (ref) => {
    const schema = makeSchema(ref);
    const target = resolveRef(schema, ref);
    expect(target).toBeDefined();
    const aliases = resolveToolParameterAliases(schema);
    expect(aliases).toEqual(new Map([["in", "in_"]]));
    const renamed = applyToolParameterAliases(schema, aliases);
    expect(Object.keys(renamed.properties)).toEqual(["in_", "other"]);
    expect(resolveRef(renamed, renamed.properties.other.$ref)).toBe(target);
  });

  it.each([
    ["invalid percent-encoding", "#/properties/in/%zz"],
    ["external document", "https://example.test/s.json#/properties/in"],
    ["relative external document", "other.json"],
    ["plain-name anchor", "#anchor"],
    ["root via #", "#"],
    ["root via empty ref", ""],
    ["root via $id", "urn:t"],
    ["root via $id with empty fragment", "urn:t#"],
    ["dangling pointer", "#/properties/missing"],
    ["the properties map itself", "#/properties"],
    ["root via trailing slash", "#/"],
  ])("does not rename when a ref is %s", (_label, ref) => {
    const notified: string[] = [];
    expect(
      resolveToolParameterAliases(makeSchema(ref), (reason) => notified.push(reason)).size,
    ).toBe(0);
    expect(notified).toHaveLength(1);
  });
});

// vendor PR #153 第九轮 review：顶层对象层（根，或 allOf/anyOf/oneOf 分支）的字段集合必须能完整确定，
// 否则避碰算不全，`in` 可能被改成引用目标/条件分支里已有的 `in_`，两个参数压成一个。
// 凡是可能额外引入或约束顶层字段名的关键字，一律整个工具不改名。
describe("top-level layers whose field set is not fully known", () => {
  it("does not rename when a top-level allOf branch is a $ref (review repro)", () => {
    const schema = {
      type: "object",
      properties: { in: { type: "string" } },
      allOf: [{ $ref: "#/$defs/Extra" }],
      $defs: {
        Extra: { type: "object", properties: { in_: { type: "number" } }, required: ["in_"] },
      },
    };
    const notified: string[] = [];
    const aliases = resolveToolParameterAliases(schema, (reason) => notified.push(reason));
    expect(aliases.size).toBe(0);
    expect(notified).toHaveLength(1);
    // 不改名时编码/解码都是原样，`in` 和 `in_` 两个参数都保留。
    expect(mapToolArgumentsWithAliases(aliases, { in: "5m", in_: 7 }, "encode")).toEqual({
      in: "5m",
      in_: 7,
    });
  });

  const base = { type: "object", properties: { in: { type: "string" } } };
  it.each([
    ["root $ref", { ...base, $ref: "#/$defs/X", $defs: { X: { type: "object" } } }],
    ["root $recursiveRef", { ...base, $recursiveRef: "#" }],
    ["root $dynamicRef", { ...base, $dynamicRef: "#meta" }],
    [
      "$ref in a nested combinator branch",
      {
        ...base,
        anyOf: [{ oneOf: [{ $ref: "#/$defs/X" }] }],
        $defs: { X: { type: "object", properties: { in_: { type: "number" } } } },
      },
    ],
    ["root patternProperties", { ...base, patternProperties: { "^in_$": { type: "number" } } }],
    [
      "patternProperties in a branch",
      { ...base, allOf: [{ patternProperties: { "^i": { type: "number" } } }] },
    ],
    // JSON Schema 的 then 关键字：用 JSON 字面量构造，避免对象字面量写 then 键（lint no-thenable）。
    [
      "root if/then/else",
      {
        ...base,
        ...JSON.parse('{"if":{"required":["in"]},"then":{"properties":{"in_":{}}},"else":{}}'),
      },
    ],
    ["then only", { ...base, ...JSON.parse('{"then":{"properties":{"in_":{}}}}') }],
    ["dependentSchemas", { ...base, dependentSchemas: { in: { properties: { in_: {} } } } }],
    ["draft-07 dependencies", { ...base, dependencies: { in: ["other"] } }],
    ["dependentRequired", { ...base, dependentRequired: { in: ["other"] } }],
    ["propertyNames", { ...base, propertyNames: { pattern: "^[a-z]+$" } }],
  ])("does not rename when the top level has %s", (_label, schema) => {
    const notified: string[] = [];
    expect(resolveToolParameterAliases(schema, (reason) => notified.push(reason)).size).toBe(0);
    expect(notified).toHaveLength(1);
  });

  it("still renames when those keywords only appear inside a parameter", () => {
    const schema = {
      type: "object",
      properties: {
        in: {
          type: "object",
          $ref: "#/$defs/X",
          patternProperties: { "^a": {} },
          ...JSON.parse('{"if":{},"then":{}}'),
          dependentSchemas: {},
        },
      },
      $defs: { X: { type: "object" } },
    };
    expect(resolveToolParameterAliases(schema)).toEqual(new Map([["in", "in_"]]));
  });
});

// vendor PR #153 第十轮 review：顶层判断从黑名单改为白名单（SAFE_TOP_LEVEL_KEYS）。
// 白名单以外的任何键都让整个工具不改名，日志原因里带上这个键名。
describe("top-level keyword allowlist", () => {
  const base = { type: "object", properties: { in: { type: "string" } }, required: ["in"] };
  it.each([
    ["not (contradiction after renaming)", "not", { ...base, not: { required: ["in_"] } }],
    ["not (mutual exclusion)", "not", { ...base, not: { required: ["in", "at"] } }],
    ["object const", "const", { ...base, const: { mode: "delay", in: "5m" } }],
    ["object enum", "enum", { ...base, enum: [{ in: "5m" }] }],
    [
      "OpenAPI discriminator on a oneOf",
      "discriminator",
      {
        type: "object",
        oneOf: [{ properties: { in: { const: "a" } } }, { properties: { in: { const: "b" } } }],
        discriminator: { propertyName: "in" },
      },
    ],
    ["object default", "default", { ...base, default: { in: "5m" } }],
    ["object examples", "examples", { ...base, examples: [{ in: "5m" }] }],
    ["an unknown keyword", "x-future-keyword", { ...base, "x-future-keyword": true }],
    [
      "a non-allowlisted keyword in a branch",
      "not",
      { ...base, allOf: [{ not: { required: ["in_"] } }] },
    ],
  ])("does not rename when the top level has %s", (_label, key, schema) => {
    const notified: string[] = [];
    expect(resolveToolParameterAliases(schema, (reason) => notified.push(reason)).size).toBe(0);
    expect(notified).toEqual([
      `top-level layer has non-allowlisted keyword ${JSON.stringify(key)}`,
    ]);
  });

  it("renames with every allowlisted keyword present", () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "urn:tool",
      $comment: "c",
      title: "t",
      description: "d",
      type: "object",
      properties: { in: { type: "string" } },
      required: ["in"],
      propertyOrdering: ["in"],
      additionalProperties: false,
      unevaluatedProperties: false,
      minProperties: 1,
      maxProperties: 3,
      deprecated: false,
      readOnly: false,
      writeOnly: false,
      $defs: {},
      definitions: {},
      allOf: [{ type: "object", properties: { at: { type: "string" } } }],
    };
    expect(resolveToolParameterAliases(schema)).toEqual(new Map([["in", "in_"]]));
  });

  // 真实引擎请求（req1.json）里这两个工具正是要修的对象；顶层只有 type / properties / required，
  // 白名单不能把它们挡掉。这里按抓到的请求体保留顶层形状，参数内容截短。
  it.each([
    [
      "automations",
      {
        type: "object",
        properties: {
          action: { type: "string" },
          in: { type: "string", description: 'Relative duration for action="next_check"' },
          job: { type: "object", properties: { name: { type: "string" } } },
        },
        required: ["action"],
      },
      new Map([["in", "in_"]]),
    ],
    [
      "memory_get",
      {
        type: "object",
        properties: {
          path: { type: "string" },
          from: { type: "number" },
          lines: { type: "number" },
        },
        required: ["path"],
      },
      new Map([["from", "from_"]]),
    ],
  ])("still renames the real %s schema", (_name, schema, expected) => {
    const notified: string[] = [];
    expect(resolveToolParameterAliases(schema, (reason) => notified.push(reason))).toEqual(
      expected,
    );
    expect(notified).toEqual([]);
  });
});

// vendor PR #153 第十一轮 review：嵌套子 schema 带自己的 `$id` 就成了独立子文档，里面的 `#/...`
// 相对它解析；引用改写只认最外层根这一种基准，所以这类工具整体不改名。锚点类键同理。
describe("nested schema resources", () => {
  const skipReason = (schema: unknown) => {
    const notified: string[] = [];
    const aliases = resolveToolParameterAliases(schema, (reason) => notified.push(reason));
    return { size: aliases.size, notified };
  };

  it("does not rename when a nested property schema has its own $id (review repro)", () => {
    // 嵌套 copy 的 `#/properties/in` 指向嵌套文档里的 in；按最外层根改写会把它改成悬空的 in_。
    const schema = {
      type: "object",
      properties: {
        in: { type: "string" },
        nested: {
          $id: "urn:example:nested",
          type: "object",
          properties: { in: { type: "number" }, copy: { $ref: "#/properties/in" } },
        },
      },
    };
    expect(skipReason(schema)).toEqual({
      size: 0,
      notified: [
        "schema node #/properties/nested has $id; refs inside it may not resolve against the root",
      ],
    });
    // 不改名时出站 schema 原样不动，嵌套引用仍指向嵌套文档里的 in。
    expect(applyToolParameterAliases(schema, new Map())).toBe(schema);
  });

  const base = { type: "object", properties: { in: { type: "string" } } };
  it.each([
    ["$defs entry with $id", { ...base, $defs: { Embedded: { $id: "urn:e", type: "object" } } }],
    ["allOf branch with $id", { ...base, allOf: [{ $id: "urn:b", type: "object" }] }],
    [
      "draft-04 string id in a property",
      { ...base, properties: { ...base.properties, x: { id: "urn:x" } } },
    ],
    ["$anchor in a property", { ...base, properties: { ...base.properties, x: { $anchor: "a" } } }],
    ["$dynamicAnchor in $defs", { ...base, $defs: { D: { $dynamicAnchor: "meta" } } }],
    [
      "$recursiveAnchor in a property",
      { ...base, properties: { ...base.properties, x: { $recursiveAnchor: true } } },
    ],
    [
      "$schema in an allOf branch",
      { ...base, allOf: [{ $schema: "https://json-schema.org/draft/2020-12/schema" }] },
    ],
  ])("does not rename with %s", (_label, schema) => {
    const { size, notified } = skipReason(schema);
    expect(size).toBe(0);
    expect(notified).toHaveLength(1);
  });

  it("still renames when a parameter is merely named $id or id", () => {
    const schema = {
      $id: "urn:root",
      type: "object",
      properties: {
        in: { type: "string" },
        $id: { type: "string" },
        id: { type: "string" },
        $anchor: { type: "string" },
      },
      required: ["in", "$id"],
      $defs: { Literal: { type: "object", default: { $id: "urn:not-a-resource" } } },
    };
    expect(resolveToolParameterAliases(schema)).toEqual(new Map([["in", "in_"]]));
  });

  it("ignores a non-string id (not a draft-04 resource id)", () => {
    const schema = { ...base, properties: { ...base.properties, x: { type: "object", id: 3 } } };
    expect(resolveToolParameterAliases(schema)).toEqual(new Map([["in", "in_"]]));
  });
});

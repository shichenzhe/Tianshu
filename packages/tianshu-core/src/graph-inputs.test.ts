// packages/tianshu-core/src/graph-inputs.test.ts
/**
 * json 输入类型（2026-11-05）：
 * - normalizeGraphInputs json 归一三态：原生容器保型直收 / JSON 文本
 *   parse 为容器归一原生值 / 非法（含标量 JSON 文本）回喂 invalidJson
 * - json default 容器填充；parseInputSchema 容器 default 透传
 * - validateGraph 声明面：json 类型 + 容器 default 合法、default 字符串
 *   不自洽、enumValues 仅 enum 可带互斥
 * - renderNodePrompt：{{input.x}} 容器值紧凑 stringify 插入（替代
 *   String() 的 [object Object]）
 */
import { describe, expect, it } from "vitest";
import {
  normalizeGraphInputs,
  parseInputSchema,
} from "./graph-inputs";
import { validateGraph } from "./graph-schema";
import { GraphTemplateError, renderNodePrompt } from "./graph-prompt";

const jsonField = {
  key: "payload",
  type: "json",
  required: true,
} as const;

describe("normalizeGraphInputs json 归一", () => {
  it("原生对象/数组保型直收", () => {
    const result = normalizeGraphInputs([jsonField], {
      payload: { a: 1, b: [true, null] },
    });
    expect(result).toEqual({
      ok: true,
      inputs: { payload: { a: 1, b: [true, null] } },
    });
  });

  it("JSON 文本 parse 为容器 → 归一原生值", () => {
    const result = normalizeGraphInputs([jsonField], {
      payload: '[{"x": 2}]',
    });
    expect(result).toEqual({ ok: true, inputs: { payload: [{ x: 2 }] } });
  });

  it("非法 JSON 文本回喂 invalidJson", () => {
    const result = normalizeGraphInputs([jsonField], { payload: "{a:1}" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].code).toBe("invalidJson");
      expect(result.issues[0].message).toContain("payload");
    }
  });

  it("标量 JSON 文本拒收（与既有标量类型互斥）", () => {
    const scalar = normalizeGraphInputs([jsonField], { payload: "3" });
    expect(scalar.ok).toBe(false);
    if (!scalar.ok) {
      expect(scalar.issues[0].code).toBe("invalidJson");
    }
    const nullText = normalizeGraphInputs([jsonField], { payload: "null" });
    expect(nullText.ok).toBe(false);
  });

  it("顶层 raw null 视为缺值（沿用切片 D 归一语义——null=没有值，非值为 null）", () => {
    // required → 报缺，run 不启动
    const req = normalizeGraphInputs([jsonField], { payload: null });
    expect(req.ok).toBe(false);
    if (!req.ok) {
      expect(req.issues[0].code).toBe("required");
    }
    // optional 无 default → 键缺席（模板引用将抛「模板变量未定义」）
    const opt = normalizeGraphInputs(
      [{ ...jsonField, required: false }],
      { payload: null },
    );
    expect(opt).toEqual({ ok: true, inputs: {} });
    // optional + default → 填充 default
    const def = normalizeGraphInputs(
      [{ ...jsonField, required: false, default: { a: 1 } }],
      { payload: null },
    );
    expect(def).toEqual({ ok: true, inputs: { payload: { a: 1 } } });
  });

  it("缺值时 default 容器填充（原生形态）", () => {
    const result = normalizeGraphInputs(
      [{ ...jsonField, required: false, default: { fallback: true } }],
      {},
    );
    expect(result).toEqual({
      ok: true,
      inputs: { payload: { fallback: true } },
    });
  });
});

describe("parseInputSchema json 透传", () => {
  it("json 字段（含容器 default）逐字段透传", () => {
    const fields = parseInputSchema({
      payload: { type: "json", required: false, default: [1, 2] },
    });
    expect(fields).toEqual([
      { key: "payload", type: "json", required: false, default: [1, 2] },
    ]);
  });
});

/** 最小合法图 fixture（start + database 两节点） */
function graphWith(inputSchema: Record<string, unknown>) {
  return {
    version: 1,
    inputSchema,
    nodes: [
      { id: "start", name: "开始", kind: "start", variables: ["payload"] },
      {
        id: "insert",
        name: "插入",
        kind: "database",
        engine: "sqlite",
        sqlitePath: "demo.db",
        sql: "INSERT INTO t (a) VALUES (?)",
        params: ["{{input.payload}}"],
      },
    ],
    edges: [
      { from: "start", to: "insert" },
      { from: "insert", to: "END" },
    ],
  };
}

describe("validateGraph json 声明", () => {
  it("json 类型 + 容器 default 合法", () => {
    const result = validateGraph(
      graphWith({
        payload: { type: "json", default: { a: 1 } },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("json 的 default 为字符串 → 不自洽报错", () => {
    const result = validateGraph(
      graphWith({
        payload: { type: "json", default: "not-json-object" },
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("json 带 enumValues 被拒（仅 enum 可带）", () => {
    const result = validateGraph(
      graphWith({
        payload: { type: "json", enumValues: ["a"] },
      }),
    );
    expect(result.ok).toBe(false);
  });
});

describe("renderNodePrompt 容器值 stringify", () => {
  it("{{input.x}} 容器值紧凑 JSON 插入", () => {
    const out = renderNodePrompt("{{input.payload}}", {
      inputs: { payload: { a: 1, list: [1, 2] } },
      nodes: {},
      now: new Date("2026-11-05T08:00:00"),
    });
    expect(out).toBe('{"a":1,"list":[1,2]}');
  });

  it("标量值替换语义不变（35 → \"35\"）", () => {
    const out = renderNodePrompt("n={{input.n}} b={{input.b}}", {
      inputs: { n: 35, b: true },
      nodes: {},
      now: new Date("2026-11-05T08:00:00"),
    });
    expect(out).toBe("n=35 b=true");
  });
});

/** 路径引用 fixture：容器含嵌套对象/数组/null/数字字段/数字键对象 */
const PATH_INPUTS = {
  payload: {
    name: "张三",
    count: 35,
    sub: { deep: "leaf" },
    items: [{ id: 1 }, { id: 2 }],
    flags: { 0: "on" },
    nothing: null,
  },
  plain: "文本值",
} as Record<string, unknown>;

describe("renderNodePrompt 字段路径引用（{{input.x.fieldx}}）", () => {
  const render = (template: string) =>
    renderNodePrompt(template, {
      inputs: PATH_INPUTS as never,
      nodes: {},
      now: new Date("2026-11-05T08:00:00"),
    });

  it("对象字段叶子：标量按 String() 插入", () => {
    expect(render("{{input.payload.name}}")).toBe("张三");
    expect(render("n={{input.payload.count}}")).toBe("n=35");
  });

  it("嵌套路径逐层下钻", () => {
    expect(render("{{input.payload.sub.deep}}")).toBe("leaf");
  });

  it("数组下标段：[N] 按下标取项（可混排 .field 与 [N]）", () => {
    expect(render("{{input.payload.items[0].id}}")).toBe("1");
    expect(render("{{input.payload.items[1].id}}")).toBe("2");
    expect(render("{{input.payload.items[0]}}")).toBe('{"id":1}');
  });

  it("正交语义锁定：.N 对数组抛错（点号一律字段名）", () => {
    expect(() => render("{{input.payload.items.0.id}}")).toThrow(
      GraphTemplateError,
    );
  });

  it("正交语义锁定：[N] 对非数组抛错；对象数字键走 .N 字段名", () => {
    expect(() => render("{{input.payload.name[0]}}")).toThrow(
      GraphTemplateError,
    );
    expect(render("{{input.payload.flags.0}}")).toBe("on");
  });

  it("叶子为容器：紧凑 stringify（与顶层同语义）", () => {
    expect(render("{{input.payload.sub}}")).toBe('{"deep":"leaf"}');
    expect(render("{{input.payload.items}}")).toBe('[{"id":1},{"id":2}]');
  });

  it("叶子为 null：抛 GraphTemplateError（null 不可消费——引用三层次统一）", () => {
    expect(() => render("{{input.payload.nothing}}")).toThrow(
      GraphTemplateError,
    );
    // 顶层 null（空声明直通场景）同抛
    expect(() =>
      renderNodePrompt("{{input.x}}", {
        inputs: { x: null },
        nodes: {},
        now: new Date("2026-11-05T08:00:00"),
      } as never),
    ).toThrow(GraphTemplateError);
  });

  it("容器整体 stringify 时内含 null 合法（JSON 文本一部分，无损保留）", () => {
    expect(render("{{input.payload}}")).toContain('"nothing":null');
  });

  it("字段缺失/下标越界/中途非容器：抛 GraphTemplateError", () => {
    expect(() => render("{{input.payload.missing}}")).toThrow(
      GraphTemplateError,
    );
    expect(() => render("{{input.payload.items[5].id}}")).toThrow(
      GraphTemplateError,
    );
    // 标量（string 类型值）不可下钻
    expect(() => render("{{input.plain.fieldx}}")).toThrow(
      GraphTemplateError,
    );
  });

  it("中途 null（字段值为 null 再下钻）：抛 GraphTemplateError", () => {
    // payload 为 null → 首个余段 .items 即撞 null 检查
    expect(() =>
      renderNodePrompt("{{input.nullPayload.items[0]}}", {
        inputs: { nullPayload: null },
        nodes: {},
        now: new Date("2026-11-05T08:00:00"),
      } as never),
    ).toThrow(GraphTemplateError);
    // items 为 null → [0] 段撞非数组检查
    expect(() =>
      renderNodePrompt("{{input.payload.nullItems[0]}}", {
        inputs: { payload: { nullItems: null } },
        nodes: {},
        now: new Date("2026-11-05T08:00:00"),
      } as never),
    ).toThrow(GraphTemplateError);
  });

  it("键未声明：抛 GraphTemplateError（路径首段即键）", () => {
    expect(() => render("{{input.unknown.fieldx}}")).toThrow(
      GraphTemplateError,
    );
  });
});

describe("renderNodePrompt null 安全引用（{{input.x.path?}}）", () => {
  const render = (template: string) =>
    renderNodePrompt(template, {
      inputs: {
        ...PATH_INPUTS,
        nullPayload: null,
      } as never,
      nodes: {},
      now: new Date("2026-11-05T08:00:00"),
    });

  it("? 降级：null 叶子/键缺失/越界/中途 null/顶层 null → 空串", () => {
    expect(render("{{input.payload.nothing?}}")).toBe("");
    expect(render("{{input.payload.missing?}}")).toBe("");
    expect(render("{{input.payload.items[5]?}}")).toBe("");
    expect(render("{{input.nullPayload.items[0]?}}")).toBe("");
    expect(render("{{input.nullPayload?}}")).toBe("");
    expect(render("{{input.unknown?}}")).toBe("");
  });

  it("? 正常值不受影响（标量/容器照常渲染）", () => {
    expect(render("{{input.payload.name?}}")).toBe("张三");
    expect(render("{{input.payload.count?}}")).toBe("35");
    expect(render("{{input.payload.items[0]?}}")).toBe('{"id":1}');
    expect(render("{{input.payload?}}")).toBe(
      JSON.stringify(PATH_INPUTS.payload),
    );
  });

  it("? 拼接场景（condition source 判空用法）", () => {
    expect(render("v={{input.payload.nothing?}}!")).toBe("v=!");
  });

  it("无 ? 语义不变：null 叶子仍抛错", () => {
    expect(() => render("{{input.payload.nothing}}")).toThrow(
      GraphTemplateError,
    );
  });
});

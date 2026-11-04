// tests/ai/graph-input-schema.test.ts
/**
 * typed 输入参数（切片 D1，@tianshu/core）：
 * - inputSchema 双形态：旧字符串简写合法（存量图零迁移）、对象形态校验
 *   完备（类型字面量/default 自洽/enum 值域非空不重复/未知键拒绝）
 * - parseInputSchema：简写/对象统一归一（required 缺省 true=旧语义等价）
 * - normalizeGraphInputs：required 结构化报错、default 填充（含 date
 *   "today" 魔法值）、number/boolean/enum/date 归一、未声明键丢弃
 */
import { describe, expect, it } from "vitest";
import {
  graphJsonSchema,
  inputFieldSchema,
  validateGraph,
} from "../../packages/tianshu-core/src/graph-schema";
import {
  normalizeGraphInputs,
  parseInputSchema,
} from "../../packages/tianshu-core/src/graph-inputs";

const graphOf = (inputSchema: unknown) => ({
  version: 1,
  inputSchema,
  nodes: [
    { id: "start", name: "开始", kind: "start", variables: [] },
    {
      id: "db",
      name: "查询",
      kind: "database",
      engine: "sqlite",
      sqlitePath: "demo.db",
      sql: "SELECT 1",
    },
  ],
  edges: [
    { from: "start", to: "db" },
    { from: "db", to: "END" },
  ],
});

describe("inputSchema 双形态校验", () => {
  it("旧字符串简写合法（存量图零迁移）；对象形态过校验", () => {
    expect(graphJsonSchema.safeParse(graphOf({ a: "string" })).success).toBe(
      true,
    );
    const typed = graphOf({
      amount: { type: "number", required: true },
      category: {
        type: "enum",
        enumValues: ["餐饮", "交通"],
        default: "餐饮",
      },
      note: { type: "string", required: false, default: "" },
      spent_at: { type: "date", default: "today" },
      flag: { type: "boolean" },
    });
    const result = validateGraph(typed);
    expect(result.ok).toBe(true);
  });

  it("类型字面量越界 / 未知键拒绝（strict）", () => {
    expect(inputFieldSchema.safeParse({ type: "float" }).success).toBe(false);
    expect(
      inputFieldSchema.safeParse({ type: "string", unknownKey: 1 }).success,
    ).toBe(false);
  });

  it("enum：值域必填非空、不重复、default 须在值域内；非 enum 带 enumValues 拒绝", () => {
    expect(inputFieldSchema.safeParse({ type: "enum" }).success).toBe(false);
    expect(
      inputFieldSchema.safeParse({ type: "enum", enumValues: [] }).success,
    ).toBe(false);
    expect(
      inputFieldSchema.safeParse({
        type: "enum",
        enumValues: ["a", "a"],
      }).success,
    ).toBe(false);
    expect(
      inputFieldSchema.safeParse({
        type: "enum",
        enumValues: ["a", "b"],
        default: "c",
      }).success,
    ).toBe(false);
    expect(
      inputFieldSchema.safeParse({ type: "string", enumValues: ["a"] }).success,
    ).toBe(false);
  });

  it("default 与类型自洽：number 收数值、boolean 收布尔、date 收串", () => {
    expect(
      inputFieldSchema.safeParse({ type: "number", default: "12" }).success,
    ).toBe(false);
    expect(
      inputFieldSchema.safeParse({ type: "number", default: 12 }).success,
    ).toBe(true);
    expect(
      inputFieldSchema.safeParse({ type: "boolean", default: "yes" }).success,
    ).toBe(false);
    expect(
      inputFieldSchema.safeParse({ type: "boolean", default: true }).success,
    ).toBe(true);
    expect(
      inputFieldSchema.safeParse({ type: "date", default: "today" }).success,
    ).toBe(true);
    expect(
      inputFieldSchema.safeParse({ type: "date", default: 7 }).success,
    ).toBe(false);
  });
});

describe("parseInputSchema（归一化）", () => {
  it("简写等价 {type:string, required:true}；对象保留可选配置", () => {
    const fields = parseInputSchema({
      legacy: "string",
      amount: { type: "number", required: true },
      category: {
        type: "enum",
        required: false,
        enumValues: ["a", "b"],
        default: "a",
        description: "分类",
      },
    });
    expect(fields).toEqual([
      { key: "legacy", type: "string", required: true },
      { key: "amount", type: "number", required: true },
      {
        key: "category",
        type: "enum",
        required: false,
        enumValues: ["a", "b"],
        default: "a",
        description: "分类",
      },
    ]);
  });

  it("空/非法输入防御性空集或 string 兜底", () => {
    expect(parseInputSchema(undefined)).toEqual([]);
    expect(parseInputSchema({ x: 123 })).toEqual([
      { key: "x", type: "string", required: true },
    ]);
  });
});

describe("normalizeGraphInputs（入口校验与填充）", () => {
  const fields = parseInputSchema({
    amount: { type: "number", required: true },
    category: { type: "enum", enumValues: ["餐饮", "交通"], default: "餐饮" },
    note: { type: "string", required: false, default: "" },
    spent_at: { type: "date", default: "today" },
    flag: { type: "boolean", required: false },
  });

  it("required 缺参结构化报错（不再是模板渲染期才炸）", () => {
    const result = normalizeGraphInputs(fields, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]).toMatchObject({
        key: "amount",
        code: "required",
      });
    }
  });

  it('default 填充：enum 默认、date "today" 归一为当天 yyyy-MM-dd', () => {
    const result = normalizeGraphInputs(fields, { amount: 35 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.inputs.amount).toBe(35);
      expect(result.inputs.category).toBe("餐饮");
      expect(result.inputs.note).toBe("");
      expect(String(result.inputs.spent_at)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect("flag" in result.inputs).toBe(false);
    }
  });

  it('类型归一：数字串转 number、"true" 转 boolean、enum 越界拒绝、date 归一', () => {
    const result = normalizeGraphInputs(fields, {
      amount: "42.5",
      category: "交通",
      flag: "true",
      spent_at: "2026-10-29T08:30:00.000Z",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.inputs.amount).toBe(42.5);
      expect(result.inputs.category).toBe("交通");
      expect(result.inputs.flag).toBe(true);
      expect(result.inputs.spent_at).toBe("2026-10-29");
    }
    const badEnum = normalizeGraphInputs(fields, {
      amount: 1,
      category: "娱乐",
    });
    expect(badEnum.ok).toBe(false);
    if (!badEnum.ok) {
      expect(badEnum.issues[0]).toMatchObject({
        key: "category",
        code: "invalidEnum",
      });
      expect(badEnum.issues[0].message).toContain("餐饮|交通");
    }
    const badNumber = normalizeGraphInputs(fields, { amount: "abc" });
    expect(badNumber.ok).toBe(false);
    const badDate = normalizeGraphInputs(fields, {
      amount: 1,
      spent_at: "not-a-date",
    });
    expect(badDate.ok).toBe(false);
    if (!badDate.ok) {
      expect(badDate.issues[0].code).toBe("invalidDate");
    }
  });

  it("未声明键丢弃（防夹带）；optional 缺省不报错且不入 inputs", () => {
    const result = normalizeGraphInputs(
      parseInputSchema({
        a: { type: "string", required: true },
        b: { type: "string", required: false },
      }),
      { a: "x", evil: "<script>" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.inputs).toEqual({ a: "x" });
    }
  });
});

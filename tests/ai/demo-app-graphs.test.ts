// tests/ai/demo-app-graphs.test.ts
/**
 * docs/demo-app 记账 demo 工作流定义守护：四份 JSON 须过 validateGraph
 * （可导入性——create_workflow 与画布保存共用同一校验口），且关键结构
 * 不漂移：database 节点 sqlitePath 一律锚定工作空间相对路径 demo.db
 * （db-client 界内守卫决定，写死绝对路径必跑挂）、DDL 幂等、SQL 值全部
 * 参数化（模板占位只出现在 params，不内插进 SQL 字面量）、零 code 节点
 * （组装走 merge 模板 + jsonParse 标量提取，切片 C 去 code 化）、组装
 * 输出结构与旧 code 路线等价（note null 保留为唯一备案差异点）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateGraph } from "../../src-react/domains/ai/orchestration/api/graph.schema";
import {
  normalizeGraphInputs,
  parseInputSchema,
} from "../../packages/tianshu-core/src/graph-inputs";

const DEMO_DIR = fileURLToPath(new URL("../../docs/demo-app", import.meta.url));

interface DemoBundle {
  name: string;
  description: string;
  graphJson: unknown;
}

const FILES = [
  "demo-init.json",
  "expense-add.json",
  "expense-query.json",
  "expense-summary.json",
] as const;

function loadBundle(file: string): DemoBundle {
  return JSON.parse(
    readFileSync(path.join(DEMO_DIR, file), "utf8"),
  ) as DemoBundle;
}

function loadGraph(file: string) {
  const bundle = loadBundle(file);
  const result = validateGraph(bundle.graphJson);
  expect(result.ok).toBe(true);
  return { bundle, json: result.ok ? result.value : null };
}

describe("demo-app 工作流定义（docs/demo-app）", () => {
  it("四份 JSON 全部过 validateGraph（create_workflow 可直接导入）", () => {
    for (const file of FILES) {
      const bundle = loadBundle(file);
      const result = validateGraph(bundle.graphJson);
      expect(result.ok, `${file} 校验失败`).toBe(true);
    }
  });

  it("四图零 code 节点（去 code 化：打包态不依赖系统 node 解释器）", () => {
    for (const file of FILES) {
      const { json } = loadGraph(file);
      expect(
        json!.nodes.filter((n) => n.kind === "code"),
        file,
      ).toHaveLength(0);
    }
  });

  it("database 节点 sqlitePath 一律 demo.db（工作空间相对锚定不漂移）", () => {
    for (const file of FILES) {
      const { json } = loadGraph(file);
      const dbNodes = json!.nodes.filter((n) => n.kind === "database");
      expect(dbNodes.length, file).toBeGreaterThan(0);
      for (const node of dbNodes) {
        expect(node.kind === "database" && node.sqlitePath, file).toBe(
          "demo.db",
        );
      }
    }
  });

  it("初始化 DDL 幂等（IF NOT EXISTS + expense 全列）", () => {
    const { json } = loadGraph("demo-init.json");
    const node = json!.nodes.find((n) => n.kind === "database");
    expect(node!.kind === "database" && node!.sql).toContain(
      "CREATE TABLE IF NOT EXISTS expense",
    );
    expect(node!.kind === "database" && node!.sql).toContain("AUTOINCREMENT");
  });

  it("SQL 值全参数化：模板占位只出现在 params，SQL 字面量无内插", () => {
    const add = loadGraph("expense-add.json").json!;
    const insert = add.nodes.find(
      (n) => n.id === "insert-expense" && n.kind === "database",
    );
    expect(insert && insert.kind === "database" && insert.sql).not.toContain(
      "{{",
    );
    expect(
      insert && insert.kind === "database" ? insert.params : [],
    ).toHaveLength(4);

    const query = loadGraph("expense-query.json").json!;
    const select = query.nodes.find(
      (n) => n.id === "select-expenses" && n.kind === "database",
    );
    expect(select && select.kind === "database" && select.sql).not.toContain(
      "{{",
    );
  });

  it("typed inputSchema（切片 D5）：amount number 必填、category enum 六值缺省其他、spent_at date 缺省今天", () => {
    const { bundle, json } = loadGraph("expense-add.json");
    const schema = json!.inputSchema;
    expect(schema.amount).toMatchObject({ type: "number", required: true });
    expect(schema.category).toMatchObject({
      type: "enum",
      default: "其他",
    });
    expect(
      schema.category &&
        typeof schema.category === "object" &&
        schema.category.enumValues,
    ).toEqual(["餐饮", "交通", "购物", "娱乐", "医疗", "其他"]);
    expect(schema.spent_at).toMatchObject({ type: "date", default: "today" });
    expect(schema.note).toMatchObject({ type: "string", required: false });
    // number 全链结构位：amount 参数恰为单一 input 引用（DIRECT_INPUT_REF
    // 原生直通），SQL 不再依赖 CAST
    const insert = json!.nodes.find(
      (n) => n.id === "insert-expense" && n.kind === "database",
    );
    expect(insert && insert.kind === "database" && insert.sql).not.toContain(
      "CAST",
    );
    expect(insert && insert.kind === "database" ? insert.params[0] : "").toBe(
      "{{input.amount}}",
    );
    // 入口归一端到端（number 保型 + default 填充 + date today）
    const normalized = normalizeGraphInputs(
      parseInputSchema(schema as Record<string, unknown>),
      { amount: 35.5 },
    );
    expect(normalized).toEqual({
      ok: true,
      inputs: {
        amount: 35.5,
        category: "其他",
        note: "",
        spent_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      },
    });
  });

  it("查账明细 limit 钳制 0..200（负值零行、超大截断）", () => {
    const { json } = loadGraph("expense-query.json");
    const select = json!.nodes.find(
      (n) => n.id === "select-expenses" && n.kind === "database",
    );
    const sql = select && select.kind === "database" ? select.sql : "";
    expect(sql).toContain(
      "LIMIT MAX(0, MIN(CAST(COALESCE(NULLIF(?, ''), '5') AS INTEGER), 200))",
    );
  });

  it("查账明细终点组装 show_table 结构（merge 模板直嵌行集 JSON）", () => {
    const { json } = loadGraph("expense-query.json");
    const build = json!.nodes.find((n) => n.id === "build-table");
    const template = build!.kind === "merge" ? build!.template : "";
    expect(template).toContain('"rows":{{nodes.select-expenses.output}}');
    expect(template).toContain('"columns"');
    expect(template).toContain("支出明细");
  });

  it("月度汇总终点组装三段载荷（summary/byCategory/trend），标量经 jsonParse 提取", () => {
    const { json } = loadGraph("expense-summary.json");
    const build = json!.nodes.find((n) => n.id === "build-payload");
    const template = build!.kind === "merge" ? build!.template : "";
    expect(template).toContain('"summary"');
    expect(template).toContain(
      '"byCategory":{{nodes.summary-by-category.output}}',
    );
    expect(template).toContain('"trend":{{nodes.trend-6m.output}}');
    expect(template).toContain("{{nodes.parse-total.output}}");
    // 标量提取三节点（path 0.x）+ 趋势聚合节点
    const parseIds = json!.nodes
      .filter((n) => n.kind === "jsonParse")
      .map((n) => (n.kind === "jsonParse" ? `${n.id}:${n.path}` : ""));
    expect(parseIds).toEqual(
      expect.arrayContaining([
        "parse-total:0.total",
        "parse-cnt:0.cnt",
        "parse-avg:0.avg_amount",
      ]),
    );
    const trend = json!.nodes.find((n) => n.id === "trend-6m");
    expect(trend!.kind === "database" && trend!.sql).toContain(
      "-5 month', 'start of month'",
    );
  });
});

describe("组装等价（去 code 化：merge/jsonParse 路线与旧 code 组装输出结构一致）", () => {
  /** renderNodePrompt 的 nodes 引用子集模拟（merge 模板只用了 nodes.*.output） */
  const renderTemplate = (
    template: string,
    outputs: Record<string, string>,
  ): string =>
    template.replace(
      /\{\{nodes\.([a-z0-9-]+)\.output\}\}/g,
      (_, id: string) => outputs[id] ?? "",
    );

  it("查账明细：merge 直嵌行集 = 旧 code 组装的 columns/rows 结构（note null 保留为唯一差异点，备案）", () => {
    const fixtureRows = [
      { spent_at: "2026-10-28", category: "餐饮", amount: 35, note: "午饭" },
      { spent_at: "2026-10-27", category: "交通", amount: 12.5, note: null },
    ];
    // database 节点 formatDbResult：SELECT 行集紧凑 JSON
    const selectOutput = JSON.stringify(fixtureRows);
    const { json } = loadGraph("expense-query.json");
    const build = json!.nodes.find((n) => n.id === "build-table");
    const template = build!.kind === "merge" ? build!.template : "";
    const assembled = JSON.parse(
      renderTemplate(template, { "select-expenses": selectOutput }),
    );
    expect(assembled.title).toBe("支出明细");
    expect(assembled.columns).toEqual([
      { key: "spent_at", label: "日期" },
      { key: "category", label: "类别" },
      { key: "amount", label: "金额" },
      { key: "note", label: "备注" },
    ]);
    // 行集原样透传（旧 code 版 note null→""；新版保留 null 渲染 —）
    expect(assembled.rows).toEqual(fixtureRows);
    expect(assembled.rows[1].note).toBeNull();
    // 产出物可整体作为 show_table 入参（单元格仅标量）
    for (const row of assembled.rows) {
      for (const value of Object.values(row)) {
        expect(
          value === null ||
            ["string", "number", "boolean"].includes(typeof value),
        ).toBe(true);
      }
    }
  });

  it("月度汇总：jsonParse 标量 + merge 三段载荷（summary items 形状与 byCategory/trend 原样透传）", () => {
    const byCategory = JSON.stringify([
      { category: "餐饮", cnt: 3, total: 95.5 },
      { category: "交通", cnt: 2, total: 28 },
    ]);
    const trend = JSON.stringify([
      { month: "2026-05", total: 120 },
      { month: "2026-06", total: 88 },
    ]);
    const { json } = loadGraph("expense-summary.json");
    const build = json!.nodes.find((n) => n.id === "build-payload");
    const template = build!.kind === "merge" ? build!.template : "";
    // jsonParse 数值标量输出为紧凑 JSON（"123.5"/"5"）
    const payload = JSON.parse(
      renderTemplate(template, {
        "parse-total": "123.5",
        "parse-cnt": "5",
        "parse-avg": "24.7",
        "summary-by-category": byCategory,
        "trend-6m": trend,
      }),
    );
    expect(payload.summary.title).toBe("月度汇总");
    expect(payload.summary.items[0]).toEqual({
      label: "总支出",
      value: "¥123.5",
    });
    expect(payload.summary.items[1]).toEqual({
      label: "笔数",
      value: "5",
      hint: "平均 ¥24.7",
    });
    expect(payload.byCategory).toEqual(JSON.parse(byCategory));
    expect(payload.trend).toEqual(JSON.parse(trend));
  });
});

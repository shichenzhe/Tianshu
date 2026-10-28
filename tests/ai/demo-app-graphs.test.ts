// tests/ai/demo-app-graphs.test.ts
/**
 * docs/demo-app 记账 demo 工作流定义守护：四份 JSON 须过 validateGraph
 * （可导入性——create_workflow 与画布保存共用同一校验口），且关键结构
 * 不漂移：database 节点 sqlitePath 一律锚定工作空间相对路径 demo.db
 * （db-client 界内守卫决定，写死绝对路径必跑挂）、DDL 幂等、SQL 值全部
 * 参数化（模板占位只出现在 params，不内插进 SQL 字面量）、终点 code
 * 节点组装 show_table/show_summary 结构。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateGraph } from "../../src-react/domains/ai/orchestration/api/graph.schema";

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

  it("查账明细终点组装 show_table 结构（columns/rows + JSON.stringify）", () => {
    const { json } = loadGraph("expense-query.json");
    const build = json!.nodes.find((n) => n.id === "build-table");
    const script = build!.kind === "code" ? build!.script : "";
    expect(script).toContain("{{nodes.select-expenses.output}}");
    expect(script).toContain("columns");
    expect(script).toContain("rows");
    expect(script).toContain("JSON.stringify");
  });

  it("月度汇总终点组装 show_summary 结构（items），两段聚合串行", () => {
    const { json } = loadGraph("expense-summary.json");
    const build = json!.nodes.find((n) => n.id === "build-summary");
    const script = build!.kind === "code" ? build!.script : "";
    expect(script).toContain("{{nodes.summary-total.output}}");
    expect(script).toContain("{{nodes.summary-by-category.output}}");
    expect(script).toContain("items");
    expect(json!.edges.map((e) => `${e.from}->${e.to}`)).toEqual(
      expect.arrayContaining([
        "start->summary-total",
        "summary-total->summary-by-category",
        "summary-by-category->build-summary",
      ]),
    );
  });
});

// tests/ai/display-tools.test.ts
/**
 * show_table / show_summary 内置展示工具（聊天消息流结构化结果卡）：
 * - 参数 schema：show_table columns 必填（key/label）、rows 单元格仅标量；
 *   show_summary items 必填（label/value，hint 可选）
 * - kind=read（渲染层消费 args，无文件/系统副作用，免审批）
 * - execute 返回确认文本回喂模型（不抛出）
 */
import { describe, expect, it } from "vitest";
import {
  makeShowSummaryTool,
  makeShowTableTool,
  SHOW_SUMMARY_TOOL_NAME,
  SHOW_TABLE_TOOL_NAME,
} from "../../electron/domains/ai/agent/display-tools";

describe("show_table 工具", () => {
  const tool = makeShowTableTool();

  it("命名与 kind：show_table / read（免审批）", () => {
    expect(tool.name).toBe(SHOW_TABLE_TOOL_NAME);
    expect(tool.kind).toBe("read");
  });

  it("参数 schema：columns/rows 合法载荷通过（单元格仅标量）", () => {
    expect(
      tool.parameters.safeParse({
        title: "支出明细",
        columns: [
          { key: "amount", label: "金额" },
          { key: "note", label: "备注" },
        ],
        rows: [
          { amount: 35, note: "午饭" },
          { amount: 12.5, note: null, extra: true },
        ],
      }).success,
    ).toBe(true);
    expect(
      tool.parameters.safeParse({
        columns: [{ key: "a", label: "A" }],
        rows: [],
      }).success,
    ).toBe(true);
  });

  it("参数 schema：columns 缺失/空、单元格对象值、key 缺失均拒绝", () => {
    expect(tool.parameters.safeParse({ rows: [{ a: 1 }] }).success).toBe(false);
    expect(tool.parameters.safeParse({ columns: [], rows: [] }).success).toBe(
      false,
    );
    expect(
      tool.parameters.safeParse({
        columns: [{ label: "A" }],
        rows: [],
      }).success,
    ).toBe(false);
    // 单元格值为对象/数组：拒收（渲染层不猜嵌套结构）
    expect(
      tool.parameters.safeParse({
        columns: [{ key: "a", label: "A" }],
        rows: [{ a: { nested: 1 } }],
      }).success,
    ).toBe(false);
  });

  it("execute 返回确认文本（含标题与规模），不抛出", async () => {
    const ctx = { workspacePath: "/ws", sessionId: 1 };
    const result = await tool.execute(ctx, {
      title: "支出明细",
      columns: [
        { key: "amount", label: "金额" },
        { key: "note", label: "备注" },
      ],
      rows: [{ amount: 35, note: "午饭" }],
    });
    expect(result).toContain("已渲染表格");
    expect(result).toContain("支出明细");
    expect(result).toContain("1 行");
  });
});

describe("show_summary 工具", () => {
  const tool = makeShowSummaryTool();

  it("命名与 kind：show_summary / read（免审批）", () => {
    expect(tool.name).toBe(SHOW_SUMMARY_TOOL_NAME);
    expect(tool.kind).toBe("read");
  });

  it("参数 schema：items 必填（label/value，hint 可选、value 可数值）", () => {
    expect(
      tool.parameters.safeParse({
        title: "月度汇总",
        items: [
          { label: "总支出", value: "¥123.5" },
          { label: "笔数", value: 12, hint: "平均 ¥10.3" },
        ],
      }).success,
    ).toBe(true);
    expect(
      tool.parameters.safeParse({ items: [{ label: "总支出", value: 0 }] })
        .success,
    ).toBe(true);
  });

  it("参数 schema：items 缺失/空、value 对象均拒绝", () => {
    expect(tool.parameters.safeParse({}).success).toBe(false);
    expect(tool.parameters.safeParse({ items: [] }).success).toBe(false);
    expect(
      tool.parameters.safeParse({
        items: [{ label: "总支出", value: { v: 1 } }],
      }).success,
    ).toBe(false);
  });

  it("execute 返回确认文本（含标题与指标数），不抛出", async () => {
    const ctx = { workspacePath: "/ws", sessionId: 1 };
    const result = await tool.execute(ctx, {
      title: "月度汇总",
      items: [
        { label: "总支出", value: "¥123.5" },
        { label: "笔数", value: 12 },
      ],
    });
    expect(result).toContain("已渲染摘要");
    expect(result).toContain("月度汇总");
    expect(result).toContain("2 项指标");
  });
});

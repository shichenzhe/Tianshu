/**
 * show_table / show_summary 内置展示工具（聊天消息流结构化结果卡）：
 * 模型拿到工作流查询结果（run_workflow + get_workflow_run）后，把表格/
 * 摘要结构经参数传入，渲染层在消息流以原生 React 卡片呈现
 * （TableViewCard/SummaryCard，recommend_experts 先例——不走 iframe 沙箱）。
 * 无文件/系统副作用（渲染层消费 args）→ kind:"read" 免审批；execute 仅
 * 返回确认文本回喂模型。纯 Node 实现（禁止 import electron），vitest 直测
 * （先例 widget-tool）。工具名与渲染层 group-blocks.ts 双份定义约定。
 */
import { z } from "zod";
import type { ToolDefinition } from "./file-tools";
import {
  SHOW_CHART_TOOL_NAME,
  SHOW_SUMMARY_TOOL_NAME,
  SHOW_TABLE_TOOL_NAME,
} from "../../../../src-react/domains/ai/chat/lib/group-blocks";

export { SHOW_CHART_TOOL_NAME, SHOW_SUMMARY_TOOL_NAME, SHOW_TABLE_TOOL_NAME };

/** 表格行单元格值：仅标量（对象/数组拒收——渲染层不猜嵌套结构） */
const cellValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

const showTableArgsSchema = z.object({
  /** 卡片标题（渲染头展示，缺省用渲染层默认标题） */
  title: z.string().max(120).optional(),
  /** 列定义：key=行内字段名，label=表头文案 */
  columns: z
    .array(
      z.object({
        key: z.string().min(1).max(64),
        label: z.string().min(1).max(60),
      }),
    )
    .min(1)
    .max(20),
  /** 数据行（空数组渲染空态卡；单元格值仅标量） */
  rows: z.array(z.record(z.string(), cellValueSchema)).max(200),
});

export type ShowTableToolArgs = z.infer<typeof showTableArgsSchema>;

const showSummaryArgsSchema = z.object({
  /** 卡片标题（渲染头展示，缺省用渲染层默认标题） */
  title: z.string().max(120).optional(),
  /** 指标条目：label 左、value 右，hint 为补充说明（金额单位/口径等） */
  items: z
    .array(
      z.object({
        label: z.string().min(1).max(60),
        value: z.union([z.string(), z.number()]),
        hint: z.string().max(120).optional(),
      }),
    )
    .min(1)
    .max(12),
});

export type ShowSummaryToolArgs = z.infer<typeof showSummaryArgsSchema>;

const chartSeriesSchema = z.object({
  /** 系列名（图例/直接标注） */
  name: z.string().min(1).max(60),
  /** 与 labels 等长的数值序列（有限数） */
  values: z.array(z.number().finite()).max(200),
});

const showChartArgsSchema = z
  .object({
    /** 卡片标题（渲染头展示，缺省用渲染层默认标题） */
    title: z.string().max(120).optional(),
    /** line=趋势（随时间变化）；bar=量级对比 */
    chartType: z.enum(["line", "bar"]),
    /** 横轴刻度标签（月份/类别名） */
    labels: z.array(z.string().min(1).max(40)).min(1).max(200),
    /** 数据系列（1-3；颜色按固定次序分配不循环） */
    series: z.array(chartSeriesSchema).min(1).max(3),
  })
  .superRefine((args, ctx) => {
    for (const [index, series] of args.series.entries()) {
      if (series.values.length !== args.labels.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["series", index, "values"],
          message: `第 ${index + 1} 个系列的数值数量须与 labels 一致（${args.labels.length}）`,
        });
      }
    }
  });

export type ShowChartToolArgs = z.infer<typeof showChartArgsSchema>;

export function makeShowTableTool(): ToolDefinition<ShowTableToolArgs> {
  return {
    name: SHOW_TABLE_TOOL_NAME,
    description:
      "在消息流渲染数据表格卡。run_workflow 查询拿到行集结果后调用本工具（勿用 Markdown 表格替代）：columns 声明列（key=行内字段名），rows 每行单元格仅传标量值",
    parameters: showTableArgsSchema,
    kind: "read",
    execute: async (_ctx, args) =>
      `已渲染表格${args.title ? `「${args.title}」` : ""}（${args.columns.length} 列 × ${args.rows.length} 行，用户可在消息流中查看）。`,
  };
}

export function makeShowChartTool(): ToolDefinition<ShowChartToolArgs> {
  return {
    name: SHOW_CHART_TOOL_NAME,
    description:
      "在消息流渲染图表卡（手绘 SVG，无外部库）。line 表趋势（月度走势等随序变化）、bar 表量级对比（分类金额等）；工作流聚合出的趋势/对比数据用本工具呈现，labels 为横轴标签、每个系列 values 与 labels 等长",
    parameters: showChartArgsSchema,
    kind: "read",
    execute: async (_ctx, args) =>
      `已渲染${args.chartType === "line" ? "折线" : "柱状"}图${args.title ? `「${args.title}」` : ""}（${args.series.length} 个系列 × ${args.labels.length} 个刻度，用户可在消息流中查看）。`,
  };
}

export function makeShowSummaryTool(): ToolDefinition<ShowSummaryToolArgs> {
  return {
    name: SHOW_SUMMARY_TOOL_NAME,
    description:
      "在消息流渲染摘要卡（键值指标清单）。工作流聚合结果（总计/笔数/分类占比等）用本工具呈现：每项 label+value，补充说明放 hint",
    parameters: showSummaryArgsSchema,
    kind: "read",
    execute: async (_ctx, args) =>
      `已渲染摘要${args.title ? `「${args.title}」` : ""}（${args.items.length} 项指标，用户可在消息流中查看）。`,
  };
}

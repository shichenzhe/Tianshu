/**
 * 展示工具三件（F2 2026-10-29）：show_table/show_summary/show_chart 自
 * mirror electron/domains/ai/agent/display-tools.ts 移植（kind=read 免审
 * 批，execute 仅回确认文本）。渲染发生在客户端：远程桌面单 UI 走 mirror
 * 渲染端现成组件（TableViewCard/SummaryCard/ChartViewCard，分流结构层
 * group-blocks 共享约定）；移动端 group-blocks 已随行同步分流、渲染组件
 * 不存在——条目进 tables/summaries/charts 数组后无消费者，降级不炸
 * （recommend_experts 先例：先分流后补渲染）。工具名与 mirror/mobile
 * 三份同名约定（改名断回喂）。
 */
import { z } from 'zod';
import type { ToolDefinition } from './tool-definition';

export const DISPLAY_TOOL_NAMES = [
  'show_table',
  'show_summary',
  'show_chart',
] as const;

const cellValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

const showTableArgsSchema = z.object({
  title: z.string().max(120).optional(),
  columns: z
    .array(
      z.object({
        key: z.string().min(1).max(64),
        label: z.string().min(1).max(60),
      }),
    )
    .min(1)
    .max(20),
  rows: z.array(z.record(z.string(), cellValueSchema)).max(200),
});

const showSummaryArgsSchema = z.object({
  title: z.string().max(120).optional(),
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

const chartSeriesSchema = z.object({
  name: z.string().min(1).max(60),
  values: z.array(z.number().finite()).max(200),
});

const showChartArgsSchema = z
  .object({
    title: z.string().max(120).optional(),
    chartType: z.enum(['line', 'bar']),
    labels: z.array(z.string().min(1).max(40)).min(1).max(200),
    series: z.array(chartSeriesSchema).min(1).max(3),
  })
  .superRefine((args, ctx) => {
    for (const [index, series] of args.series.entries()) {
      if (series.values.length !== args.labels.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['series', index, 'values'],
          message: `第 ${index + 1} 个系列的数值数量须与 labels 一致（${args.labels.length}）`,
        });
      }
    }
  });

export function makeDisplayTools(): ToolDefinition[] {
  const table: ToolDefinition<z.infer<typeof showTableArgsSchema>> = {
    name: 'show_table',
    description:
      '在消息流渲染数据表格卡。run_workflow 查询拿到行集结果后调用本工具（勿用 Markdown 表格替代）：columns 声明列（key=行内字段名），rows 每行单元格仅传标量值',
    parameters: showTableArgsSchema,
    kind: 'read',
    execute: async (_ctx, args) =>
      `已渲染表格${args.title ? `「${args.title}」` : ''}（${args.columns.length} 列 × ${args.rows.length} 行，用户可在消息流中查看）。`,
  };
  const summary: ToolDefinition<z.infer<typeof showSummaryArgsSchema>> = {
    name: 'show_summary',
    description:
      '在消息流渲染摘要卡（键值指标清单）。工作流聚合结果（总计/笔数/分类占比等）用本工具呈现：每项 label+value，补充说明放 hint',
    parameters: showSummaryArgsSchema,
    kind: 'read',
    execute: async (_ctx, args) =>
      `已渲染摘要${args.title ? `「${args.title}」` : ''}（${args.items.length} 项指标，用户可在消息流中查看）。`,
  };
  const chart: ToolDefinition<z.infer<typeof showChartArgsSchema>> = {
    name: 'show_chart',
    description:
      '在消息流渲染图表卡。line 表趋势（月度走势等随序变化）、bar 表量级对比（分类金额等）；工作流聚合出的趋势/对比数据用本工具呈现，labels 为横轴标签、每个系列 values 与 labels 等长',
    parameters: showChartArgsSchema,
    kind: 'read',
    execute: async (_ctx, args) =>
      `已渲染${args.chartType === 'line' ? '折线' : '柱状'}图${args.title ? `「${args.title}」` : ''}（${args.series.length} 个系列 × ${args.labels.length} 个刻度，用户可在消息流中查看）。`,
  };
  return [table, summary, chart];
}

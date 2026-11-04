/**
 * show_widget 内置工具（聊天面板可视化组件，WorkBuddy 同名工具移植）：
 * 模型输出一段 HTML/JS 代码（widget_code），渲染层在消息流内以隔离
 * iframe 沙箱呈现（WidgetRenderer，srcDoc + CSP，无网络访问）。
 * 本工具无文件/系统副作用（渲染层消费 args）→ kind:"read" 免审批；
 * execute 仅返回确认文本回喂模型。纯 Node 实现（禁止 import electron），
 * vitest 直测（先例 plan-tools）。
 */
import { z } from "zod";
import type { ToolDefinition } from "./file-tools";
import { WIDGET_TOOL_NAME } from "../../../../src-react/domains/ai/chat/lib/group-blocks";

export { WIDGET_TOOL_NAME };

/** widget 代码上限（64KB：超长代码多为例图数据，防巨型 srcDoc 撑爆渲染） */
export const WIDGET_CODE_LIMIT = 64 * 1024;

const widgetArgsSchema = z.object({
  /** 组件标题（渲染头展示） */
  title: z.string().max(120).optional(),
  /** 完整 HTML 片段：可含 <style>/<script>，在隔离 iframe（sandbox
   *  allow-scripts、CSP default-src 'none'）中运行，无网络访问 */
  widget_code: z
    .string()
    .min(1)
    .max(WIDGET_CODE_LIMIT)
    .describe("完整 HTML 片段（可含 style/script）"),
});

export type WidgetToolArgs = z.infer<typeof widgetArgsSchema>;

export function makeWidgetTool(): ToolDefinition<WidgetToolArgs> {
  return {
    name: WIDGET_TOOL_NAME,
    description: "渲染可视化组件到消息流（HTML，沙箱无网络与外部库）",
    parameters: widgetArgsSchema,
    kind: "read",
    execute: async (_ctx, args) =>
      `已渲染组件${args.title ? `「${args.title}」` : ""}（用户可在消息流中查看与交互）。`,
  };
}

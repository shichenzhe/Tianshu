// packages/tianshu-core/src/graph-prompt.ts（GA-T2 自 electron/domains/ai/
// orchestration/graph-prompt.ts 物理搬入，原位改 re-export，老 import 链不变）
/** 节点 prompt 模板渲染（spec §4）：{{input.x}}/{{nodes.<id>.output}}/
 * {{nodes.<id>.errorOutput}}（循环节点死信，未设时抛错）/{{date}}/
 * {{weekday}}/{{time}}；缺引用抛 GraphTemplateError */
import { format } from "date-fns";

const WEEKDAY_ZH = ["一", "二", "三", "四", "五", "六", "日"];
const VAR_RE =
  /\{\{(input\.[A-Za-z0-9_]+|nodes\.[a-z0-9-]+\.(output|errorOutput)|date|weekday|time)\}\}/g;

export class GraphTemplateError extends Error {
  constructor(public varName: string) {
    super(`模板变量未定义: ${varName}`);
    this.name = "GraphTemplateError";
  }
}

export interface PromptRenderContext {
  inputs: Record<string, string>;
  nodes: Record<string, { output: string; errorOutput?: string }>;
  now: Date;
}

export function renderNodePrompt(
  template: string,
  ctx: PromptRenderContext,
): string {
  return template.replace(VAR_RE, (raw, token: string) => {
    if (token === "date") return format(ctx.now, "yyyy-MM-dd");
    if (token === "weekday")
      return WEEKDAY_ZH[(ctx.now.getDay() === 0 ? 7 : ctx.now.getDay()) - 1];
    if (token === "time") return format(ctx.now, "HH:mm");
    if (token.startsWith("input.")) {
      const key = token.slice("input.".length);
      if (!(key in ctx.inputs)) throw new GraphTemplateError(token);
      return ctx.inputs[key];
    }
    const nodeId = token.slice("nodes.".length).split(".")[0];
    const field = token.endsWith(".errorOutput")
      ? ("errorOutput" as const)
      : ("output" as const);
    const entry = ctx.nodes[nodeId];
    const value = entry?.[field];
    if (value === undefined) throw new GraphTemplateError(token);
    return value;
  });
}

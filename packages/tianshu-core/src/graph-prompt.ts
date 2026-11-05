// packages/tianshu-core/src/graph-prompt.ts（GA-T2 自 electron/domains/ai/
// orchestration/graph-prompt.ts 物理搬入，原位改 re-export，老 import 链不变）
/** 节点 prompt 模板渲染（spec §4）：{{input.x}}/{{input.x.fieldx.path}}（
 *  json 容器字段路径——首段为输入键，余段逐层下钻：对象取字段、全数字
 *  段且当前为数组则当下标；中途非容器/缺失/越界同缺引用抛错）/
 *  {{nodes.<id>.output}}/{{nodes.<id>.errorOutput}}（循环节点死信，未设时
 *  抛错）/{{date}}/{{weekday}}/{{time}}；缺引用抛 GraphTemplateError */
import { format } from "date-fns";
import type { GraphInputValue } from "./graph-inputs";

const WEEKDAY_ZH = ["一", "二", "三", "四", "五", "六", "日"];
const VAR_RE =
  /\{\{(input\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*|nodes\.[a-z0-9-]+\.(output|errorOutput)|date|weekday|time)\}\}/g;

export class GraphTemplateError extends Error {
  constructor(public varName: string) {
    super(`模板变量未定义: ${varName}`);
    this.name = "GraphTemplateError";
  }
}

export interface PromptRenderContext {
  /** 输入值（切片 D typed 输入）：模板替换语义保持——number/boolean 经
   *  String() 归一插入（35 → "35"、true → "true"），json 容器紧凑
   *  stringify 插入（{"a":1}——HTTP body 可直拼 {{input.x}} 位），值形态
   *  由入口 normalizeGraphInputs 收口；database 参数的原生类型直通在
   *  执行层做，不经模板 */
  inputs: Record<string, GraphInputValue>;
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
      // 首段为输入键，余段逐层下钻（对象字段/数组数字下标）；顶层引用
      // （无余段）行为与既有语义一致
      const segments = token.slice("input.".length).split(".");
      const head = segments[0];
      if (!(head in ctx.inputs)) throw new GraphTemplateError(token);
      let current: unknown = ctx.inputs[head];
      for (const segment of segments.slice(1)) {
        if (current === null || typeof current !== "object") {
          throw new GraphTemplateError(token);
        }
        const container = current as Record<string, unknown> | unknown[];
        current = Array.isArray(container) && /^\d+$/.test(segment)
          ? container[Number(segment)]
          : (container as Record<string, unknown>)[segment];
        if (current === undefined) {
          throw new GraphTemplateError(token);
        }
      }
      return current !== null && typeof current === "object"
        ? JSON.stringify(current)
        : String(current);
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

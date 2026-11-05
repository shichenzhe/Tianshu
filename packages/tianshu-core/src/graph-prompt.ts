// packages/tianshu-core/src/graph-prompt.ts（GA-T2 自 electron/domains/ai/
// orchestration/graph-prompt.ts 物理搬入，原位改 re-export，老 import 链不变）
/** 节点 prompt 模板渲染（spec §4）：{{input.x}}/{{input.x.field[sub].path}}（
 *  json 容器字段路径——首段为输入键，余段下钻：`.field` 取对象字段、
 *  `[N]` 取数组下标（正交：点号一律字段名、方括号一律下标），中途
 *  非容器/缺失/越界/null 一律抛错——null 不可消费，容器整体 stringify
 *  时内含 null 例外无损保留）/
 *  {{nodes.<id>.output}}/{{nodes.<id>.errorOutput}}（循环节点死信，未设时
 *  抛错）/{{date}}/{{weekday}}/{{time}}；缺引用抛 GraphTemplateError */
import { format } from "date-fns";
import type { GraphInputValue } from "./graph-inputs";

const WEEKDAY_ZH = ["一", "二", "三", "四", "五", "六", "日"];
const VAR_RE =
  /\{\{(input\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+|\[[0-9]+\])*|nodes\.[a-z0-9-]+\.(output|errorOutput)|date|weekday|time)\}\}/g;

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
      // 首段为输入键，余段下钻（VAR_RE 已保证形态：.field 或 [N]）；
      // 正交语义：点号一律字段名（含数字键）、方括号一律数组下标；
      // 顶层引用（无余段）行为与既有语义一致
      const segments = [
        ...token
          .slice("input".length)
          .matchAll(/\.([A-Za-z0-9_]+)|\[([0-9]+)\]/g),
      ];
      const head = segments[0]?.[1];
      if (head === undefined || !(head in ctx.inputs)) {
        throw new GraphTemplateError(token);
      }
      let current: unknown = ctx.inputs[head];
      for (const segment of segments.slice(1)) {
        if (segment[2] !== undefined) {
          if (!Array.isArray(current)) {
            throw new GraphTemplateError(token);
          }
          current = current[Number(segment[2])];
        } else {
          if (
            current === null ||
            typeof current !== "object" ||
            Array.isArray(current)
          ) {
            throw new GraphTemplateError(token);
          }
          current = (current as Record<string, unknown>)[segment[1] as string];
        }
        if (current === undefined) {
          throw new GraphTemplateError(token);
        }
      }
      // 解析结果为 null 一律不可消费（顶层次之/中途/叶子三层次统一）：
      // 插入字面 "null" 文本会在 HTTP body 等场景产出字符串 "null" 而非
      // JSON null——坏数据不如缺引用可发现；容器整体 stringify 时内含
      // null 合法（JSON 文本一部分，无损保留），不经此判定
      if (current === null) {
        throw new GraphTemplateError(token);
      }
      return typeof current === "object"
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

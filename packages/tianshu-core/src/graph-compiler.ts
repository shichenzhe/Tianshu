/** GraphJson → LangGraph StateGraph（spec §3）：nodes reducer merge、
 * route 驱动条件边；recursionLimit 兜底环。
 * GA-T2 自 electron/domains/ai/orchestration/graph-compiler.ts 物理搬入
 * @tianshu/core，原位改 re-export，老 import 链不变。
 * API 以 @langchain/langgraph@1.4.18 d.ts 为准：
 * - addEdge(START, 入口) 直连合法（setEntryPoint 已废弃并推荐此法），无需 __entry__ 空节点
 * - recursionLimit 属 invoke 的 RunnableConfig，非 compile 选项——故返回 { graph, config }
 * - 图内 END 常量为 "__end__"，GraphJson 的 to 哨兵是 "END"，挂边时须翻译
 * - 未写入的 LastValue 通道读取得 undefined（不抛错），route 缺省或未映射均走 __fallback__ */
import { END, START, StateGraph, Annotation } from "@langchain/langgraph";
import type { GraphJson } from "./graph-schema";

export const GRAPH_RECURSION_LIMIT = 25;

export interface NodeResult {
  output: string;
  /** 循环节点死信（onItemError=continue 的失败项清单），下游经
   * {{nodes.<id>.errorOutput}} 引用落侧文件 */
  errorOutput?: string;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface GraphRunState {
  inputs: Record<string, string>;
  nodes: Record<string, NodeResult>;
  route?: string;
}

export type NodeHandler = (
  state: GraphRunState,
) => Promise<Partial<GraphRunState>>;

export interface EdgePlan {
  direct: Array<{ from: string; to: string }>;
  conditional: Array<{ from: string; mapping: Record<string, string> }>;
}

/** 编译产物：compiled graph + invoke 所需 config（recursionLimit 属此层）；
 * graph 类型由 assembleGraph 推断（reducer 通道的 update 含 OverwriteValue，手写泛型对不上） */
export interface CompiledGraph {
  graph: ReturnType<typeof assembleGraph>;
  config: { recursionLimit: number };
}

const ROUTE_FALLBACK = "__fallback__";
const END_SENTINEL = "END";

const GraphState = Annotation.Root({
  inputs: Annotation<Record<string, string>>(),
  nodes: Annotation<Record<string, NodeResult>>({
    reducer: (prev, next) => ({ ...prev, ...next }),
    default: () => ({}),
  }),
  route: Annotation<string | undefined>(),
});

/** 纯函数：直连边原样保留；条件边按 from 聚合成 route 值 → 目标映射 */
export function buildEdgePlan(json: GraphJson): EdgePlan {
  const direct: EdgePlan["direct"] = [];
  const conditional = new Map<string, Record<string, string>>();
  for (const edge of json.edges) {
    if (edge.condition) {
      const mapping = conditional.get(edge.from) ?? {};
      mapping[edge.condition.value] = edge.to;
      conditional.set(edge.from, mapping);
    } else {
      direct.push({ from: edge.from, to: edge.to });
    }
  }
  return {
    direct,
    conditional: [...conditional.entries()].map(([from, mapping]) => ({
      from,
      mapping,
    })),
  };
}

/** "END" 哨兵翻译为 LangGraph 的 END（"__end__"），否则为节点 id */
function toDestination(to: string): string {
  return to === END_SENTINEL ? END : to;
}

/** 唯一入口 = 无入边节点恰 1 个（与 validateGraph 的保存期校验同规） */
function findEntryNode(json: GraphJson) {
  const noIncoming = json.nodes.filter(
    (n) => !json.edges.some((e) => e.to === n.id),
  );
  if (noIncoming.length !== 1) {
    throw new Error(
      `graph_invalid: 图须有唯一入口节点，当前无入边节点 ${noIncoming.length} 个`,
    );
  }
  return noIncoming[0];
}

function buildNodeActions(
  json: GraphJson,
  handlers: Record<string, NodeHandler>,
) {
  const nodeActions: Record<string, NodeHandler> = {};
  for (const node of json.nodes) {
    const handler = handlers[node.id];
    if (!handler) {
      throw new Error(`graph_invalid: 节点缺执行器: ${node.id}`);
    }
    nodeActions[node.id] = handler;
  }
  return nodeActions;
}

function assembleGraph(json: GraphJson, handlers: Record<string, NodeHandler>) {
  const entry = findEntryNode(json);
  const { direct, conditional } = buildEdgePlan(json);
  const graph = new StateGraph(GraphState)
    .addNode(buildNodeActions(json, handlers))
    .addEdge(START, entry.id);
  for (const edge of direct) {
    graph.addEdge(edge.from, toDestination(edge.to));
  }
  for (const { from, mapping } of conditional) {
    const pathMap: Record<string, string> = { [ROUTE_FALLBACK]: END };
    for (const [value, to] of Object.entries(mapping)) {
      pathMap[value] = toDestination(to);
    }
    graph.addConditionalEdges(
      from,
      // route 未映射（含运行期脏值）回落 __fallback__→END：LangGraph 对
      // pathMap 查不到的返回值按「不存在节点名」报错会炸整图，兜底走 END
      (state: GraphRunState) => {
        const route = state.route ?? ROUTE_FALLBACK;
        return pathMap[route] !== undefined ? route : ROUTE_FALLBACK;
      },
      pathMap,
    );
  }
  return graph.compile();
}

export function compileStateGraph(
  json: GraphJson,
  handlers: Record<string, NodeHandler>,
): CompiledGraph {
  return {
    graph: assembleGraph(json, handlers),
    config: { recursionLimit: GRAPH_RECURSION_LIMIT },
  };
}

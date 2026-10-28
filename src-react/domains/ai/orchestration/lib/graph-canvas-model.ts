/**
 * 画布模型纯函数（spec §5）：GraphJson ⇄ ReactFlow 展示模型双向映射、
 * 连线规则、分层自动布局。组件零状态逻辑，全部可测。
 */
import {
  isLlmNode,
  type GraphEdge,
  type GraphJson,
  type GraphNode,
  type ImageGenNode,
} from "../api/graph.schema";
import type { NodeKind } from "./graph-editor-model";

export const END_NODE_ID = "__end__";

export interface CanvasNode {
  id: string;
  kind: NodeKind;
  name: string;
  modelId?: number;
  /** imageGen 协议（comfyui 态卡片摘要直显服务商名） */
  protocol?: ImageGenNode["protocol"];
  /** imageGen comfyui 态绑定的服务商 id */
  providerId?: number;
  language?: string;
  /** http 节点摘要（卡片直显） */
  method?: string;
  url?: string;
  /** fileRead 节点摘要 */
  path?: string;
  /** notify 节点摘要 */
  title?: string;
  /** subflow/iterate 节点引用的子图 id */
  graphId?: number;
  /** librarySearch 节点检索词 */
  keywords?: string;
  /** jsonParse/jsonStringify 来源表达式摘要 */
  source?: string;
  /** delay 节点秒数摘要 */
  seconds?: number;
  /** vectorize/vectorSearch 集合名与检索词摘要 */
  collection?: string;
  query?: string;
  /** database 节点引擎摘要 */
  engine?: string;
  branchOptions?: string[];
  isEntry: boolean;
  position: { x: number; y: number };
}

export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  /** 源 handle 锚点（branch 节点条件边 → `branch:<value>`）。缺省时 RF
   * getHandle 取源节点第一个 handle——无条件边/条件越界（校验失败态）靠
   * 此 bounds[0] 兜底保持边可见（越界 id 匹配不到 handle 反致 error008） */
  sourceHandle?: string;
}

type XY = { x: number; y: number };

/** 节点摘要字段（卡片直显）：按 kind 取专属字段 */
function summaryOf(n: GraphNode): Partial<CanvasNode> {
  if (isLlmNode(n)) {
    return { modelId: n.modelId };
  }
  switch (n.kind) {
    case "start":
      return {};
    case "http":
      return { method: n.method, url: n.url };
    case "code":
      return { language: n.language };
    case "fileRead":
      return { path: n.path };
    case "notify":
      return { title: n.title };
    case "subflow":
    case "iterate":
      return { graphId: n.graphId };
    case "librarySearch":
      return { keywords: n.keywords };
    case "jsonParse":
      return { source: n.source };
    case "jsonStringify":
      return { source: n.source };
    case "condition":
      return {
        branchOptions: [
          ...n.branches.map((b) => b.name),
          ...(n.fallback ? [n.fallback] : []),
        ],
      };
    case "intent":
      return {
        branchOptions: [
          ...n.intents.map((intent) => intent.name),
          ...(n.fallback ? [n.fallback] : []),
        ],
      };
    case "fileWrite":
    case "docExtract":
      return { path: n.path };
    case "imageGen":
      return {
        modelId: n.modelId,
        protocol: n.protocol,
        providerId: n.providerId,
      };
    case "delay":
      return { seconds: n.seconds };
    case "vectorize":
      return { collection: n.collection };
    case "vectorSearch":
      return { collection: n.collection, query: n.searchQuery };
    case "database":
      return { engine: n.engine };
    case "excelRead":
      return { path: n.path };
    case "excelWrite":
      return { path: n.path };
    case "csvRead":
    case "csvWrite":
      return { path: n.path };
    case "variable":
      return {};
    case "aggregate":
      return {};
    case "email":
      return {};
    case "merge":
      return {};
  }
}

/** 拓扑分层（BFS）：层距 320 / 层内距 140，起点 {80,80}；环按首达层放置 */
export function autoLayout(json: GraphJson): Record<string, XY> {
  const incoming = new Map<string, string[]>();
  for (const n of json.nodes) incoming.set(n.id, []);
  for (const e of json.edges) {
    if (e.to !== "END") incoming.get(e.to)?.push(e.from);
  }
  const layer = new Map<string, number>();
  let frontier = json.nodes
    .filter((n) => (incoming.get(n.id) ?? []).length === 0)
    .map((n) => n.id);
  if (frontier.length === 0 && json.nodes.length > 0) {
    frontier = [json.nodes[0].id]; // 纯环图：任取起点破环
  }
  let depth = 0;
  const seen = new Set<string>();
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      layer.set(id, depth);
      for (const e of json.edges) {
        if (e.from === id && e.to !== "END" && !seen.has(e.to)) next.push(e.to);
      }
    }
    frontier = next;
    depth += 1;
  }
  const perLayer = new Map<number, number>();
  const out: Record<string, XY> = {};
  for (const n of json.nodes) {
    const d = layer.get(n.id) ?? 0;
    const slot = perLayer.get(d) ?? 0;
    perLayer.set(d, slot + 1);
    out[n.id] = { x: 80 + d * 320, y: 80 + slot * 140 };
  }
  return out;
}

/** 装载布局：有 position 用之，缺失经 autoLayout 补齐 */
export function layoutOf(json: GraphJson): Record<string, XY> {
  const fallback = autoLayout(json);
  const out: Record<string, XY> = {};
  for (const n of json.nodes) {
    out[n.id] = n.position ?? fallback[n.id] ?? { x: 80, y: 80 };
  }
  return out;
}

export function toCanvas(
  json: GraphJson,
  layouts: Record<string, XY>,
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const hasIncoming = new Set(json.edges.map((e) => e.to));
  const nodes: CanvasNode[] = json.nodes.map((n) => ({
    id: n.id,
    kind: n.kind,
    name: n.name,
    ...summaryOf(n),
    // 分支选项与 kind 无关（llm/code 可 branch，其余无输出模式）
    ...((n.kind === "llm" || n.kind === "code") && n.outputMode === "branch"
      ? { branchOptions: n.branchOptions ?? [] }
      : {}),
    isEntry: !hasIncoming.has(n.id),
    position: layouts[n.id] ?? { x: 80, y: 80 },
  }));
  // END 虚拟节点常驻（非「有 END 边才出现」）：终点声明依赖先有 END
  // 节点可连——条件式渲染会造成新图无从创建第一条 END 边的鸡生蛋；
  // 拖拽落点持久化在 json.endPosition（布局元数据），缺省自动摆右缘
  nodes.push({
    id: END_NODE_ID,
    kind: "code",
    name: "END",
    isEntry: false,
    position: json.endPosition ??
      layouts[END_NODE_ID] ?? {
        x: 80 + (Object.keys(layouts).length + 1) * 320,
        y: 80,
      },
  });
  // 条件边锚定源 branch handle（id 与 NodeCard 渲染的 `branch:<value>` 对齐）；
  // 无条件边/条件越界不锚定——RF getHandle 缺 id 取第一 handle 兜底
  const branchOptionsOf = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.branchOptions) branchOptionsOf.set(n.id, n.branchOptions);
  }
  const edges: CanvasEdge[] = json.edges.map((e) => {
    const to = e.to === "END" ? END_NODE_ID : e.to;
    const label = e.condition?.value;
    return {
      id: `${e.from}->${to}:${label ?? ""}`,
      from: e.from,
      to,
      ...(label ? { label } : {}),
      ...(label && branchOptionsOf.get(e.from)?.includes(label)
        ? { sourceHandle: `branch:${label}` }
        : {}),
    };
  });
  return { nodes, edges };
}

export function applyPositions(
  json: GraphJson,
  positions: Record<string, XY>,
): GraphJson {
  // END 虚拟节点落点写图级 endPosition（不在 nodes 内，执行器忽略）
  const endPosition = positions[END_NODE_ID];
  return {
    ...json,
    ...(endPosition ? { endPosition } : {}),
    nodes: json.nodes.map((n) =>
      positions[n.id] ? { ...n, position: positions[n.id] } : n,
    ),
  };
}

/** 边 id ⇄ GraphJson 边还原（onRemoveEdge 消费方使用）：id 形如
 * `${from}->${to}:${label}`（toCanvas 生成），to 为 END 虚拟节点时还原
 * "END"。节点 id 限 kebab-case（无 ">"":"），首个 "->"/":" 即分隔符，
 * label 含特殊字符不破坏解析 */
export function edgeIdToRef(id: string): {
  from: string;
  to: string;
  label?: string;
} {
  const arrow = id.indexOf("->");
  const rest = id.slice(arrow + 2);
  const colon = rest.indexOf(":");
  const to = rest.slice(0, colon);
  const label = rest.slice(colon + 1);
  return {
    from: id.slice(0, arrow),
    to: to === END_NODE_ID ? "END" : to,
    ...(label ? { label } : {}),
  };
}

export function connectEdge(
  json: GraphJson,
  conn: { source: string; sourceHandle: string; target: string },
): GraphJson | null {
  if (conn.source === conn.target) return null;
  const to = conn.target === END_NODE_ID ? "END" : conn.target;
  const branchMatch = /^branch:(.+)$/.exec(conn.sourceHandle ?? "");
  const next: GraphEdge = branchMatch
    ? {
        from: conn.source,
        to,
        condition: { type: "branch" as const, value: branchMatch[1] },
      }
    : { from: conn.source, to };
  const dup = json.edges.some(
    (e) =>
      e.from === next.from &&
      e.to === next.to &&
      (e.condition?.value ?? "") === (next.condition?.value ?? ""),
  );
  if (dup) return null;
  return { ...json, edges: [...json.edges, next] };
}

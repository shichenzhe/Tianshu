// src-react/domains/ai/orchestration/lib/graph-ai-ops.ts
/**
 * 图 AI 变更单：AI 局部改图时的结构化操作集（方案 D「变更单形态」）。
 * - graphChangeSetSchema：zod discriminated union，AI 回复 ```json 块的
 *   解析契约（extractGraphEdit 先按它试，再按全量 graphJsonSchema）。
 * - applyGraphOps：按 ops 顺序折叠到当前图；每步前置校验（节点存在性、
 *   边合法性、id/kind 不可经补丁篡改），非法即抛 Error——由 GraphEditCard
 *   捕获进「校验失败」态展示，绝不半成品落画布。
 * - mergeSurvivingPositions：全量形态应用前按节点 id 合并坐标——AI 常省略
 *   未改节点的 position，直接替换会打乱用户手工布局（spec 5b）。
 */
import { z } from "zod";
import {
  graphEdgeSchema,
  graphNodeSchema,
  type GraphEdge,
  type GraphJson,
  type GraphNode,
} from "@/domains/ai/orchestration/api/graph.schema";
import { renameNode } from "./graph-editor-model";

export type GraphOp =
  | { op: "addNode"; node: GraphNode }
  | { op: "updateNode"; id: string; patch: Record<string, unknown> }
  | { op: "removeNode"; id: string }
  | { op: "renameNode"; from: string; to: string }
  | { op: "addEdge"; edge: GraphEdge }
  | { op: "removeEdge"; from: string; to: string; conditionValue?: string };

export interface GraphChangeSet {
  ops: GraphOp[];
}

const graphOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("addNode"), node: graphNodeSchema }),
  z.object({
    op: z.literal("updateNode"),
    id: z.string().min(1),
    patch: z.record(z.string(), z.unknown()),
  }),
  z.object({ op: z.literal("removeNode"), id: z.string().min(1) }),
  z.object({
    op: z.literal("renameNode"),
    from: z.string().min(1),
    to: z.string().min(1),
  }),
  z.object({ op: z.literal("addEdge"), edge: graphEdgeSchema }),
  z.object({
    op: z.literal("removeEdge"),
    from: z.string().min(1),
    to: z.string().min(1),
    conditionValue: z.string().optional(),
  }),
]);

export const graphChangeSetSchema: z.ZodType<GraphChangeSet> = z.object({
  ops: z.array(graphOpSchema).min(1),
});

/** 稳定错误码（message = code:detail）：卡片/调用方按码本地化，不裸抛
 *  自然语言串（评审 Minor 9 的 i18n 收口） */
function opError(code: string, detail: string): Error {
  return new Error(`${code}:${detail}`);
}

function nodeOf(graph: GraphJson, id: string): GraphNode {
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) throw opError("node-missing", id);
  return node;
}

function applyOne(graph: GraphJson, op: GraphOp): GraphJson {
  switch (op.op) {
    case "addNode": {
      if (graph.nodes.some((n) => n.id === op.node.id)) {
        throw opError("node-exists", op.node.id);
      }
      return { ...graph, nodes: [...graph.nodes, op.node] };
    }
    case "updateNode": {
      nodeOf(graph, op.id);
      if ("id" in op.patch || "kind" in op.patch) {
        throw opError("id-kind-immutable", op.id);
      }
      return {
        ...graph,
        nodes: graph.nodes.map((n) =>
          n.id === op.id ? ({ ...n, ...op.patch } as GraphNode) : n,
        ),
      };
    }
    case "removeNode": {
      nodeOf(graph, op.id);
      return {
        ...graph,
        nodes: graph.nodes.filter((n) => n.id !== op.id),
        edges: graph.edges.filter((e) => e.from !== op.id && e.to !== op.id),
      };
    }
    case "renameNode": {
      nodeOf(graph, op.from);
      if (graph.nodes.some((n) => n.id === op.to)) {
        throw opError("node-exists", op.to);
      }
      return renameNode(graph, op.from, op.to);
    }
    case "addEdge": {
      const { from, to, condition } = op.edge;
      nodeOf(graph, from);
      nodeOf(graph, to);
      if (from === to) throw opError("edge-self-loop", `${from}→${to}`);
      const duplicated = graph.edges.some(
        (e) =>
          e.from === from &&
          e.to === to &&
          (e.condition?.value ?? null) === (condition?.value ?? null),
      );
      if (duplicated) throw opError("edge-duplicate", `${from}→${to}`);
      return { ...graph, edges: [...graph.edges, op.edge] };
    }
    case "removeEdge": {
      const kept = graph.edges.filter((e) => {
        if (e.from !== op.from || e.to !== op.to) return true;
        return (e.condition?.value ?? undefined) !== op.conditionValue;
      });
      if (kept.length === graph.edges.length) {
        throw opError("edge-missing", `${op.from}→${op.to}`);
      }
      return { ...graph, edges: kept };
    }
  }
}

export function applyGraphOps(graph: GraphJson, ops: GraphOp[]): GraphJson {
  return ops.reduce((current, op) => applyOne(current, op), graph);
}

/** 全量形态应用前的坐标合并（spec 5b）：next 中 id 与 current 相同且
 *  自身未带 position 的节点继承画布现坐标；endPosition 同理。AI 新增
 *  节点无坐标则保持缺省（由 layoutOf 自动摆位）。 */
export function mergeSurvivingPositions(
  current: GraphJson,
  next: GraphJson,
): GraphJson {
  const positions = new Map(
    current.nodes
      .filter((n) => n.position !== undefined)
      .map((n) => [n.id, n.position!]),
  );
  return {
    ...next,
    endPosition: next.endPosition ?? current.endPosition,
    nodes: next.nodes.map((n) =>
      n.position === undefined && positions.has(n.id)
        ? { ...n, position: positions.get(n.id) }
        : n,
    ),
  };
}

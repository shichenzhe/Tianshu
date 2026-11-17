// src-react/domains/ai/orchestration/lib/graph-ai-context.ts
/**
 * 图 AI 对话上下文：注入前缀（指令 + 图快照）与 AI 回复解析。
 * - buildGraphAiInstruction：首条发送注入的固定指令（两种输出形态、
 *   变更单规则、modelId 目录约束）；模型行由代码按 `#${id} ${name}`
 *   格式化（不进 i18n——目录是数据不是文案）。
 * - buildGraphContextPrefix：每次发送注入的「当前图快照」；超 60k 字符
 *   降级为结构摘要（节点 id/kind/name + 边），避免大图爆上下文。
 * - extractGraphEdit：AI 回复解析——先按变更单 schema 试，再按全量
 *   graphJsonSchema；首个命中的 ```json 块胜出，都不合法返回 null。
 */
import {
  graphJsonSchema,
  type GraphJson,
} from "@/domains/ai/orchestration/api/graph.schema";
import { graphChangeSetSchema, type GraphChangeSet } from "./graph-ai-ops";

export type TFunc = (key: string, opts?: Record<string, unknown>) => string;

const AI_KEY = "chat:orchestration.editor.ai";

export interface GraphAiModelRef {
  id: number;
  name: string;
}

function formatModelCatalog(models: GraphAiModelRef[]): string {
  return models.map((m) => `#${m.id} ${m.name}`).join("\n");
}

export function buildGraphAiInstruction(
  t: TFunc,
  models: GraphAiModelRef[],
): string {
  return t(`${AI_KEY}.instruction`, {
    models: formatModelCatalog(models),
  });
}

const INJECT_LIMIT = 60_000;

interface GraphLike {
  nodes: Array<{ id: string; kind: string; name: string }>;
  edges: Array<{ from: string; to: string }>;
}

function summaryOf(graph: GraphLike): string {
  const nodeLines = graph.nodes.map((n) =>
    `${n.id} (${n.kind}) ${n.name}`.trimEnd(),
  );
  const edgeLines = graph.edges.map((e) => `${e.from} -> ${e.to}`);
  return [...nodeLines, ...edgeLines].join("\n");
}

export function buildGraphContextPrefix(
  t: TFunc,
  p: {
    graphName: string;
    description?: string;
    graphJson: string;
    models: GraphAiModelRef[];
    selectedNodeIds?: string[];
  },
): string {
  const selected =
    p.selectedNodeIds && p.selectedNodeIds.length > 0
      ? p.selectedNodeIds.join(", ")
      : t(`${AI_KEY}.prefixSelectedNodes`);
  const base = {
    name: p.graphName,
    description: p.description ?? "",
    models: formatModelCatalog(p.models),
    selected,
  };
  if (p.graphJson.length <= INJECT_LIMIT) {
    return t(`${AI_KEY}.prefixFull`, { ...base, graph: p.graphJson });
  }
  let summary: string;
  let nodeCount = 0;
  let edgeCount = 0;
  try {
    const parsed = JSON.parse(p.graphJson) as GraphLike;
    nodeCount = parsed.nodes?.length ?? 0;
    edgeCount = parsed.edges?.length ?? 0;
    summary = summaryOf(parsed);
  } catch {
    summary = t(`${AI_KEY}.truncatedNote`);
  }
  return t(`${AI_KEY}.prefixSummary`, {
    ...base,
    summary,
    nodeCount,
    edgeCount,
  });
}

export type GraphEditExtraction =
  | { kind: "ops"; changeSet: GraphChangeSet }
  | { kind: "full"; json: GraphJson }
  | null;

const JSON_BLOCK_RE = /```json\s*\n([\s\S]*?)```/g;

export function extractGraphEdit(text: string): GraphEditExtraction {
  for (const match of text.matchAll(JSON_BLOCK_RE)) {
    let raw: unknown;
    try {
      raw = JSON.parse(match[1]);
    } catch {
      continue;
    }
    const ops = graphChangeSetSchema.safeParse(raw);
    if (ops.success) return { kind: "ops", changeSet: ops.data };
    const full = graphJsonSchema.safeParse(raw);
    if (full.success) return { kind: "full", json: full.data };
  }
  return null;
}

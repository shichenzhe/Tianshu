// src-react/domains/ai/automation/components/run-graph-canvas.tsx
/**
 * 运行拓扑画布（spec 2026-11-23 §2 拓扑视图 / 技术路线 1：复用
 * GraphCanvas 只读运行模式）：执行时 graphJsonSnapshot 快照 → 结构
 * 校验 → layoutOf 布局兜底 → 只读 GraphCanvas 渲染；trace 经
 * nodeRunStates 折成节点末次状态（同节点后一 occurrence 覆盖前一）
 * 叠加为状态描边与耗时徽标。快照缺失/损坏渲染轻量降级提示（步骤日志
 * 视图仍可用，视图锁定由 Task 4 容器负责）——跨端缺失编码不同
 * （desktop 省略/null、server 显式 null、键可能缺席），一律按
 * falsy 同判为「无快照」。深交互手势不做 jsdom 深测（spec §7）。
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import GraphCanvas from "@/domains/ai/orchestration/components/GraphCanvas";
import type { TraceEntry } from "@/domains/ai/orchestration/components/GraphRunTraceView";
import type { GraphJson } from "@/domains/ai/orchestration/api/graph.schema";
import { layoutOf } from "@/domains/ai/orchestration/lib/graph-canvas-model";

/** 节点末次运行状态（含 trace 下标导航元数据，Task 4/5 弹框消费） */
export interface NodeRunStateSummary {
  status: TraceEntry["status"];
  durationMs: number;
  /** 该节点最后一次 occurrence 在 trace 中的下标 */
  lastOccurrence: number;
  /** 该节点在 trace 中的出现次数 */
  occurrences: number;
}

/** trace → 节点末次运行状态（同 nodeId 后一 occurrence 覆盖前一） */
export function nodeRunStates(
  trace: TraceEntry[],
): Map<string, NodeRunStateSummary> {
  const states = new Map<string, NodeRunStateSummary>();
  trace.forEach((entry, index) => {
    const previous = states.get(entry.id);
    states.set(entry.id, {
      status: entry.status,
      durationMs: entry.durationMs,
      lastOccurrence: index,
      occurrences: (previous?.occurrences ?? 0) + 1,
    });
  });
  return states;
}

/** 首个 failed occurrence 的节点 id（失败运行默认定位），无失败 null */
export function firstFailedNodeId(trace: TraceEntry[]): string | null {
  const failed = trace.find((entry) => entry.status === "failed");
  return failed ? failed.id : null;
}

/** 快照解析 + 结构校验：有 nodes/edges 数组才视为可渲染拓扑，其余
 * （含 JSON 损坏）返回 null 走降级 */
function parseSnapshot(raw: string | null | undefined): GraphJson | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as GraphJson).nodes) &&
      Array.isArray((parsed as GraphJson).edges)
    ) {
      return parsed as GraphJson;
    }
    return null;
  } catch {
    return null;
  }
}

/** 编辑回调占位：readOnly 下 GraphCanvas 不外抛，仅满足必填 props */
const noop = () => {};

/** 只读运行拓扑：快照合法 → GraphCanvas readOnly + 末次状态叠加；
 * 缺失/损坏 → 轻量降级提示（不抛错、不渲染画布） */
export default function RunGraphCanvas({
  graphJson,
  trace,
  selectedNodeId,
  onSelectNode,
}: {
  /** 执行时快照（AutomationRunDetail.graphJsonSnapshot）；跨端缺失
   * 编码不同（undefined/null/键缺席），一律按「无快照」降级 */
  graphJson: string | null | undefined;
  trace: TraceEntry[];
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
}) {
  const { t } = useTranslation(["chat"]);
  const graph = useMemo(() => parseSnapshot(graphJson), [graphJson]);
  const states = useMemo(() => nodeRunStates(trace), [trace]);
  const layouts = useMemo(() => (graph ? layoutOf(graph) : {}), [graph]);

  if (!graph) {
    return (
      <p className="p-4 text-xs text-muted-foreground">
        {t("chat:runSession.detail.snapshotMissing")}
      </p>
    );
  }
  return (
    <GraphCanvas
      graph={graph}
      layouts={layouts}
      selectedId={selectedNodeId}
      onSelect={onSelectNode}
      readOnly
      nodeStates={states}
      onMove={noop}
      onConnect={noop}
      onAddNode={noop}
      onAddNodeAt={noop}
      onRemoveNode={noop}
      onRemoveEdge={noop}
    />
  );
}

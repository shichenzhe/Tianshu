// src-react/domains/ai/automation/components/graph-run-detail.tsx
/**
 * 工作流执行详情双视图容器（spec 2026-11-23 §2，Task 4）：固定会话
 * 入口的图运行结果区——头部（状态徽标/开始时间/触发/耗时/attempt +
 * 「拓扑/步骤」切换）、结果摘要（原 RunSessionView GraphRunResult 的
 * error 优先 + localizeRunError 逻辑迁移至此）、视图区（topology →
 * RunGraphCanvas 执行时快照只读渲染；steps → RunStepLog）。
 * 选中态为 occurrence 下标、由父层持有：拓扑节点点击取该节点末次
 * occurrence（设计者裁定）；失败运行未选择时以 firstFailedNodeId 作
 * 画布选中，并作视口定位目标（RunGraphCanvas focusNodeId 居中；值只随
 * run/trace 变化——选中与弹框开关不回拉视口，spec §3 关闭后恢复原视
 * 口）。快照缺失/损坏时锁定步骤视图并显示降级提示（摘要不丢，判据
 * 单源 run-graph-canvas isSnapshotRenderable）；RunGraphCanvas 的
 * onSelectNode 可能外抛边 id（GraphCanvas 边点击透传）——非 trace
 * 节点 id 按无选择处理，不回调、不误选。弹框由 Task 5/6 注入渲染，
 * 本容器不持有。
 */
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { AutomationRunDetail } from "@tianshu/protocol";
import { Button } from "@/components/ui/button";
import type { TraceEntry } from "@/domains/ai/orchestration/components/GraphRunTraceView";
import RunGraphCanvas, {
  firstFailedNodeId,
  isSnapshotRenderable,
} from "./run-graph-canvas";
import { RunStatusBadge } from "./RunSelector";
import RunStepLog from "./run-step-log";
import {
  formatDateTime,
  formatDuration,
  localizeRunError,
  triggerTypeKey,
} from "../lib/run-display";

type DetailView = "topology" | "steps";

/** 画布选中节点 id：显式 occurrence 优先（越界/缺席回 null，不作失败
 * 回退）；未选择且运行失败时定位首个失败节点，其余 null */
function canvasNodeId(
  trace: TraceEntry[],
  selectedOccurrence: number | null,
  status: AutomationRunDetail["status"],
): string | null {
  if (selectedOccurrence !== null) {
    return trace[selectedOccurrence]?.id ?? null;
  }
  return status === "failed" ? firstFailedNodeId(trace) : null;
}

/** 节点 id → 末次 occurrence 下标（拓扑点击定位口径）；无命中 -1 */
function lastOccurrenceOf(trace: TraceEntry[], nodeId: string): number {
  for (let index = trace.length - 1; index >= 0; index -= 1) {
    if (trace[index].id === nodeId) {
      return index;
    }
  }
  return -1;
}

/** 末次带输出预览的条目（原 GraphRunResult 摘要回落逻辑迁移） */
function finalOutputOf(trace: TraceEntry[]): string | undefined {
  return trace
    .slice()
    .reverse()
    .find((entry) => entry.outputPreview)?.outputPreview;
}

export default function GraphRunDetail({
  run,
  trace,
  selectedOccurrence,
  onSelectOccurrence,
}: {
  run: AutomationRunDetail;
  trace: TraceEntry[];
  selectedOccurrence: number | null;
  onSelectOccurrence: (index: number) => void;
}) {
  const { t } = useTranslation(["chat"]);
  const snapshotUsable = useMemo(
    () => isSnapshotRenderable(run.graphJsonSnapshot),
    [run.graphJsonSnapshot],
  );
  // 视图态按 runId 分组：切换运行回落默认视图（拓扑优先）；快照不可用
  // 时拓扑不可达，渲染一律钳制在步骤视图（渲染期重置，run-board 先例）
  const [viewState, setViewState] = useState(() => ({
    runId: run.id,
    view: (snapshotUsable ? "topology" : "steps") as DetailView,
  }));
  if (viewState.runId !== run.id) {
    setViewState({
      runId: run.id,
      view: snapshotUsable ? "topology" : "steps",
    });
  }
  const view: DetailView = snapshotUsable ? viewState.view : "steps";
  const selectView = useCallback(
    (next: DetailView) => {
      setViewState({ runId: run.id, view: next });
    },
    [run.id],
  );
  const selectedNodeId = canvasNodeId(trace, selectedOccurrence, run.status);
  // 视口定位目标：仅随 run 状态/trace 变化（值稳定——选中/弹框开关不
  // 触发再次居中，关闭弹框后恢复原视口）；失败运行定位首个失败节点
  const focusNodeId = useMemo(
    () => (run.status === "failed" ? firstFailedNodeId(trace) : null),
    [run.status, trace],
  );
  // 边 id/null 等非 trace 节点 id：按无选择处理（不回调，父层选中态
  // 原样保留——接口无清空语义，避免误发 occurrence）
  const handleSelectNode = useCallback(
    (nodeId: string | null) => {
      if (nodeId === null) {
        return;
      }
      const index = lastOccurrenceOf(trace, nodeId);
      if (index >= 0) {
        onSelectOccurrence(index);
      }
    },
    [trace, onSelectOccurrence],
  );
  const finalOutput = useMemo(() => finalOutputOf(trace), [trace]);

  return (
    <section className="flex max-h-[55%] min-h-0 shrink-0 flex-col border-b border-border/50">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/50 px-4 py-2">
        <RunStatusBadge status={run.status} />
        <span className="text-xs text-muted-foreground">
          {formatDateTime(run.startedAt)}
        </span>
        <span className="text-xs text-muted-foreground">
          {t(triggerTypeKey(run.triggerType))}
        </span>
        <span className="text-xs text-muted-foreground">
          {formatDuration(run.durationMs)}
        </span>
        <span className="text-xs text-muted-foreground">
          {t("chat:automation.runs.attempt", { n: run.attempt })}
        </span>
        <div className="ml-auto flex items-center gap-1" role="group">
          <Button
            variant="outline"
            size="sm"
            aria-pressed={view === "topology"}
            disabled={!snapshotUsable}
            onClick={() => selectView("topology")}
            className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
          >
            {t("chat:runSession.detail.viewTopology")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            aria-pressed={view === "steps"}
            onClick={() => selectView("steps")}
            className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
          >
            {t("chat:runSession.detail.viewSteps")}
          </Button>
        </div>
      </header>
      <details
        open
        className="mx-4 my-2 rounded-lg border border-border/50 p-3"
      >
        <summary className="cursor-pointer text-sm font-medium">
          {t("chat:runSession.resultSummary")}
        </summary>
        {(run.error || finalOutput) && (
          <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-xs text-foreground">
            {localizeRunError(run.error, t) || finalOutput}
          </pre>
        )}
      </details>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
        {!snapshotUsable && (
          <p className="pt-2 text-xs text-muted-foreground">
            {t("chat:runSession.detail.snapshotMissing")}
          </p>
        )}
        {view === "topology" ? (
          <RunGraphCanvas
            graphJson={run.graphJsonSnapshot}
            trace={trace}
            selectedNodeId={selectedNodeId}
            focusNodeId={focusNodeId}
            onSelectNode={handleSelectNode}
          />
        ) : (
          <RunStepLog
            trace={trace}
            selectedOccurrence={selectedOccurrence}
            onSelectOccurrence={onSelectOccurrence}
          />
        )}
      </div>
    </section>
  );
}

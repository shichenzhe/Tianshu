// src-react/domains/ai/automation/components/run-step-log.tsx
/**
 * 步骤日志视图（spec 2026-11-23 §2）：按 trace 顺序的紧凑可扫描步骤
 * 列表——序号 + 状态点 + 节点名 + 耗时 + 失败 error.code 预览；同一
 * 节点多次 occurrence 各自成行（key 带 trace 下标，同 id 不去重），
 * 点击整行回调 occurrence 下标（弹框打开该 occurrence，设计者裁定
 * 2026-11-23）。行状态口径与拓扑末次叠加一致，长流程无需操作画布
 * 即可定位节点。
 */
import { useTranslation } from "react-i18next";

import type { TraceEntry } from "@/domains/ai/orchestration/components/GraphRunTraceView";
import { formatDuration } from "../lib/run-display";

const DOT_CLASSES: Record<TraceEntry["status"], string> = {
  success: "bg-primary",
  failed: "bg-destructive",
  skipped: "bg-muted-foreground/40",
};

/** 紧凑步骤行：选中态高亮（bg-primary-subtle + aria-current），整行可点 */
export default function RunStepLog({
  trace,
  selectedOccurrence,
  onSelectOccurrence,
}: {
  trace: TraceEntry[];
  selectedOccurrence: number | null;
  onSelectOccurrence: (index: number) => void;
}) {
  const { t } = useTranslation(["chat"]);
  if (trace.length === 0) {
    return (
      <p className="p-2 text-xs text-muted-foreground">
        {t("chat:orchestration.trace.empty")}
      </p>
    );
  }
  return (
    <ol
      data-testid="run-step-log"
      className="flex flex-col divide-y divide-border/30"
    >
      {trace.map((entry, index) => (
        <li key={`${entry.id}-${index}`}>
          <button
            type="button"
            data-testid={`run-step-row-${index}`}
            aria-current={selectedOccurrence === index ? "true" : undefined}
            className={[
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
              "hover:bg-primary-subtle hover:text-primary",
              selectedOccurrence === index ? "bg-primary-subtle" : "",
            ].join(" ")}
            onClick={() => onSelectOccurrence(index)}
          >
            <span className="w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              {index + 1}
            </span>
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${DOT_CLASSES[entry.status]}`}
            />
            <span className="min-w-0 truncate">{entry.name}</span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
              {formatDuration(entry.durationMs)}
            </span>
            {entry.status === "failed" && entry.error && (
              <span className="shrink-0 text-xs text-destructive">
                {entry.error.code}
              </span>
            )}
          </button>
        </li>
      ))}
    </ol>
  );
}

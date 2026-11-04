/**
 * 摘要指标卡（show_summary 工具块渲染）：工作流聚合结果在消息流的
 * 键值指标呈现（demo 切片 2026-10-28）。args 由模型传入、渲染层消费——
 * 执行中渲染骨架占位，失败/被拒不渲染；每项 label 左 value 右，hint 为
 * 补充说明（金额单位/口径），数值 value 等宽右对齐。
 */
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { ClipboardList } from "lucide-react";

import type { SummaryPanelItem } from "../lib/group-blocks";

function SummaryCardBody({ item }: { item: SummaryPanelItem }) {
  const { t } = useTranslation(["chat"]);

  // 执行中（args 渐进）：骨架占位，不闪现空卡
  if (item.state === "running" || item.state === "awaiting-approval") {
    return (
      <div
        data-testid="summary-loading"
        className="my-2 overflow-hidden rounded-lg border border-border/50"
      >
        <div className="flex items-center gap-1.5 border-b border-border/50 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
          <ClipboardList className="h-3.5 w-3.5 shrink-0 animate-pulse text-primary" />
          <span className="truncate">
            {item.title || t("chat:showSummary.loading")}
          </span>
        </div>
        <div className="space-y-2 px-3 py-2.5">
          <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
        </div>
      </div>
    );
  }

  // 失败/被拒：动作未发生、args 不完整，无卡可渲染
  if (item.state === "denied" || item.state === "error") {
    return null;
  }

  return (
    <div
      data-testid="summary-card"
      className="my-2 overflow-hidden rounded-lg border border-border/50"
    >
      {/* 标题栏：摘要图标 + 标题（视觉同 TableViewCard 标题栏） */}
      <div className="flex items-center gap-1.5 border-b border-border/50 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
        <ClipboardList className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="truncate">
          {item.title || t("chat:showSummary.defaultTitle")}
        </span>
      </div>
      <div className="flex flex-col divide-y divide-border/50">
        {item.items.length === 0 ? (
          <p className="px-3 py-3 text-center text-xs text-muted-foreground">
            {t("chat:showSummary.empty")}
          </p>
        ) : (
          item.items.map((entry, index) => (
            <div key={index} className="px-3 py-2">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  {entry.label}
                </span>
                <span
                  className={`shrink-0 text-sm font-medium text-foreground ${
                    typeof entry.value === "number" ? "tabular-nums" : ""
                  }`}
                >
                  {String(entry.value)}
                </span>
              </div>
              {entry.hint && (
                <p className="mt-0.5 text-xs text-muted-foreground/80">
                  {entry.hint}
                </p>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const SummaryCard = memo(SummaryCardBody);
export default SummaryCard;

// src-react/domains/ai/automation/components/AutomationStatsPanel.tsx
/** 健康度总览(spec §6):KPI 行(今日/成功率/失败/进行中/异常任务) +
 * 近 7 天迷你柱状(div 高度) + 「需要关注」清单(任务异常跳任务详情、
 * 失败 run 跳图/运行记录;面板最多直出 3 条,余量经「查看全部」
 * 弹框全量浏览,防挤压下方主面板)。数据源 automation:stats 即时聚合,
 * tasks-changed 事件经 use-automation-tasks 全局 ["automation"] 前缀失效 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CircleAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AutomationApi, type AutomationStats } from "../api/automation.api";
import { useAutomationStore } from "../store/automation.store";
import { localizeRunError } from "../lib/run-display";

/** 迷你柱状区高度(px),两根柱并列(成功 bg-primary/失败 bg-destructive) */
const BAR_AREA_HEIGHT = 36;

/** 「需要关注」面板直出上限,超出部分收进「查看全部」弹框 */
const MAX_INLINE_ATTENTION = 3;

/** attention 条目稳定 key(面板与弹框两处复用) */
function attentionKey(item: AutomationStats["attention"][number]): string {
  return item.kind === "taskError" ? `t${item.taskId}` : `r${item.runId}`;
}

function KpiCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "destructive";
}) {
  return (
    <div className="rounded-md bg-muted/40 px-2.5 py-1.5">
      <p
        className={`text-xl font-semibold leading-6 ${
          tone === "destructive" ? "text-destructive" : "text-foreground"
        }`}
      >
        {value}
      </p>
      <p className="truncate text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function TrendBar({
  value,
  max,
  className,
}: {
  value: number;
  max: number;
  className: string;
}) {
  const height =
    value === 0 ? 2 : Math.max(3, Math.round((value / max) * BAR_AREA_HEIGHT));
  return (
    <div
      className={`w-1.5 rounded-sm ${className} ${value === 0 ? "opacity-30" : ""}`}
      style={{ height }}
    />
  );
}

function TrendChart({ trend }: { trend: AutomationStats["trend"] }) {
  const { t } = useTranslation(["chat"]);
  // 归一基准 = 窗口内单日单柱最大值(全零时按 1,柱高落最小占位)
  const max = Math.max(
    1,
    ...trend.map((day) => Math.max(day.success, day.failed)),
  );
  return (
    <div className="flex w-44 shrink-0 items-end gap-1 sm:w-52">
      {trend.map((day) => (
        <div
          key={day.date}
          className="flex flex-1 flex-col items-center gap-1"
          title={t("chat:automation.statsPanel.trendBar", {
            date: day.date,
            success: day.success,
            failed: day.failed,
          })}
        >
          <div
            className="flex items-end justify-center gap-0.5"
            style={{ height: BAR_AREA_HEIGHT }}
          >
            <TrendBar value={day.success} max={max} className="bg-primary" />
            <TrendBar value={day.failed} max={max} className="bg-destructive" />
          </div>
          <span className="text-[10px] leading-none text-muted-foreground">
            {day.date.slice(5)}
          </span>
        </div>
      ))}
    </div>
  );
}

function AttentionRow({
  item,
  onNavigate,
}: {
  item: AutomationStats["attention"][number];
  /** 行点击跳转后回调(弹框内用于关闭自身) */
  onNavigate?: () => void;
}) {
  const { t } = useTranslation(["chat"]);
  const navigate = useNavigate();
  const setTab = useAutomationStore((s) => s.setTab);
  if (item.kind === "taskError") {
    return (
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-primary-subtle"
        onClick={() => {
          navigate(`/module/ai/automation/task/${item.taskId}`);
          onNavigate?.();
        }}
      >
        <CircleAlert className="h-3.5 w-3.5 shrink-0 text-destructive" />
        <span className="shrink-0 text-xs font-medium">{item.name}</span>
        <span className="truncate text-xs text-muted-foreground">
          {item.statusNote}
        </span>
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
          {t("chat:automation.statsPanel.taskErrorTag")}
        </span>
      </button>
    );
  }
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-primary-subtle"
      title={localizeRunError(item.error, t)}
      onClick={() => {
        if (item.graphId !== undefined) {
          navigate(`/module/ai/graphs/${item.graphId}`);
        } else {
          setTab("runs");
        }
        onNavigate?.();
      }}
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive/80" />
      <span className="shrink-0 text-xs font-medium">{item.name}</span>
      <span className="truncate text-xs text-destructive/80">
        {localizeRunError(item.error, t) || "-"}
      </span>
      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
        {t("chat:automation.statsPanel.failedRunTag")}
      </span>
    </button>
  );
}

/** 「需要关注」全量弹框(滚动浏览,行点击跳转后自动关闭) */
function AttentionMoreDialog({
  items,
  open,
  onOpenChange,
}: {
  items: AutomationStats["attention"];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["chat"]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg rounded-lg border-border/50 shadow-lg">
        <DialogHeader>
          <DialogTitle>
            {t("chat:automation.statsPanel.attentionTitle")}
          </DialogTitle>
        </DialogHeader>
        <ul className="flex max-h-[60vh] flex-col gap-0.5 overflow-y-auto">
          {items.map((item) => (
            <li key={attentionKey(item)}>
              <AttentionRow
                item={item}
                onNavigate={() => onOpenChange(false)}
              />
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

export function AutomationStatsPanel() {
  const { t } = useTranslation(["chat"]);
  const setStatusFilter = useAutomationStore((s) => s.setStatusFilter);
  const [moreOpen, setMoreOpen] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ["automation", "stats"],
    queryFn: () => AutomationApi.stats(),
  });

  if (isLoading) {
    return <div className="h-[76px] animate-pulse rounded-lg bg-muted/40" />;
  }
  if (!data) {
    return null;
  }

  const inlineAttention = data.attention.slice(0, MAX_INLINE_ATTENTION);
  const overflowCount = data.attention.length - inlineAttention.length;

  return (
    <section className="rounded-lg border border-border/50 p-3">
      <div className="flex items-stretch gap-3">
        <div className="grid flex-1 grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5">
          <KpiCard
            label={t("chat:automation.statsPanel.todayRuns")}
            value={String(data.today.total)}
          />
          <KpiCard
            label={t("chat:automation.statsPanel.successRate")}
            value={`${Math.round(data.today.successRate * 100)}%`}
          />
          <KpiCard
            label={t("chat:automation.statsPanel.failed")}
            value={String(data.today.failed)}
            tone={data.today.failed > 0 ? "destructive" : undefined}
          />
          <KpiCard
            label={t("chat:automation.statsPanel.running")}
            value={String(data.today.running)}
          />
          {/* 异常任务卡可点:激活任务 Tab 状态 pill 的异常筛选(口径一致) */}
          <button
            type="button"
            className="rounded-md bg-muted/40 px-2.5 py-1.5 text-left transition-colors hover:bg-primary-subtle hover:ring-1 hover:ring-primary/30"
            onClick={() => setStatusFilter("error")}
            title={t("chat:automation.statsPanel.errorTasksHint")}
          >
            <p
              className={`text-xl font-semibold leading-6 ${
                data.errorTaskCount > 0 ? "text-destructive" : "text-foreground"
              }`}
            >
              {data.errorTaskCount}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {t("chat:automation.statsPanel.errorTasks")}
            </p>
          </button>
        </div>
        <TrendChart trend={data.trend} />
      </div>
      {data.attention.length > 0 && (
        <div className="mt-3 border-t border-border/50 pt-2">
          <div className="mb-1 flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground">
              {t("chat:automation.statsPanel.attentionTitle")}
            </p>
            {overflowCount > 0 && (
              <button
                type="button"
                className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary"
                onClick={() => setMoreOpen(true)}
              >
                {t("chat:automation.statsPanel.viewAll", {
                  count: overflowCount,
                })}
              </button>
            )}
          </div>
          <ul className="flex flex-col gap-0.5">
            {inlineAttention.map((item) => (
              <li key={attentionKey(item)}>
                <AttentionRow item={item} />
              </li>
            ))}
          </ul>
        </div>
      )}
      <AttentionMoreDialog
        items={data.attention}
        open={moreOpen}
        onOpenChange={setMoreOpen}
      />
    </section>
  );
}

export default AutomationStatsPanel;

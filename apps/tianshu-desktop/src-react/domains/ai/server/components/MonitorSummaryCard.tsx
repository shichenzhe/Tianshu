// src-react/domains/ai/server/components/MonitorSummaryCard.tsx
/**
 * 主机页用量摘要卡（P0-1，spec monitoring.md §6）：选中远程连接的
 * monitor/stats 今日摘要（输入/输出 token、LLM 轮次、工具调用）。
 * 显式 connId 直拉（选中连接，非活动主机路由）；capability 门控在
 * ServerConsoleView（连接运行时上报值含 monitor 才挂本卡）。卡内 KPI
 * 标签复用监控页 chat:monitor.* 键（同一口径不另立文案）。
 */
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Activity, Loader2, RefreshCw } from "lucide-react";

import IconTooltip from "@/components/common/icon-tooltip";
import { Button } from "@/components/ui/button";
import ServerApi from "../api/server.api";
import { formatCount } from "@/domains/ai/monitor/lib/format";

export const MONITOR_STATS_QUERY_KEY = (connId: string) =>
  ["server", "monitorStats", connId] as const;

export interface MonitorSummaryCardProps {
  connId: string;
}

/** KPI 单元（监控页 KpiCard 同款紧凑形态） */
function KpiCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted/40 px-3 py-2">
      <p className="text-lg font-semibold leading-6 text-foreground">{value}</p>
      <p className="truncate text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

export default function MonitorSummaryCard({
  connId,
}: MonitorSummaryCardProps) {
  const { t } = useTranslation(["ai", "chat", "common"]);
  const statsQuery = useQuery({
    queryKey: MONITOR_STATS_QUERY_KEY(connId),
    queryFn: () => ServerApi.monitorStats(undefined, connId),
    retry: false,
  });
  const today = statsQuery.data?.today;

  return (
    <section
      data-testid="monitor-summary-card"
      className="rounded-lg border border-border/50"
    >
      <div className="flex h-10 items-center justify-between border-b border-border/50 px-3">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <Activity className="h-4 w-4 text-primary" />
          {t("ai:server.monitorCard.title")}
        </span>
        <IconTooltip label={t("ai:server.monitorCard.refresh")}>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t("ai:server.monitorCard.refresh")}
            onClick={() => void statsQuery.refetch()}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${statsQuery.isFetching ? "animate-spin" : ""}`}
            />
          </Button>
        </IconTooltip>
      </div>
      <div className="p-2">
        {statsQuery.isPending ? (
          <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("common:loading")}
          </div>
        ) : statsQuery.isError ? (
          <div className="flex flex-col items-center gap-2 py-4">
            <p className="text-sm text-destructive">
              {t("ai:server.monitorCard.loadFailed")}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
              onClick={() => void statsQuery.refetch()}
            >
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
              {t("common:reset")}
            </Button>
          </div>
        ) : !today ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            {t("ai:server.monitorCard.empty")}
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div data-testid="monitor-kpi-input">
              <KpiCell
                label={t("chat:monitor.todayInputTokens")}
                value={formatCount(today.inputTokens)}
              />
            </div>
            <div data-testid="monitor-kpi-output">
              <KpiCell
                label={t("chat:monitor.todayOutputTokens")}
                value={formatCount(today.outputTokens)}
              />
            </div>
            <div data-testid="monitor-kpi-llm">
              <KpiCell
                label={t("chat:monitor.todayLlmCalls")}
                value={formatCount(today.llmCalls)}
              />
            </div>
            <div data-testid="monitor-kpi-tool">
              <KpiCell
                label={t("chat:monitor.todayToolCalls")}
                value={formatCount(today.toolCalls)}
              />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

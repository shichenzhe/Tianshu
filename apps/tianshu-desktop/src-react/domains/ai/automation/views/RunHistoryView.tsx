// src-react/domains/ai/automation/views/RunHistoryView.tsx
/** 运行记录:状态筛选 pill(全部/成功/失败/跳过,spec §6)+ 分页 20/页;
 * 行点击:prompt/图任务 run 跳会话(复用 ?session= 选中机制),图试运行
 * run(taskId=null,graphId 非空)就地展开 GraphRunTraceView 节点轨迹
 * (spec §4 三层下钻第二层) */
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronLeft, ChevronRight, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AutomationApi } from "../api/automation.api";
import GraphRunTraceView, {
  parseTrace,
} from "@/domains/ai/orchestration/components/GraphRunTraceView";
import {
  formatDateTime,
  formatDuration,
  localizeRunError,
  triggerTypeKey,
} from "../lib/run-display";

type StatusFilter = "all" | "success" | "failed" | "skipped";
const FILTERS: StatusFilter[] = ["all", "success", "failed", "skipped"];
const statusKey = (s: Exclude<StatusFilter, "all">) =>
  `chat:automation.runs.status${s[0].toUpperCase()}${s.slice(1)}`;

export default function RunHistoryView() {
  const { t } = useTranslation(["chat"]);
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["automation", "runs", page, status],
    queryFn: () =>
      AutomationApi.runs(
        page,
        undefined,
        status === "all" ? undefined : status,
      ),
  });

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / 20));

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* 状态筛选 pill(spec §6:全部/成功/失败/跳过) */}
      <div className="flex items-center gap-1.5 border-b border-border/50 px-4 py-2">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className={`rounded-full px-2.5 py-1 text-xs transition-colors ${
              status === f
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-primary-subtle hover:text-primary"
            }`}
            onClick={() => {
              setStatus(f);
              setPage(1);
              setExpandedId(null);
            }}
          >
            {t(f === "all" ? "chat:automation.runs.filterAll" : statusKey(f))}
          </button>
        ))}
      </div>

      {!isLoading && total === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <History className="h-12 w-12 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">
            {t("chat:automation.runs.empty")}
          </p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-background text-left text-xs text-muted-foreground">
              <tr className="border-b border-border/50">
                <th className="px-4 py-2 font-medium">
                  {t("chat:automation.runs.colTime")}
                </th>
                <th className="px-4 py-2 font-medium">
                  {t("chat:automation.runs.colTask")}
                </th>
                <th className="px-4 py-2 font-medium">
                  {t("chat:automation.runs.colTrigger")}
                </th>
                <th className="px-4 py-2 font-medium">
                  {t("chat:automation.runs.colDuration")}
                </th>
                <th className="px-4 py-2 font-medium">
                  {t("chat:automation.runs.colStatus")}
                </th>
                <th className="px-4 py-2 font-medium">
                  {t("chat:automation.runs.colTokens")}
                </th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {(data?.items ?? []).map((run) => {
                // 图试运行 run(taskId=null)就地展开轨迹;任务 run(含挂图
                // 任务)保持跳会话——session 里有完整过程可回看
                const isGraphRun =
                  run.taskId === null && run.graphId !== undefined;
                const expanded = isGraphRun && expandedId === run.id;
                const rowClickable = isGraphRun || Boolean(run.sessionId);
                return (
                  <Fragment key={run.id}>
                    <tr
                      className={`border-b border-border/30 ${
                        rowClickable
                          ? "cursor-pointer hover:bg-primary-subtle"
                          : ""
                      }`}
                      onClick={
                        isGraphRun
                          ? () => setExpandedId(expanded ? null : run.id)
                          : run.sessionId
                            ? () =>
                                navigate(`/module/ai?session=${run.sessionId}`)
                            : undefined
                      }
                    >
                      <td className="px-4 py-2 text-muted-foreground">
                        {formatDateTime(run.startedAt)}
                      </td>
                      <td className="px-4 py-2">
                        {run.taskName}
                        {run.attempt > 1 && (
                          <span className="ml-1 text-xs text-muted-foreground">
                            {t("chat:automation.runs.attempt", {
                              n: run.attempt,
                            })}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        {t(triggerTypeKey(run.triggerType))}
                      </td>
                      <td className="px-4 py-2">
                        {formatDuration(run.durationMs)}
                      </td>
                      <td className="px-4 py-2">
                        {run.status === "success" && (
                          <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 border-0">
                            {t("chat:automation.runs.statusSuccess")}
                          </Badge>
                        )}
                        {run.status === "failed" && (
                          <Badge
                            variant="destructive"
                            title={localizeRunError(run.error, t)}
                          >
                            {t("chat:automation.runs.statusFailed")}
                          </Badge>
                        )}
                        {run.status === "skipped" && (
                          <Badge variant="secondary">
                            {t("chat:automation.runs.statusSkipped")}
                          </Badge>
                        )}
                        {run.status === "running" && (
                          <Badge variant="outline">
                            {t("chat:automation.runs.statusRunning")}
                          </Badge>
                        )}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {run.promptTokens !== undefined
                          ? t("chat:automation.runs.tokens", {
                              in: run.promptTokens,
                              out: run.completionTokens ?? 0,
                            })
                          : "-"}
                      </td>
                      <td className="w-8">
                        {isGraphRun &&
                          (expanded ? (
                            <ChevronDown className="h-4 w-4 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                          ))}
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="border-b border-border/30 bg-muted/30">
                        <td colSpan={7} className="px-6 py-2">
                          <GraphRunTraceView
                            trace={parseTrace(run.graphTrace)}
                            runId={run.id}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex items-center justify-end gap-2 border-t border-border/50 px-4 py-2">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => setPage((p) => p - 1)}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="text-xs text-muted-foreground">
          {page} / {totalPages}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => setPage((p) => p + 1)}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

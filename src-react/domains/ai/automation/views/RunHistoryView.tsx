// src-react/domains/ai/automation/views/RunHistoryView.tsx
/** 运行记录:分页 20/页;行点击跳转聊天会话(复用 ?session= 选中机制) */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AutomationApi } from "../api/automation.api";
import {
  formatDateTime,
  formatDuration,
  localizeRunError,
} from "../lib/run-display";

export default function RunHistoryView() {
  const { t } = useTranslation(["chat"]);
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const { data, isLoading } = useQuery({
    queryKey: ["automation", "runs", page],
    queryFn: () => AutomationApi.runs(page),
  });

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / 20));

  if (!isLoading && total === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <History className="h-12 w-12 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">
          {t("chat:automation.runs.empty")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
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
            </tr>
          </thead>
          <tbody>
            {(data?.items ?? []).map((run) => (
              <tr
                key={run.id}
                className={`border-b border-border/30 ${run.sessionId ? "cursor-pointer hover:bg-primary-subtle" : ""}`}
                onClick={() =>
                  run.sessionId &&
                  navigate(`/module/ai?session=${run.sessionId}`)
                }
              >
                <td className="px-4 py-2 text-muted-foreground">
                  {formatDateTime(run.startedAt)}
                </td>
                <td className="px-4 py-2">
                  {run.taskName}
                  {run.attempt > 1 && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      {t("chat:automation.runs.attempt", { n: run.attempt })}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2">
                  {t(
                    `chat:automation.runs.trigger${run.triggerType[0].toUpperCase()}${run.triggerType.slice(1)}`,
                  )}
                </td>
                <td className="px-4 py-2">{formatDuration(run.durationMs)}</td>
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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

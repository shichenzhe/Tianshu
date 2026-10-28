// src-react/domains/ai/orchestration/components/GraphRunHistoryDialog.tsx
/** 图运行历史弹窗:GraphApi.runs 分页;graphs-changed(试运行收尾)与
 * tasks-changed(挂图任务运行收尾)双通道失效(app 级 registerQueryInvalidation
 * 前缀覆盖 runs 子 key);行点击展开节点轨迹(spec §4);running 行内嵌手工
 * 中断按钮(cancelTestRun,收尾事件自动刷新状态)。编辑器与工作流列表页共用 */
import { Fragment, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDown, ChevronLeft, ChevronRight, Square } from "lucide-react";
import IconTooltip from "@/components/common/icon-tooltip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { mapIpcError } from "@/domains/ai/chat/lib/error-message";
import {
  formatDateTime,
  formatDuration,
  localizeRunError,
  triggerTypeKey,
} from "@/domains/ai/automation/lib/run-display";
import { GraphApi } from "../api/orchestration.api";
import GraphRunTraceView, { parseTrace } from "./GraphRunTraceView";

export default function GraphRunHistoryDialog({
  graphId,
  open,
  onOpenChange,
  focusRunId,
}: {
  graphId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 深链定位（任务运行历史跳转）：首屏含该 run 时展开节点轨迹 */
  focusRunId?: number;
}) {
  const { t } = useTranslation(["chat"]);
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const { data } = useQuery({
    queryKey: ["orchestration", "runs", graphId, page],
    queryFn: () => GraphApi.runs(graphId, page),
    enabled: open,
  });

  // 首屏数据到位后定位深链 run（不在第 1 页则仅开弹窗，不打扰分页）
  useEffect(() => {
    if (open && focusRunId != null) {
      if ((data?.items ?? []).some((run) => run.id === focusRunId)) {
        setExpandedId(focusRunId);
      }
    }
  }, [open, focusRunId, data]);

  useEffect(() => {
    if (open) {
      setPage(1);
      setExpandedId(null);
    }
  }, [open]);

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / 20));

  async function handleCancelRun() {
    if (cancelling) {
      return;
    }
    setCancelling(true);
    try {
      await GraphApi.cancelTestRun(graphId);
      toast.success(t("chat:orchestration.testRun.cancelSent"));
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setCancelling(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl border border-border/50 rounded-lg shadow-lg">
        <DialogHeader>
          <DialogTitle>{t("chat:orchestration.runs.title")}</DialogTitle>
        </DialogHeader>
        {total === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("chat:orchestration.runs.empty")}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="max-h-[50vh] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-background text-left text-xs text-muted-foreground">
                  <tr className="border-b border-border/50">
                    <th className="px-2 py-1.5 font-medium">
                      {t("chat:automation.runs.colTime")}
                    </th>
                    <th className="px-2 py-1.5 font-medium">
                      {t("chat:automation.runs.colTrigger")}
                    </th>
                    <th className="px-2 py-1.5 font-medium">
                      {t("chat:automation.runs.colDuration")}
                    </th>
                    <th className="px-2 py-1.5 font-medium">
                      {t("chat:automation.runs.colStatus")}
                    </th>
                    <th className="w-6" />
                  </tr>
                </thead>
                <tbody>
                  {(data?.items ?? []).map((run) => {
                    const expanded = expandedId === run.id;
                    return (
                      <Fragment key={run.id}>
                        <tr
                          className="cursor-pointer border-b border-border/30 hover:bg-primary-subtle"
                          onClick={() =>
                            setExpandedId(expanded ? null : run.id)
                          }
                        >
                          <td className="px-2 py-1.5 text-muted-foreground">
                            {formatDateTime(run.startedAt)}
                          </td>
                          <td className="px-2 py-1.5">
                            {t(triggerTypeKey(run.triggerType))}
                          </td>
                          <td className="px-2 py-1.5">
                            {formatDuration(run.durationMs)}
                          </td>
                          <td className="px-2 py-1.5">
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
                              <span className="flex items-center gap-1.5">
                                <Badge variant="outline">
                                  {t("chat:automation.runs.statusRunning")}
                                </Badge>
                                <IconTooltip
                                  label={t(
                                    "chat:orchestration.testRun.cancelRun",
                                  )}
                                >
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 px-1.5 hover:bg-primary-subtle hover:text-destructive"
                                    disabled={cancelling}
                                    aria-label={t(
                                      "chat:orchestration.testRun.cancelRun",
                                    )}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void handleCancelRun();
                                    }}
                                  >
                                    <Square className="h-3 w-3" />
                                  </Button>
                                </IconTooltip>
                              </span>
                            )}
                          </td>
                          <td className="w-6">
                            {expanded ? (
                              <ChevronDown className="h-4 w-4 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-4 w-4 text-muted-foreground" />
                            )}
                          </td>
                        </tr>
                        {expanded && (
                          <tr className="border-b border-border/30 bg-muted/30">
                            <td colSpan={5} className="px-5 py-2">
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
            <div className="flex items-center justify-end gap-2">
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
        )}
      </DialogContent>
    </Dialog>
  );
}

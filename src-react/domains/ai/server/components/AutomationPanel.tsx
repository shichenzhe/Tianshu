/**
 * 自动化任务遥控面板（GA-T8）：无头端 automation/query 列表（名称/schedule
 * 摘要/下次运行时间）+ 启停开关 + 立即运行（runNow 202 受理）。
 * 启停语义（Ruling 12）：无 toggle 端点——automation/save 全量携翻转后的
 * enabled（toTaskSaveParams 还原 schedule 对象，其余字段原样回传）。
 * automation.changed 是刷新信号不是状态镜像（协议头注释口径）——收即重拉
 * 列表；server.connected 重连同拉（spec §13 项 2）。
 * 时间一律按 ISO 字符串原样展示（wire 口径，勿 new Date 假设时区）。
 */
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CalendarClock,
  Loader2,
  Play,
  RefreshCw,
  Workflow,
} from "lucide-react";

import IconTooltip from "@/components/common/icon-tooltip";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import GraphApi, {
  onRemoteGraphEvent,
  toTaskSaveParams,
  type RemoteTaskRecord,
} from "../api/graph.api";
import { describeError } from "../lib/describe-error";

const TASK_PAGE_SIZE = 50;

export const AUTOMATION_QUERY_KEY = (connId: string) =>
  ["server", "automationTasks", connId] as const;

export interface AutomationPanelProps {
  connId: string;
}

export default function AutomationPanel({ connId }: AutomationPanelProps) {
  const { t } = useTranslation(["ai", "common"]);
  const queryClient = useQueryClient();

  const tasksQuery = useQuery({
    queryKey: AUTOMATION_QUERY_KEY(connId),
    queryFn: () =>
      GraphApi.automationList({ page: 1, pageSize: TASK_PAGE_SIZE }, connId),
    retry: false,
  });
  const tasks = tasksQuery.data?.records ?? [];

  // 连接级合并事件（server:event:<connId>）：automation.changed /
  // server.connected 一律重拉列表（刷新信号语义）
  useEffect(() => {
    const off = onRemoteGraphEvent(connId, (event) => {
      if (
        event.type === "automation.changed" ||
        event.type === "server.connected"
      ) {
        void queryClient.invalidateQueries({
          queryKey: AUTOMATION_QUERY_KEY(connId),
        });
      }
    });
    return off;
  }, [connId, queryClient]);

  const handleToggle = async (task: RemoteTaskRecord, next: boolean) => {
    try {
      await GraphApi.automationSave(toTaskSaveParams(task, next), connId);
      await queryClient.invalidateQueries({
        queryKey: AUTOMATION_QUERY_KEY(connId),
      });
      toast.success(
        t(
          next
            ? "ai:server.automation.enabledToast"
            : "ai:server.automation.disabledToast",
        ),
      );
    } catch (e) {
      toast.error(
        t("ai:server.automation.toggleFailed", {
          message: describeError(e),
        }),
      );
    }
  };

  const handleRunNow = async (task: RemoteTaskRecord) => {
    try {
      await GraphApi.automationRunNow(task.id, connId);
      toast.success(t("ai:server.automation.runNowAccepted"));
    } catch (e) {
      toast.error(
        t("ai:server.automation.runNowFailed", {
          message: describeError(e),
        }),
      );
    }
  };

  return (
    <section
      data-testid="automation-panel"
      className="rounded-lg border border-border/50"
    >
      <div className="flex h-10 items-center justify-between border-b border-border/50 px-3">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <CalendarClock className="h-4 w-4 text-primary" />
          {t("ai:server.automation.title")}
        </span>
        <IconTooltip label={t("ai:server.automation.refresh")}>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t("ai:server.automation.refresh")}
            onClick={() => void tasksQuery.refetch()}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${tasksQuery.isFetching ? "animate-spin" : ""}`}
            />
          </Button>
        </IconTooltip>
      </div>
      <div className="p-2">
        {tasksQuery.isPending ? (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("common:loading")}
          </div>
        ) : tasksQuery.isError ? (
          <div className="flex flex-col items-center gap-2 py-6">
            <p className="text-sm text-destructive">
              {t("ai:server.automation.loadFailed")}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
              onClick={() => void tasksQuery.refetch()}
            >
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
              {t("common:reset")}
            </Button>
          </div>
        ) : tasks.length === 0 ? (
          <div className="flex flex-col items-center gap-1 py-6 text-center">
            <p className="text-sm text-muted-foreground">
              {t("ai:server.automation.empty")}
            </p>
            <p className="text-xs text-muted-foreground/80">
              {t("ai:server.automation.emptyTip")}
            </p>
          </div>
        ) : (
          tasks.map((task) => (
            <div
              key={task.id}
              data-testid={`automation-row-${task.id}`}
              className="flex items-center justify-between gap-2 rounded-md px-2 py-2 text-sm text-foreground"
            >
              <div className="min-w-0 flex-1">
                <p className="flex min-w-0 items-center gap-1.5 font-medium">
                  {task.targetKind === "graph" && (
                    <Badge
                      variant="outline"
                      className="shrink-0 gap-1 border-primary/30 px-1.5 py-0 font-medium text-primary"
                    >
                      <Workflow className="h-3 w-3" />
                      {t("ai:server.automation.graphBadge")}
                    </Badge>
                  )}
                  <span className="truncate">{task.name}</span>
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  <span data-testid={`automation-schedule-${task.id}`}>
                    {task.scheduleText}
                  </span>
                  {" · "}
                  <span data-testid={`automation-nextrun-${task.id}`}>
                    {task.enabled
                      ? task.nextRunAt
                        ? `${t("ai:server.automation.nextRunLabel")} ${task.nextRunAt}`
                        : t("ai:server.automation.nextRunNone")
                      : t("ai:server.automation.paused")}
                  </span>
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                data-testid={`automation-runnow-${task.id}`}
                className="h-7 shrink-0 px-2 text-xs hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
                onClick={() => void handleRunNow(task)}
              >
                <Play className="mr-1 h-3 w-3" />
                {t("ai:server.automation.runNow")}
              </Button>
              <Switch
                data-testid={`automation-toggle-${task.id}`}
                checked={task.enabled}
                onCheckedChange={(next) => void handleToggle(task, next)}
                aria-label={t("ai:server.automation.toggleLabel")}
              />
            </div>
          ))
        )}
      </div>
    </section>
  );
}

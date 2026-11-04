// src-react/domains/ai/automation/components/RunHistoryPanel.tsx
/** 任务运行历史(详情页右栏):状态筛选 + 20/页分页 + 失败展开报错 + 行点击
 * 三分支——graph run(graphId,去会话化后无 sessionId)弹工作流运行历史弹窗
 * (跨域 import 先例 RunHistoryView→GraphRunTraceView)、prompt run 跳会话、
 * 均无(异常落库)不可点；两字段互斥无优先级问题。2026-10-28 去会话化:
 * executor 不再落 sessionId,节点详情走 graphRunNode(弹窗内展开行下钻全文) */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Filter,
  History,
  Loader2,
} from "lucide-react";

import IconTooltip from "@/components/common/icon-tooltip";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AutomationApi,
  type RunRecord,
  type RunStatus,
} from "../api/automation.api";
import {
  formatDateTime,
  formatDuration,
  localizeRunError,
} from "../lib/run-display";
import GraphRunHistoryDialog from "@/domains/ai/orchestration/components/GraphRunHistoryDialog";

type StatusFilter = "all" | RunStatus;
const PAGE_SIZE = 20;
const FILTERS: StatusFilter[] = ["all", "success", "failed", "running"];
/** 状态配色走主题 token(成功即主题色,PRD 的绿为默认蓝主题下的主色,不硬编码绿) */
const STATUS_CLASSES: Record<RunStatus, string> = {
  running: "text-muted-foreground",
  success: "text-primary",
  failed: "text-destructive",
  skipped: "text-muted-foreground",
};

const upperFirst = (s: string) => s[0].toUpperCase() + s.slice(1);
const filterKey = (f: StatusFilter) =>
  `chat:automation.history.filter${upperFirst(f)}`;
const statusKey = (s: RunStatus) =>
  `chat:automation.runs.status${upperFirst(s)}`;

export default function RunHistoryPanel({ taskId }: { taskId: number }) {
  const { t } = useTranslation(["chat", "common"]);
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  // graph run 运行历史弹窗目标：非空即开（该图全部运行记录 + 节点轨迹）
  const [graphHistoryId, setGraphHistoryId] = useState<number | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["automation", "runs", taskId, page, status],
    queryFn: () =>
      AutomationApi.runs(page, taskId, status === "all" ? undefined : status),
  });
  // status 变化重置页码
  useEffect(() => setPage(1), [status]);

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex h-full flex-col">
      {/* 标题行:总数 + 状态筛选漏斗 */}
      <div className="flex items-center justify-between border-b border-border/50 px-4 py-3">
        <h2 className="text-sm font-medium">
          {t("chat:automation.history.title", { count: total })}
        </h2>
        <DropdownMenu>
          <IconTooltip label={t(filterKey(status))}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t(filterKey(status))}
              >
                <Filter className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
          </IconTooltip>
          <DropdownMenuContent
            align="end"
            className="border border-border/50 rounded-lg shadow-lg"
          >
            {FILTERS.map((f) => (
              <DropdownMenuItem
                key={f}
                onClick={() => setStatus(f)}
                className="justify-between"
              >
                {t(filterKey(f))}
                {status === f && <Check className="h-4 w-4 text-primary" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
        </div>
      ) : total === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <History className="h-8 w-8 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">
            {t("chat:automation.history.empty")}
          </p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {(data?.items ?? []).map((run) => (
            <RunRow
              key={run.id}
              run={run}
              expanded={expandedId === run.id}
              onToggleExpand={() =>
                setExpandedId(expandedId === run.id ? null : run.id)
              }
              onOpenSession={() =>
                navigate(`/module/ai?session=${run.sessionId}`)
              }
              onOpenGraph={
                run.graphId !== undefined
                  ? () => setGraphHistoryId(run.graphId!)
                  : undefined
              }
            />
          ))}
        </div>
      )}

      {/* graph run 运行历史弹窗（复用编辑器/列表页弹窗：分页 + 行展开轨迹） */}
      {graphHistoryId !== null && (
        <GraphRunHistoryDialog
          graphId={graphHistoryId}
          open={graphHistoryId !== null}
          onOpenChange={(open) => {
            if (!open) {
              setGraphHistoryId(null);
            }
          }}
        />
      )}

      {/* 分页:上一页/下一页 ghost 图标按钮 */}
      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2 border-t border-border/50 px-4 py-2">
          <IconTooltip label={t("chat:automation.history.prevPage")}>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("chat:automation.history.prevPage")}
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </IconTooltip>
          <span className="text-xs text-muted-foreground">
            {page} / {totalPages}
          </span>
          <IconTooltip label={t("chat:automation.history.nextPage")}>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("chat:automation.history.nextPage")}
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </IconTooltip>
        </div>
      )}
    </div>
  );
}

/** 单条运行:主行状态徽标(失败可点开报错、graph run 弹运行历史、有会话则
 * 跳转) + 时间/耗时副行 */
function RunRow({
  run,
  expanded,
  onToggleExpand,
  onOpenSession,
  onOpenGraph,
}: {
  run: RunRecord;
  expanded: boolean;
  onToggleExpand: () => void;
  onOpenSession: () => void;
  /** graph run 专属（graphId 在场才有）；点击弹工作流运行历史弹窗 */
  onOpenGraph?: () => void;
}) {
  const { t } = useTranslation(["chat"]);
  // 三分支互斥：graphId（executor 落库）与 sessionId（prompt 落库）不同时在场
  const rowAction = onOpenGraph ?? (run.sessionId ? onOpenSession : undefined);
  const clickable = rowAction !== undefined;
  return (
    <div
      className={`border-b border-border/30 px-4 py-2.5 ${clickable ? "hover:bg-primary-subtle" : ""}`}
    >
      {/* 行主体:状态徽标 + 行尾入口提示(graph=运行历史 / 会话=查看会话) */}
      <div
        className={`flex items-center justify-between gap-2 ${clickable ? "cursor-pointer" : ""}`}
        onClick={rowAction}
      >
        <span
          className={`flex items-center gap-1.5 text-sm ${STATUS_CLASSES[run.status]} ${run.status === "failed" ? "cursor-pointer" : ""}`}
          onClick={
            run.status === "failed"
              ? (e) => {
                  e.stopPropagation();
                  onToggleExpand();
                }
              : undefined
          }
        >
          {run.status === "running" && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          )}
          {run.status === "success" && <Check className="h-3.5 w-3.5" />}
          {(run.status === "failed" || run.status === "skipped") && (
            <CircleAlert className="h-3.5 w-3.5" />
          )}
          {t(statusKey(run.status))}
        </span>
        {onOpenGraph ? (
          <span className="text-xs text-muted-foreground">
            {t("chat:automation.history.viewGraphRuns")}
          </span>
        ) : (
          run.sessionId && (
            <span className="text-xs text-muted-foreground">
              {t("chat:automation.history.viewSession")}
            </span>
          )
        )}
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {formatDateTime(run.startedAt)} · {formatDuration(run.durationMs)}
        {run.triggerType === "manual" &&
          ` · ${t("chat:automation.history.triggerManual")}`}
      </p>
      {expanded && (
        <pre className="mt-1 whitespace-pre-wrap rounded-md bg-muted/60 p-2 text-xs text-destructive">
          {localizeRunError(run.error, t) ||
            t("chat:automation.history.errorDetail")}
        </pre>
      )}
    </div>
  );
}

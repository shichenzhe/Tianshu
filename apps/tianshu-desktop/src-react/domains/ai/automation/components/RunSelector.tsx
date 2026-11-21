import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import type { RunOwner } from "@tianshu/core/run-session";
import type { AutomationRunRecord } from "@tianshu/protocol";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { AutomationApi, type RunRecord } from "../api/automation.api";
import { GraphApi } from "../../orchestration/api/orchestration.api";
import {
  formatDateTime,
  formatDuration,
  triggerTypeKey,
} from "../lib/run-display";

export function runPageQueryKey(owner: RunOwner, page: number) {
  return ["automation", "runSessionRuns", owner.kind, owner.ownerId, page];
}

export function queryRunPage(owner: RunOwner, page: number) {
  return owner.kind === "task"
    ? AutomationApi.runs(page, owner.ownerId)
    : GraphApi.runs(owner.ownerId, page, true);
}

interface RunSelectorProps {
  owner: RunOwner;
  currentRun?: AutomationRunRecord;
  onSelect: (runId: number) => void;
}

/** 固定入口顶栏的分页运行选择器；只加载列表行，完整轨迹由单 run 查询获取。 */
export default function RunSelector({
  owner,
  currentRun,
  onSelect,
}: RunSelectorProps) {
  const { t } = useTranslation(["chat"]);
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [owner.kind, owner.ownerId]);
  const runsQuery = useQuery({
    queryKey: runPageQueryKey(owner, page),
    queryFn: () => queryRunPage(owner, page),
  });
  const runs = runsQuery.data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil((runsQuery.data?.total ?? 0) / 20));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={t("chat:runSession.selectRun")}
          disabled={!currentRun && runs.length === 0}
          className="max-w-64 gap-2 hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
        >
          <span className="truncate">
            {currentRun
              ? formatDateTime(currentRun.startedAt)
              : t("chat:runSession.empty")}
          </span>
          {currentRun && <RunStatusBadge status={currentRun.status} />}
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[26rem] rounded-lg border-border/50 p-2 shadow-lg"
      >
        <div className="flex max-h-80 flex-col overflow-y-auto">
          {runs.map((run) => (
            <button
              key={run.id}
              type="button"
              data-testid={`run-option-${run.id}`}
              className="flex flex-col gap-1 rounded-md px-3 py-2 text-left hover:bg-primary-subtle hover:text-primary"
              onClick={() => {
                onSelect(run.id);
                setOpen(false);
              }}
            >
              <span className="flex items-center justify-between gap-3 text-sm">
                <span>{formatDateTime(run.startedAt)}</span>
                <RunStatusBadge status={run.status} />
              </span>
              <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                <span>{t(triggerTypeKey(run.triggerType))}</span>
                <span>{formatDuration(run.durationMs)}</span>
                <span>
                  {t("chat:automation.runs.attempt", { n: run.attempt })}
                </span>
              </span>
            </button>
          ))}
        </div>
        <div className="mt-1 flex items-center justify-end gap-2 border-t border-border/50 pt-2">
          <Button
            variant="outline"
            size="sm"
            aria-label={t("chat:automation.history.prevPage")}
            disabled={page <= 1}
            onClick={() => setPage((value) => value - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-xs text-muted-foreground">
            {page} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            aria-label={t("chat:automation.history.nextPage")}
            disabled={page >= totalPages}
            onClick={() => setPage((value) => value + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function RunStatusBadge({ status }: { status: RunRecord["status"] }) {
  const { t } = useTranslation(["chat"]);
  const label = `status${status[0].toUpperCase()}${status.slice(1)}`;
  const variant =
    status === "failed"
      ? "destructive"
      : status === "skipped"
        ? "secondary"
        : "outline";
  return (
    <Badge variant={variant} className="shrink-0">
      {t(`chat:automation.runs.${label}`)}
    </Badge>
  );
}

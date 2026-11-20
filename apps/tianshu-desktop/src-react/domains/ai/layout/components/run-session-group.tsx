import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  CalendarClock,
  ChevronDown,
  ChevronRight,
  History,
  MoreHorizontal,
  Play,
  SquareArrowOutUpRight,
  Workflow,
} from "lucide-react";
import { toast } from "sonner";
import type { RunGroupRecord } from "@tianshu/protocol";
import type { RunOwner } from "@tianshu/core/run-session";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { AutomationApi } from "../../automation/api/automation.api";
import { useAutomationStore } from "../../automation/store/automation.store";
import { runSessionPath } from "../../automation/lib/run-session-route";
import { sortRunGroups } from "../../automation/lib/run-group-view";

interface RunSessionGroupProps {
  groups: RunGroupRecord[];
}

/** Fixed task/graph entries; these are not ordinary session resources. */
export default function RunSessionGroup({ groups }: RunSessionGroupProps) {
  const { t } = useTranslation(["chat", "common"]);
  const [open, setOpen] = useState(true);
  const [runningId, setRunningId] = useState<number | null>(null);
  const queryClient = useQueryClient();

  const runNow = async (taskId: number) => {
    setRunningId(taskId);
    try {
      await AutomationApi.runNow(taskId);
      await queryClient.invalidateQueries({
        queryKey: ["automation", "runGroups"],
      });
    } catch {
      toast.error(t("chat:automation.detail.runNowFailed"));
    } finally {
      setRunningId(null);
    }
  };

  return (
    <section className="shrink-0 border-t border-border/50 px-2 pb-1 pt-2">
      <button
        type="button"
        className="flex w-full items-center gap-1 rounded-md px-1 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls="run-session-groups"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="truncate">{t("chat:runSessions.title")}</span>
        <span>({groups.length})</span>
      </button>
      {open && (
        <div
          id="run-session-groups"
          className="mt-1 max-h-56 space-y-0.5 overflow-y-auto"
        >
          {sortRunGroups(groups).map((group) => (
            <RunSessionRow
              key={`${group.kind}-${group.ownerId}`}
              group={group}
              running={runningId === group.ownerId}
              onRunNow={() => void runNow(group.ownerId)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function RunSessionRow({
  group,
  running,
  onRunNow,
}: {
  group: RunGroupRecord;
  running: boolean;
  onRunNow: () => void;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const owner: RunOwner = { kind: group.kind, ownerId: group.ownerId };
  const selected =
    Number(
      searchParams.get(group.kind === "task" ? "automation" : "graphRun"),
    ) === group.ownerId;
  const openOwner = () =>
    navigate(
      group.kind === "task"
        ? `/module/ai/automation/task/${group.ownerId}`
        : `/module/ai/graphs/${group.ownerId}`,
    );
  const viewHistory = () => {
    useAutomationStore.getState().setView("list");
    useAutomationStore.getState().setTab("runs");
    navigate("/module/ai/automation");
  };

  return (
    <div
      data-testid={`run-session-${group.kind}-${group.ownerId}`}
      className={cn(
        "group/run-session relative rounded-md",
        selected
          ? "bg-primary-subtle text-primary"
          : "hover:bg-primary-subtle/60",
      )}
    >
      <button
        type="button"
        className="block w-full px-2 py-1.5 pr-8 text-left"
        onClick={() => navigate(runSessionPath(owner))}
      >
        <span className="flex items-center gap-1.5">
          {group.kind === "task" ? (
            <CalendarClock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <Workflow className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate text-sm" title={group.name}>
            {group.name}
          </span>
        </span>
        <span
          className={cn(
            "block pl-5 text-xs",
            group.latestRun?.status === "failed"
              ? "text-destructive"
              : "text-muted-foreground",
          )}
        >
          {group.latestRun
            ? t(
                `chat:automation.runs.status${statusSuffix(group.latestRun.status)}`,
              )
            : t("chat:runSessions.noRuns")}
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="absolute right-1 top-2 h-6 w-6 p-0 text-muted-foreground opacity-0 hover:text-primary focus:opacity-100 group-hover/run-session:opacity-100"
            aria-label={t("common:more")}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="rounded-lg border border-border/50 shadow-lg"
        >
          <DropdownMenuItem onClick={openOwner}>
            <SquareArrowOutUpRight className="mr-2 h-4 w-4" />
            {t(
              group.kind === "task"
                ? "chat:runSessions.openTask"
                : "chat:runSessions.openGraph",
            )}
          </DropdownMenuItem>
          {group.kind === "task" && (
            <DropdownMenuItem disabled={running} onClick={onRunNow}>
              <Play className="mr-2 h-4 w-4" />
              {t("chat:runSessions.runNow")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={viewHistory}>
            <History className="mr-2 h-4 w-4" />
            {t("chat:runSessions.viewHistory")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function statusSuffix(
  status: NonNullable<RunGroupRecord["latestRun"]>["status"],
) {
  return `${status[0].toUpperCase()}${status.slice(1)}`;
}

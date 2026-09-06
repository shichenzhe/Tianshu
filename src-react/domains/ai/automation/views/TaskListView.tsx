// src-react/domains/ai/automation/views/TaskListView.tsx
/** 任务列表:状态 pill + 行列表 + 批量管理工具栏变体 + 空状态 */
import { useDeferredValue, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarClock, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  AutomationApi,
  type TaskRecord,
  type TemplateRecord,
} from "../api/automation.api";
import {
  filterTasks,
  useAutomationStore,
  type StatusFilter,
} from "../store/automation.store";
import { TaskRow } from "../components/TaskRow";
import { CreateTaskDialog } from "../components/CreateTaskDialog";

const STATUS: StatusFilter[] = ["all", "running", "paused", "error", "expired"];

export default function TaskListView({
  tasks,
  isLoading,
}: {
  tasks: TaskRecord[];
  isLoading: boolean;
}) {
  const { t } = useTranslation(["chat"]);
  const queryClient = useQueryClient();
  const {
    sourceFilter,
    statusFilter,
    setStatusFilter,
    search,
    batchMode,
    selectedIds,
    exitBatchMode,
    selectAll,
  } = useAutomationStore();
  const [editing, setEditing] = useState<TaskRecord | undefined>();
  const [template, setTemplate] = useState<TemplateRecord | undefined>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const deferredSearch = useDeferredValue(search);
  const visible = filterTasks(
    tasks,
    sourceFilter,
    statusFilter,
    deferredSearch,
  );

  async function handleDelete() {
    setDeleting(true);
    try {
      await AutomationApi.remove(selectedIds);
      toast.success(
        t("chat:automation.toast.deleted", { count: selectedIds.length }),
      );
      exitBatchMode();
      await queryClient.invalidateQueries({
        queryKey: ["automation", "tasks"],
      });
      await queryClient.invalidateQueries({ queryKey: ["automation", "runs"] });
    } catch (e) {
      toast.error(
        t("chat:automation.toast.loadFailed", {
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setDeleting(false);
      setConfirmOpen(false);
    }
  }

  if (!isLoading && tasks.length === 0) {
    return (
      <>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <CalendarClock className="h-12 w-12 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">
            {t("chat:automation.list.empty")}
          </p>
          <Button
            onClick={() => {
              setTemplate(undefined);
              setEditing(undefined);
              setDialogOpen(true);
            }}
          >
            {t("chat:automation.list.emptyAction")}
          </Button>
        </div>
        <CreateTaskDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          editTask={editing}
          template={template}
        />
      </>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-3">
      {/* 状态过滤 pill 行(或批量管理工具栏变体) */}
      {batchMode ? (
        <div className="flex items-center gap-3 rounded-lg border border-border/50 px-3 py-2">
          <Checkbox
            checked={
              selectedIds.length === visible.length && visible.length > 0
            }
            onCheckedChange={() => selectAll(visible.map((x) => x.id))}
            aria-label={t("chat:automation.list.selectAll")}
          />
          <Button
            variant="destructive"
            size="sm"
            disabled={!selectedIds.length}
            onClick={() => setConfirmOpen(true)}
          >
            <Trash2 className="h-4 w-4 mr-1" />
            {t("chat:automation.list.delete")}
          </Button>
          <span className="text-sm text-muted-foreground">
            {t("chat:automation.list.batchSelected", {
              count: selectedIds.length,
            })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={exitBatchMode}
          >
            {t("chat:automation.list.exitBatch")}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-1">
          {STATUS.map((s) => (
            <Button
              key={s}
              variant={statusFilter === s ? "secondary" : "ghost"}
              size="sm"
              className="rounded-full"
              onClick={() => setStatusFilter(s)}
            >
              {t(`chat:automation.status.${s}`)}
            </Button>
          ))}
        </div>
      )}

      {!isLoading && visible.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {t("chat:automation.list.empty")}
        </p>
      ) : (
        visible.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            onClick={() => {
              setEditing(task);
              setDialogOpen(true);
            }}
          />
        ))
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="border border-border/50 rounded-lg shadow-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("chat:automation.list.deleteTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("chat:automation.list.deleteBody", {
                count: selectedIds.length,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleting}
              onClick={handleDelete}
            >
              {t("common:confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <CreateTaskDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editTask={editing}
        template={template}
      />
    </div>
  );
}

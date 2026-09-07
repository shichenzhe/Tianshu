// src-react/domains/ai/automation/views/TaskDetailView.tsx
/**
 * 任务详情/编辑页(spec §6):顶栏(返回/标题/测试运行/删除/取消/保存) +
 * 左配置右历史分栏。左侧经 useTaskForm 复用弹窗表单(名称/提示词输入卡/
 * 工作空间/权限胶囊/频率卡片),右侧运行历史由 Task 5 填充(当前占位)。
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, Loader2, Play, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WorkspaceApi } from "@/domains/ai/api/workspace.api";
import { AutomationApi } from "../api/automation.api";
import { useTaskForm } from "../lib/use-task-form";
import { useAutomationTasks } from "../lib/use-automation-tasks";
import { mapIpcError } from "../../chat/lib/error-message";
import PermissionCapsule from "../../chat/components/PermissionCapsule";
import TaskPromptInput from "../components/TaskPromptInput";
import { ScheduleDialog } from "../components/ScheduleDialog";

export default function TaskDetailView() {
  const { id } = useParams<{ id: string }>();
  const taskId = Number(id);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation(["chat", "common"]);
  const { data: tasks = [], isLoading } = useAutomationTasks();
  const { data: workspaces = [] } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => WorkspaceApi.list(),
  });
  const task = tasks.find((x) => x.id === taskId);
  // resetKey 兼 SchedulePicker 回填 remount:任务落地即以 task-{id} 重置表单
  const form = useTaskForm({
    task,
    resetKey: task ? `task-${task.id}` : "none",
    workspaces,
  });
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const notFoundRef = useRef(false);

  // 未找到:非加载态自动回列表(交给 useEffect,避免渲染期导航)
  useEffect(() => {
    if (!isLoading && !task && !notFoundRef.current) {
      notFoundRef.current = true;
      toast.error(t("chat:automation.detail.notFound"));
      navigate("/module/ai/automation", { replace: true });
    }
  }, [isLoading, task, navigate, t]);

  if (!task) return null;

  const invalidateTasks = async () => {
    await queryClient.invalidateQueries({ queryKey: ["automation", "tasks"] });
  };

  // canSubmit 已含编辑期 startAtUnchanged 语义(维持原生命周期免防倒流校验)
  async function handleSave(): Promise<boolean> {
    if (!form.canSubmit) {
      return false;
    }
    setSaving(true);
    try {
      await AutomationApi.update(taskId, form.buildParams());
      await invalidateTasks();
      form.resetSnapshot();
      toast.success(t("chat:automation.detail.saved"));
      return true;
    } catch (e) {
      toast.error(mapIpcError(e));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function handlePlay() {
    setRunning(true);
    try {
      // 有未保存修改先落库(失败即中止本次触发)
      if (form.isDirty && !(await handleSave())) {
        return;
      }
      await AutomationApi.runNow(taskId);
      await queryClient.invalidateQueries({
        queryKey: ["automation", "runs"],
      });
      toast.success(t("chat:automation.detail.playing"));
    } catch {
      toast.error(t("chat:automation.detail.runNowFailed"));
    } finally {
      setRunning(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await AutomationApi.remove([taskId]);
      await invalidateTasks();
      await queryClient.invalidateQueries({
        queryKey: ["automation", "runs"],
      });
      navigate("/module/ai/automation");
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setDeleting(false);
      setDeleteOpen(false);
    }
  }

  function handleLeave() {
    if (form.isDirty) {
      setDiscardOpen(true);
    } else {
      navigate(-1);
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* 顶栏 */}
      <div className="flex items-center gap-2 border-b border-border/50 px-4 py-3">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("chat:automation.detail.back")}
          onClick={handleLeave}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="truncate text-base font-semibold">{task.name}</h1>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
            disabled={running}
            onClick={() => void handlePlay()}
          >
            {running ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            {t("chat:automation.detail.play")}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("chat:automation.detail.deleteTitle")}
            className="text-muted-foreground"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={handleLeave}>
            {t("chat:automation.detail.cancel")}
          </Button>
          <Button
            size="sm"
            disabled={!form.isDirty || !form.canSubmit || saving}
            onClick={() => void handleSave()}
          >
            {t("chat:automation.detail.save")}
          </Button>
        </div>
      </div>

      {/* 左配置右历史分栏(右侧运行历史由 Task 5 填充) */}
      <div className="flex flex-1 overflow-hidden">
        <div className="w-[62%] space-y-5 overflow-y-auto p-4">
          <div className="space-y-1.5">
            <Label>{t("chat:automation.detail.name")}</Label>
            <Input
              value={form.values.name}
              placeholder={t("chat:automation.detail.namePlaceholder")}
              onChange={(e) => form.patch({ name: e.target.value })}
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t("chat:automation.detail.prompt")}</Label>
            <TaskPromptInput
              value={form.values.prompt}
              onChange={(prompt) => form.patch({ prompt })}
              workspaceId={form.values.workspaceId}
              modelId={form.values.modelId ?? undefined}
              onModelChange={(modelId) => form.patch({ modelId })}
              onOpenMcp={() => navigate("/module/ai/experts?tab=connectors")}
              placeholder={t("chat:automation.create.promptPlaceholder")}
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t("chat:automation.detail.workspace")}</Label>
            <Select
              value={
                form.values.workspaceId
                  ? String(form.values.workspaceId)
                  : undefined
              }
              onValueChange={(v) => form.patch({ workspaceId: Number(v) })}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={t("chat:automation.create.workspacePlaceholder")}
                />
              </SelectTrigger>
              <SelectContent className="border border-border/50 rounded-lg shadow-lg">
                {workspaces.map((w) => (
                  <SelectItem key={w.id} value={String(w.id)}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>{t("chat:automation.detail.permission")}</Label>
            <PermissionCapsule
              sessionId={task.id}
              accessMode={form.values.accessMode}
              onChange={(accessMode) => form.patch({ accessMode })}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>{t("chat:automation.detail.schedule")}</Label>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setScheduleOpen(true)}
              >
                {t("chat:automation.detail.scheduleEdit")}
              </Button>
            </div>
            <p className="rounded-lg border border-border/50 px-3 py-2 text-sm text-muted-foreground">
              {task.scheduleText}
            </p>
            {form.validation !== "ok" && (
              <p className="text-sm text-red-500">
                {t(
                  `chat:automation.schedule.err${form.validation[0].toUpperCase()}${form.validation.slice(1)}`,
                )}
              </p>
            )}
          </div>
        </div>
        <div className="w-[38%] border-l border-border/50" />
      </div>

      {/* 删除确认 */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent className="border border-border/50 rounded-lg shadow-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("chat:automation.detail.deleteTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("chat:automation.detail.deleteDesc", { name: task.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleting}
              onClick={() => void handleDelete()}
            >
              {t("common:confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 放弃未保存修改确认 */}
      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogContent className="border border-border/50 rounded-lg shadow-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("chat:automation.detail.discardTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("chat:automation.detail.discardDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("chat:automation.detail.keepEditing")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => navigate(-1)}>
              {t("chat:automation.detail.discard")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ScheduleDialog
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        schedule={form.values.schedule}
        validity={form.values.validity}
        onChange={(schedule, validity) => form.patch({ schedule, validity })}
      />
    </div>
  );
}

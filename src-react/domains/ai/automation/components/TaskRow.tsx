// src-react/domains/ai/automation/components/TaskRow.tsx
/** 单行任务:名称/归属/scheduleText/启停开关/状态;行主体点击进详情页 */
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { AutomationApi, type TaskRecord } from "../api/automation.api";
import { useAutomationStore } from "../store/automation.store";

export function TaskRow({
  task,
  onClick,
}: {
  task: TaskRecord;
  onClick: () => void;
}) {
  const { t } = useTranslation(["chat"]);
  const queryClient = useQueryClient();
  const { batchMode, selectedIds, toggleSelected } = useAutomationStore();
  async function handleToggle(next: boolean) {
    try {
      await AutomationApi.toggle(task.id, next);
      await queryClient.invalidateQueries({
        queryKey: ["automation", "tasks"],
      });
      toast.success(
        t(
          next
            ? "chat:automation.toast.enabled"
            : "chat:automation.toast.disabled",
        ),
      );
    } catch (e) {
      toast.error(
        t("chat:automation.toast.loadFailed", {
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }
  return (
    <div
      className="flex items-center gap-3 rounded-lg px-3 py-2.5 cursor-pointer hover:bg-primary-subtle"
      onClick={onClick}
    >
      {batchMode && (
        <Checkbox
          checked={selectedIds.includes(task.id)}
          onCheckedChange={() => toggleSelected(task.id)}
          onClick={(e) => e.stopPropagation()}
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">
          {task.name}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {task.source === "project"
            ? t("chat:automation.list.sourceProject", {
                name: task.workspaceName,
              })
            : t("chat:automation.list.sourceLocal")}
          {" · "}
          {task.scheduleText}
        </p>
      </div>
      {task.status === "error" && (
        <Badge
          variant="destructive"
          title={t("chat:automation.status.errorTip", {
            note: task.statusNote ?? "",
          })}
        >
          {t("chat:automation.status.error")}
        </Badge>
      )}
      {task.status === "expired" && (
        <Badge variant="secondary">{t("chat:automation.status.expired")}</Badge>
      )}
      <span className="text-xs text-muted-foreground">
        {task.enabled
          ? t("chat:automation.status.running")
          : t("chat:automation.status.paused")}
      </span>
      {/* expired 不禁用开关:重新启用走 status→active 恢复路径;
          endAt 已过的任务 toggle 后由调度器下轮重新回收,无害 */}
      <Switch
        checked={task.enabled}
        onCheckedChange={handleToggle}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

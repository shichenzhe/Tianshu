/**
 * 解绑工作空间目录确认弹窗（侧边栏菜单与路径 chip 共用）：
 * workspace 非 null 时打开，确认后走解绑通道并失效工作空间缓存
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

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
import type { WorkspaceRecord } from "../../api/workspace.api";
import { mapIpcError } from "../lib/error-message";
import { unbindWorkspaceDirectory } from "../lib/workspace-actions";

interface UnbindDirectoryDialogProps {
  /** 待解绑工作空间；null 表示弹窗关闭 */
  workspace: WorkspaceRecord | null;
  /** 开关回调：父级据此清空待解绑状态 */
  onOpenChange: (open: boolean) => void;
  /** 解绑成功回调（缓存已失效） */
  onUnbound: () => void;
}

export default function UnbindDirectoryDialog({
  workspace,
  onOpenChange,
  onUnbound,
}: UnbindDirectoryDialogProps) {
  const { t } = useTranslation(["chat", "common"]);
  const queryClient = useQueryClient();
  const [submitting, setSubmitting] = useState(false);

  const handleUnbind = async () => {
    if (!workspace || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      await unbindWorkspaceDirectory(queryClient, workspace.id);
      onUnbound();
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AlertDialog open={workspace !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent className="border border-border/50 rounded-lg shadow-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("chat:workspace.unbindConfirmTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {workspace
              ? `${workspace.name} · ${t("chat:workspace.unbindConfirmDesc")}`
              : t("chat:workspace.unbindConfirmDesc")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={handleUnbind} disabled={submitting}>
            {t("chat:workspace.unbindDirectory")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

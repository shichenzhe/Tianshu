/**
 * 重置记忆确认弹窗（spec §6.3）：三行警告（清空不可恢复 / 开关开启则
 * 后续仍会生成 / 彻底停用请关闭功能）+ 取消 + 重置记忆。确认 →
 * await onConfirm 清空记忆 → 成功 toast + 关闭；失败 toast 且保持打开。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface ResetMemoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 确认重置（清空记忆落库；reject = 失败，弹窗保持打开并 toast error） */
  onConfirm: () => Promise<void>;
}

export default function ResetMemoryDialog({
  open,
  onOpenChange,
  onConfirm,
}: ResetMemoryDialogProps) {
  const { t } = useTranslation(["settings"]);
  const [resetting, setResetting] = useState(false);

  /** 确认：成功 toast + 关闭；失败 toast + 保持打开 */
  const handleConfirm = async () => {
    setResetting(true);
    try {
      await onConfirm();
      toast.success(t("settings:memory.toast.reset"));
      onOpenChange(false);
    } catch {
      toast.error(t("settings:error.saveFailed"));
    } finally {
      setResetting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md border-border/50 rounded-lg shadow-lg">
        <DialogHeader>
          <DialogTitle>{t("settings:memory.resetDialog.title")}</DialogTitle>
        </DialogHeader>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li>{t("settings:memory.resetDialog.warning1")}</li>
          <li>{t("settings:memory.resetDialog.warning2")}</li>
          <li>{t("settings:memory.resetDialog.warning3")}</li>
        </ul>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
          >
            {t("common:cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={resetting}
            onClick={() => void handleConfirm()}
          >
            {t("settings:memory.resetDialog.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

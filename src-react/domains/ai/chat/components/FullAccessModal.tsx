/**
 * 完全访问确认弹窗（P3）：AlertDialog 强制模态，勾选免责声明后才能确认
 * 确认/取消均不改权限态，决议交由调用方（ChatPane）onConfirm 落库
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

interface FullAccessModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 免责勾选后点击确认时触发（权限写入由调用方完成） */
  onConfirm: () => void;
}

export default function FullAccessModal({
  open,
  onOpenChange,
  onConfirm,
}: FullAccessModalProps) {
  const { t } = useTranslation(["chat", "common"]);
  const [acknowledged, setAcknowledged] = useState(false);

  // 每次打开重置免责勾选，上次的确认/取消不残留
  useEffect(() => {
    if (open) {
      setAcknowledged(false);
    }
  }, [open]);

  const handleConfirm = () => {
    onConfirm();
    onOpenChange(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="border border-border/50 rounded-lg shadow-lg sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {"⚠️ "}
            {t("chat:permission.modalTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("chat:permission.modalRisk")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="space-y-1.5 text-sm text-muted-foreground">
          <li className="flex items-start gap-2">
            <span aria-hidden>{"📂"}</span>
            <span>{t("chat:permission.fileOps")}</span>
          </li>
          <li className="flex items-start gap-2">
            <span aria-hidden>{"💻"}</span>
            <span>{t("chat:permission.terminalOps")}</span>
          </li>
        </ul>
        <div className="flex items-start gap-2">
          <Checkbox
            id="full-access-disclaimer"
            checked={acknowledged}
            onCheckedChange={(checked) => setAcknowledged(checked === true)}
            className="mt-0.5"
          />
          <Label
            htmlFor="full-access-disclaimer"
            className="cursor-pointer text-sm font-normal leading-snug"
          >
            {t("chat:permission.disclaimer")}
          </Label>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={!acknowledged}
            onClick={handleConfirm}
          >
            {t("chat:permission.confirmFullAccess")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

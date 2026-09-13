/**
 * 视图命名弹窗（重命名 / 保存为新视图共用）：标题与初始名外部传入，
 * trim 非空才可确认；Esc/取消关闭不动数据。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface PlanViewNameDialogProps {
  open: boolean;
  title: string;
  initialName: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (name: string) => void;
}

export default function PlanViewNameDialog({
  open,
  title,
  initialName,
  onOpenChange,
  onConfirm,
}: PlanViewNameDialogProps) {
  const { t } = useTranslation(["project", "common"]);
  const [name, setName] = useState(initialName);

  useEffect(() => {
    if (open) {
      setName(initialName);
    }
  }, [open, initialName]);

  const trimmed = name.trim();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="rounded-lg border-border/50 shadow-lg sm:max-w-sm"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-label={title}
          autoFocus
        />
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
          >
            {t("common:cancel")}
          </Button>
          <Button disabled={!trimmed} onClick={() => onConfirm(trimmed)}>
            {t("common:confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

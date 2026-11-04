// src-react/domains/ai/automation/components/ScheduleDialog.tsx
/** 频率编辑弹窗:内嵌 SchedulePicker(受控实时回写),footer 完成即关闭 */
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SchedulePicker } from "./SchedulePicker";
import type { ScheduleConfig } from "../api/schedule.schema";

/** 有效期形状(与表单 values.validity/SchedulePicker 一致) */
interface ScheduleValidity {
  startAt?: string;
  endAt?: string;
}

export interface ScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schedule: ScheduleConfig | null;
  validity: ScheduleValidity;
  /** 实时回写:schedule 或 validity 任一变化即上抛(无需确认) */
  onChange: (
    schedule: ScheduleConfig | null,
    validity: ScheduleValidity,
  ) => void;
}

export function ScheduleDialog({
  open,
  onOpenChange,
  schedule,
  validity,
  onChange,
}: ScheduleDialogProps) {
  const { t } = useTranslation(["chat"]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl border border-border/50 rounded-lg shadow-lg">
        <DialogHeader>
          <DialogTitle>{t("chat:automation.detail.schedule")}</DialogTitle>
        </DialogHeader>
        <SchedulePicker
          value={schedule}
          onChange={(cfg) => onChange(cfg, validity)}
          validity={validity}
          onValidityChange={(v) => onChange(schedule, v)}
        />
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>{t("common:ok")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

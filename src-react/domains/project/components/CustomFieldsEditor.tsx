/**
 * 项目自定义字段定义管理弹窗（spec §6 计划 Tab「管理字段」入口）：
 * 打开时回填当前定义（listFields）→ 行内编辑（名称 Input + 类型 Select 三枚举
 * + 删除行）+ 添加行 → 保存 saveFields（trim 名全集）→ invalidate planFields +
 * planItems（行内值随定义刷新；被删字段的行内值由后端同步清理）→ toast(plan:saved)
 * + 关闭。空名/重名前端禁用提交（后端同名校验兜底）；失败 toast mapIpcError。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { mapIpcError } from "@/domains/ai/chat/lib/error-message";
import PlanItemApi, {
  PLAN_FIELDS_KEY,
  PLAN_ITEMS_KEY,
} from "../api/plan-item.api";
import type {
  PlanFieldDef,
  PlanFieldType,
} from "../../../../electron/domains/project/plan-item.entity";

interface CustomFieldsEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 项目 id（本地任务无自定义字段，不进入本弹窗） */
  projectId: number;
}

const FIELD_TYPES: PlanFieldType[] = ["text", "number", "date"];
const FIELD_TYPE_LABEL_KEYS: Record<PlanFieldType, string> = {
  text: "project:plan.fieldText",
  number: "project:plan.fieldNumber",
  date: "project:plan.fieldDate",
};

export default function CustomFieldsEditor({
  open,
  onOpenChange,
  projectId,
}: CustomFieldsEditorProps) {
  const { t } = useTranslation(["project", "common"]);
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<PlanFieldDef[]>([]);
  const [saving, setSaving] = useState(false);

  const { data: fieldDefs = [] } = useQuery({
    queryKey: PLAN_FIELDS_KEY(projectId),
    queryFn: () => PlanItemApi.listFields(projectId),
    enabled: open,
  });

  // 打开时（或定义内容变化时）回填行编辑状态；内容不变的后台重取不打断编辑
  const defsKey = JSON.stringify(fieldDefs);
  useEffect(() => {
    if (open) {
      setRows(JSON.parse(defsKey) as PlanFieldDef[]);
      setSaving(false);
    }
  }, [open, defsKey]);

  const trimmedNames = rows.map((row) => row.name.trim());
  const namesValid =
    trimmedNames.every(Boolean) &&
    new Set(trimmedNames).size === trimmedNames.length;

  const updateRow = (index: number, patch: Partial<PlanFieldDef>) => {
    setRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  };

  const handleSave = async () => {
    if (!namesValid || saving) {
      return;
    }
    setSaving(true);
    try {
      await PlanItemApi.saveFields(
        projectId,
        rows.map((row) => ({ name: row.name.trim(), type: row.type })),
      );
      await queryClient.invalidateQueries({
        queryKey: PLAN_FIELDS_KEY(projectId),
      });
      await queryClient.invalidateQueries({
        queryKey: PLAN_ITEMS_KEY(projectId),
      });
      toast.success(t("project:plan.saved"));
      onOpenChange(false);
    } catch (error) {
      toast.error(mapIpcError(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="max-h-[85vh] overflow-y-auto rounded-lg border-border/50 shadow-lg sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>{t("project:plan.manageFields")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-2">
          {rows.map((row, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input
                aria-label={t("project:plan.fieldName")}
                placeholder={t("project:plan.fieldName")}
                value={row.name}
                onChange={(event) =>
                  updateRow(index, { name: event.target.value })
                }
                className="flex-1"
              />
              <Select
                value={row.type}
                onValueChange={(value) =>
                  updateRow(index, { type: value as PlanFieldType })
                }
              >
                <SelectTrigger
                  aria-label={t("project:plan.fieldType")}
                  className="w-28"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FIELD_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {t(FIELD_TYPE_LABEL_KEYS[type])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("project:plan.delete")}
                onClick={() =>
                  setRows((prev) => prev.filter((_, i) => i !== index))
                }
                className="hover:bg-primary-subtle hover:text-primary"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setRows((prev) => [...prev, { name: "", type: "text" }])
            }
            className="gap-1 hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("project:plan.addField")}
          </Button>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
          >
            {t("common:cancel")}
          </Button>
          <Button onClick={handleSave} disabled={!namesValid || saving}>
            {saving ? t("common:saving") : t("common:save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

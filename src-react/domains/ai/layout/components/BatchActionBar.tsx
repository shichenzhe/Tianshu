/**
 * 批量管理底部操作栏（侧边栏批量模式）：左 全选复选框+实时计数，
 * 右 删除(红框)/归档(灰框) 大按钮 + X 退出；未选中时按钮置灰防误触
 */
import { useTranslation } from "react-i18next";
import { Archive, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

interface BatchActionBarProps {
  selectedCount: number;
  /** 全选框态：true 全选 / "indeterminate" 部分选中 / false 未选 */
  allChecked: boolean | "indeterminate";
  onToggleAll: () => void;
  onDelete: () => void;
  onArchive: () => void;
  onExit: () => void;
  submitting: boolean;
}

export default function BatchActionBar({
  selectedCount,
  allChecked,
  onToggleAll,
  onDelete,
  onArchive,
  onExit,
  submitting,
}: BatchActionBarProps) {
  const { t } = useTranslation(["chat", "common"]);
  const empty = selectedCount === 0;

  return (
    <div className="shrink-0 border-t border-border/50 bg-card p-2.5">
      {/* 控制区：全选 + 计数 + 退出 */}
      <div className="flex items-center justify-between">
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <Checkbox
            checked={allChecked}
            onCheckedChange={onToggleAll}
            disabled={submitting}
            aria-label={t("chat:task.batchSelectAll")}
          />
          {t("chat:task.batchSelectAll")} ({selectedCount})
        </label>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
          onClick={onExit}
          aria-label={t("common:close")}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      {/* 功能键区：删除 / 归档 */}
      <div className="mt-2 flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={empty || submitting}
          onClick={onDelete}
          className="h-8 flex-1 border-destructive/60 text-destructive hover:bg-destructive hover:text-destructive-foreground disabled:opacity-50"
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t("chat:task.batchDelete")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={empty || submitting}
          onClick={onArchive}
          className="h-8 flex-1"
        >
          <Archive className="h-3.5 w-3.5" />
          {t("chat:task.batchArchive")}
        </Button>
      </div>
    </div>
  );
}

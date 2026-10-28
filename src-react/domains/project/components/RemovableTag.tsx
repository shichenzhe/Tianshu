/**
 * 可移除标签 chip：名称 + X 按钮（aria-label common:close）。
 * 新建项目能力挂载与计划事项标签编辑共用（自 CreateProjectDialog 抽取）。
 */
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";

interface RemovableTagProps {
  name: string;
  onRemove: () => void;
}

export default function RemovableTag({ name, onRemove }: RemovableTagProps) {
  const { t } = useTranslation(["common"]);
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-primary-subtle px-2 py-0.5 text-xs text-primary">
      {name}
      <button
        type="button"
        aria-label={t("common:close")}
        onClick={onRemove}
        className="rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

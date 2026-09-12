/**
 * 单类能力挂载行（配置面板区块2 子组件，Task 10）：
 * icon + 数量徽标 + 已挂载 Tag 列表 + 添加按钮（打开 PickerDialog）。
 * Tag 语义（Task 6 裁定）：valid 正常色；失效灰显 + invalid 徽标 +
 * X 显式移除（直接 setBindings 该类型剩余集，编辑路径不静默丢弃）。
 */
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ProjectBindingItem } from "../../../../electron/domains/project/project.entity";

interface CapabilityRowProps {
  label: string;
  icon: LucideIcon;
  bindings: ProjectBindingItem[];
  addingDisabled: boolean;
  onAdd: () => void;
  onRemoveInvalid: (itemId: number) => void;
}

/** 单类能力挂载行：icon + 数量徽标 + 已挂载 Tag 列表（失效灰显可移除）+ 添加 */
export default function CapabilityRow({
  label,
  icon: Icon,
  bindings,
  addingDisabled,
  onAdd,
  onRemoveInvalid,
}: CapabilityRowProps) {
  const { t } = useTranslation(["project"]);
  return (
    <section aria-label={label} className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <Icon className="h-4 w-4 text-primary" />
          {label}
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
            {bindings.length}
          </Badge>
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={addingDisabled}
          onClick={onAdd}
          className="h-7 gap-1 px-2 hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
        >
          <Plus className="h-3.5 w-3.5" />
          {t("project:create.add")}
        </Button>
      </div>
      {bindings.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {bindings.map((binding) => (
            <BindingTag
              key={binding.id}
              binding={binding}
              onRemove={() => onRemoveInvalid(binding.itemId)}
            />
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t("project:picker.empty")}
        </p>
      )}
    </section>
  );
}

interface BindingTagProps {
  binding: ProjectBindingItem;
  onRemove: () => void;
}

/** 已挂载 Tag：valid 正常色；失效灰显 + invalid 徽标 + X 显式移除 */
function BindingTag({ binding, onRemove }: BindingTagProps) {
  const { t } = useTranslation(["project", "common"]);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs",
        binding.valid
          ? "bg-primary-subtle text-primary"
          : "bg-muted text-muted-foreground",
      )}
    >
      {binding.itemName}
      {!binding.valid && (
        <>
          <span className="text-[10px] text-muted-foreground/70">
            {t("project:create.invalid")}
          </span>
          <button
            type="button"
            aria-label={t("common:close")}
            onClick={onRemove}
            className="rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <X className="h-3 w-3" />
          </button>
        </>
      )}
    </span>
  );
}

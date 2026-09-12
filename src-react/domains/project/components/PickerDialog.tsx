/**
 * PickerDialog 通用多选弹窗：头部搜索框（name/tags/description 客户端
 * 不区分大小写过滤）+ 复选行列表（名称/描述/标签徽标）+ 底部已选计数
 * 与取消/确定。确定回传完整选中 id 集合（初始 selectedIds + 用户勾选合并，
 * 按 items 顺序稳定输出）；取消只关闭不回调 onConfirm。
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface PickerItem {
  id: number;
  name: string;
  description?: string;
  tags?: string[]; // 专家的擅长领域标签
}

interface PickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  items: PickerItem[];
  selectedIds: number[];
  onConfirm: (ids: number[]) => void;
  searchPlaceholder?: string;
}

/** 取条目可检索文本（name/description/tags）做小写包含匹配 */
const matchesKeyword = (item: PickerItem, keyword: string) =>
  [item.name, item.description, ...(item.tags ?? [])]
    .filter((text): text is string => !!text)
    .some((text) => text.toLowerCase().includes(keyword));

export default function PickerDialog({
  open,
  onOpenChange,
  title,
  items,
  selectedIds,
  onConfirm,
  searchPlaceholder,
}: PickerDialogProps) {
  const { t } = useTranslation(["project"]);
  const [keyword, setKeyword] = useState("");
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(selectedIds),
  );

  // 弹窗打开或外部选中变化时，重置搜索词与勾选态
  useEffect(() => {
    if (open) {
      setKeyword("");
      setSelected(new Set(selectedIds));
    }
  }, [open, selectedIds]);

  const trimmedKeyword = keyword.trim().toLowerCase();
  const filteredItems = useMemo(
    () =>
      trimmedKeyword
        ? items.filter((item) => matchesKeyword(item, trimmedKeyword))
        : items,
    [items, trimmedKeyword],
  );

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCancel = () => onOpenChange(false);

  const handleConfirm = () => {
    onConfirm(items.filter((item) => selected.has(item.id)).map((i) => i.id));
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="rounded-lg border-border/50 shadow-lg sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={
                searchPlaceholder ?? t("project:picker.searchPlaceholder")
              }
              className="pl-9"
              aria-label={t("project:picker.searchPlaceholder")}
            />
          </div>
        </DialogHeader>

        {/* 复选行列表（整行可点切换勾选） */}
        {filteredItems.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t("project:picker.empty")}
          </p>
        ) : (
          <div className="max-h-[320px] space-y-2 overflow-y-auto pr-1">
            {filteredItems.map((item) => {
              const checked = selected.has(item.id);
              return (
                <button
                  type="button"
                  key={item.id}
                  role="checkbox"
                  aria-checked={checked}
                  onClick={() => toggle(item.id)}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-lg border border-border/50 p-3 text-left transition-colors hover:border-primary/30 hover:bg-primary-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                    checked && "border-primary/50 bg-primary-subtle",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-primary transition-colors",
                      checked
                        ? "bg-primary text-primary-foreground"
                        : "bg-transparent text-transparent",
                    )}
                  >
                    <Check className="h-3 w-3" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground">
                      {item.name}
                    </span>
                    {item.description && (
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {item.description}
                      </span>
                    )}
                    {item.tags && item.tags.length > 0 && (
                      <span className="mt-1.5 flex flex-wrap gap-1">
                        {item.tags.map((tag) => (
                          <Badge
                            key={tag}
                            variant="secondary"
                            className="px-1.5 py-0 text-[10px] font-normal"
                          >
                            {tag}
                          </Badge>
                        ))}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <DialogFooter className="sm:justify-between sm:space-x-0">
          <span className="text-xs text-muted-foreground sm:mr-auto sm:self-center">
            {t("project:picker.selectedCount", { count: selected.size })}
          </span>
          <div className="flex space-x-2">
            <Button
              variant="outline"
              onClick={handleCancel}
              className="hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
            >
              {t("project:picker.cancel")}
            </Button>
            <Button onClick={handleConfirm}>
              {t("project:picker.confirm")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

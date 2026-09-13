/**
 * 视图 Tab 栏（子系统 A spec §UI）：Tab 切换（激活高亮、默认视图 name
 * 空串显示本地化类型名）、+ 添加视图（A 阶段仅看板）、Tab hover/键盘聚焦
 * `...` 菜单（重命名/删除；最后一个视图不显示删除）、isDirty 圆点。
 * 命名弹窗（重命名）内聚在本组件；「保存为新视图」入口在筛选面板（Task 10）。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, MoreHorizontal, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import PlanViewNameDialog from "./PlanViewNameDialog";
import { PLAN_VIEW_NAME_KEYS } from "../../../../electron/domains/project/plan-view.entity";
import type {
  PlanViewRecord,
  PlanViewType,
} from "../../../../electron/domains/project/plan-view.entity";

interface PlanViewTabsProps {
  views: PlanViewRecord[];
  activeViewId: number | null;
  isDirty: boolean;
  onSelect: (id: number) => void;
  onAdd: (type: PlanViewType) => void;
  onRename: (id: number, name: string) => void;
  onRemove: (id: number) => void;
}

/** A 阶段可添加的视图类型（列表/甘特/日历 C 阶段点亮） */
const ADDABLE_TYPES: PlanViewType[] = ["kanban"];

export default function PlanViewTabs({
  views,
  activeViewId,
  isDirty,
  onSelect,
  onAdd,
  onRename,
  onRemove,
}: PlanViewTabsProps) {
  const { t } = useTranslation(["project", "common"]);
  const [renaming, setRenaming] = useState<PlanViewRecord | null>(null);
  const [menuOpenFor, setMenuOpenFor] = useState<number | null>(null);

  return (
    <div className="flex items-center gap-1 border-b border-border/50 px-4 py-1.5">
      {views.map((view) => (
        <div key={view.id} className="group/tab relative flex items-center">
          <button
            type="button"
            aria-pressed={view.id === activeViewId}
            data-dirty={
              view.id === activeViewId && isDirty ? "true" : undefined
            }
            onClick={() => onSelect(view.id)}
            className={cn(
              "flex items-center gap-1 rounded-md px-2.5 py-1 text-xs transition-colors",
              view.id === activeViewId
                ? "bg-primary-subtle font-medium text-primary"
                : "text-muted-foreground hover:bg-primary-subtle hover:text-primary",
            )}
          >
            {view.name || t(PLAN_VIEW_NAME_KEYS[view.type])}
            {view.id === activeViewId && isDirty && (
              <span
                title={t("project:planView.unsaved")}
                className="h-1.5 w-1.5 rounded-full bg-primary"
              />
            )}
          </button>
          <DropdownMenu
            open={menuOpenFor === view.id}
            onOpenChange={(open) => setMenuOpenFor(open ? view.id : null)}
          >
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t("project:planView.tabMenu")}
                className={cn(
                  "ml-0.5 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity",
                  "hover:bg-primary-subtle hover:text-primary group-hover/tab:opacity-100 focus-visible:opacity-100",
                )}
              >
                <MoreHorizontal className="h-3 w-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="rounded-lg border border-border/50 shadow-lg"
            >
              <DropdownMenuItem
                onSelect={() => {
                  setRenaming(view);
                  setMenuOpenFor(null);
                }}
              >
                {t("project:planView.rename")}
              </DropdownMenuItem>
              {views.length > 1 && (
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={() => {
                    onRemove(view.id);
                    setMenuOpenFor(null);
                  }}
                >
                  {t("common:delete")}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ))}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("project:planView.addView")}
            className="h-7 gap-0.5 px-2 text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary"
          >
            <Plus className="h-3.5 w-3.5" />
            <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="rounded-lg border border-border/50 shadow-lg"
        >
          {ADDABLE_TYPES.map((type) => (
            <DropdownMenuItem key={type} onSelect={() => onAdd(type)}>
              {t(PLAN_VIEW_NAME_KEYS[type])}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <PlanViewNameDialog
        open={renaming !== null}
        title={t("project:planView.rename")}
        initialName={renaming?.name ?? ""}
        onOpenChange={(open) => {
          if (!open) {
            setRenaming(null);
          }
        }}
        onConfirm={(name) => {
          if (renaming) {
            onRename(renaming.id, name);
          }
          setRenaming(null);
        }}
      />
    </div>
  );
}

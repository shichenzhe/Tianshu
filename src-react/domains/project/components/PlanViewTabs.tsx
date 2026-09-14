/**
 * 视图 Tab 栏（子系统 A spec §UI + B 阶段拖拽排序）：Tab 切换（激活高亮、
 * 默认视图 name 空串显示本地化类型名）、dnd-kit 横向拖拽排序（落点语义抽
 * reorderTabViews 纯函数：把 active 移到 over 位置并重排 sortOrder，原位/
 * 未知 no-op）、+ 添加视图（看板/列表）、Tab hover/键盘聚焦 `...` 菜单
 * （重命名/删除；最后一个视图不显示删除）、isDirty 圆点。命名弹窗（重命名）
 * 内聚在本组件；「保存为新视图」入口在筛选面板。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
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
  /** 拖拽落点后的新顺序（视图 id 序，0..n-1 即新 sortOrder） */
  onReorder: (orderedIds: number[]) => void;
}

/** 可添加的视图类型（C 阶段列表已点亮；甘特/日历待 T5/T6） */
const ADDABLE_TYPES: PlanViewType[] = ["kanban", "list"];

/**
 * Tab 拖拽落点（纯函数）：把 active 移到 over 位置，重排 sortOrder 为
 * 0..n-1（即落库载荷序）；原位（active===over）或未知 id → null（no-op）。
 */
export function reorderTabViews(
  views: PlanViewRecord[],
  activeId: number,
  overId: number,
): PlanViewRecord[] | null {
  if (activeId === overId) {
    return null;
  }
  const moving = views.find((view) => view.id === activeId);
  const rest = views.filter((view) => view.id !== activeId);
  const insertAt = rest.findIndex((view) => view.id === overId);
  if (!moving || insertAt === -1) {
    return null;
  }
  rest.splice(insertAt, 0, moving);
  return rest.map((view, index) => ({ ...view, sortOrder: index }));
}

interface SortableTabProps {
  view: PlanViewRecord;
  isActive: boolean;
  isDirty: boolean;
  deletable: boolean;
  menuOpen: boolean;
  onSelect: () => void;
  onRename: () => void;
  onRemove: () => void;
  onMenuOpenChange: (open: boolean) => void;
}

/** 可拖拽 Tab（PointerSensor 6px 区分点击与拖拽；`...` 菜单不参与拖拽） */
function SortableTab({
  view,
  isActive,
  isDirty,
  deletable,
  menuOpen,
  onSelect,
  onRename,
  onRemove,
  onMenuOpenChange,
}: SortableTabProps) {
  const { t } = useTranslation(["project", "common"]);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: String(view.id) });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "group/tab relative flex items-center",
        isDragging && "opacity-50",
      )}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-pressed={isActive}
        data-dirty={isActive && isDirty ? "true" : undefined}
        onClick={onSelect}
        className={cn(
          "flex items-center gap-1 rounded-md px-2.5 py-1 text-xs transition-colors",
          isActive
            ? "bg-primary-subtle font-medium text-primary"
            : "text-muted-foreground hover:bg-primary-subtle hover:text-primary",
        )}
      >
        {view.name || t(PLAN_VIEW_NAME_KEYS[view.type])}
        {isActive && isDirty && (
          <span
            title={t("project:planView.unsaved")}
            className="h-1.5 w-1.5 rounded-full bg-primary"
          />
        )}
      </button>
      <DropdownMenu open={menuOpen} onOpenChange={onMenuOpenChange}>
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
          <DropdownMenuItem onSelect={onRename}>
            {t("project:planView.rename")}
          </DropdownMenuItem>
          {deletable && (
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={onRemove}
            >
              {t("common:delete")}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export default function PlanViewTabs({
  views,
  activeViewId,
  isDirty,
  onSelect,
  onAdd,
  onRename,
  onRemove,
  onReorder,
}: PlanViewTabsProps) {
  const { t } = useTranslation(["project", "common"]);
  const [renaming, setRenaming] = useState<PlanViewRecord | null>(null);
  const [menuOpenFor, setMenuOpenFor] = useState<number | null>(null);
  // 距离阈值：6px 内视为点击（切换视图），超过才进入拖拽
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  /** 拖拽结束：纯函数推导新顺序，无效落点 no-op */
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over) {
      return;
    }
    const next = reorderTabViews(views, Number(active.id), Number(over.id));
    if (next) {
      onReorder(next.map((view) => view.id));
    }
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <div className="flex items-center gap-1 border-b border-border/50 px-4 py-1.5">
        <SortableContext
          items={views.map((view) => String(view.id))}
          strategy={horizontalListSortingStrategy}
        >
          {views.map((view) => (
            <SortableTab
              key={view.id}
              view={view}
              isActive={view.id === activeViewId}
              isDirty={isDirty}
              deletable={views.length > 1}
              menuOpen={menuOpenFor === view.id}
              onSelect={() => onSelect(view.id)}
              onRename={() => {
                setRenaming(view);
                setMenuOpenFor(null);
              }}
              onRemove={() => {
                onRemove(view.id);
                setMenuOpenFor(null);
              }}
              onMenuOpenChange={(open) => setMenuOpenFor(open ? view.id : null)}
            />
          ))}
        </SortableContext>

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
    </DndContext>
  );
}

/**
 * 计划看板视图（spec §6 计划 Tab 看板分支，dnd-kit 四态泳道）：
 * 四列（PLAN_STATUSES 序）横向滚动，列头 = 状态名 + 计数 Badge + 列内 +（预置
 * 该列状态的新建弹窗，由 PlanPane 打开）；卡片 = 优先级左色条（P0 destructive /
 * P1 primary / P2 muted）+ 标题 + 标签 Badge（最多 3 个 + "+N"）+ "我"头像点，
 * 点击卡片 = onEdit（拖拽与点击由 PointerSensor 距离阈值区分）。
 * 拖拽落点语义抽为模块级纯函数（jsdom 不模拟 pointer 拖拽，单测直接覆盖语义）：
 * - computeDrop：active/over → 目标 status + afterId（落点前一项 id）或 null
 *   （同列原位 no-op）；sortOrder 由 PlanPane 以全量缓存目标列推导（防筛选错序）
 * - computeSortOrder：afterId 缺省=列尾 max+1；有 afterId=与后一项均值取整
 *   （后无项 +1；取整 ≤0 保底 1；afterId 不在列容错回落列尾）
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  DndContext,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useUserStore } from "@/domains/user/store/user.store";
import { STATUS_LABEL_KEYS } from "./PlanItemDialog";
import { PLAN_STATUSES } from "../../../../electron/domains/project/plan-item.entity";
import type {
  PlanItemRecord,
  PlanPriority,
  PlanStatus,
} from "../../../../electron/domains/project/plan-item.entity";

/** 卡片标签展示上限，超出折叠为 "+N" */
const MAX_CARD_TAGS = 3;

/** 优先级左色条：P0 警示 / P1 主题色 / P2 弱化 */
const PRIORITY_BORDER_CLASSES: Record<PlanPriority, string> = {
  P0: "border-l-destructive",
  P1: "border-l-primary",
  P2: "border-l-muted-foreground/40",
};

/** 一列泳道（status + 该列可见事项，展示序） */
export interface KanbanColumnData {
  status: PlanStatus;
  items: PlanItemRecord[];
}

/** 有效落点：目标列 + 落点前一项 id（缺省 = 列尾） */
export interface KanbanDropResult {
  status: PlanStatus;
  afterId?: number;
}

/**
 * 落点推导（纯函数）：over 为列 id → 该列列尾；over 为卡片 id → 该卡所在列 +
 * afterId=该卡 id（插到其后）；同列原位（落点=自身/前一项/本列背景）→ null。
 * 列内顺序按传入 columns 的展示序（可见序列）判定原位。
 */
export function computeDrop(
  activeId: number,
  overId: string,
  columns: KanbanColumnData[],
): KanbanDropResult | null {
  const activeColumn = columns.find((column) =>
    column.items.some((item) => item.id === activeId),
  );
  if (!activeColumn) {
    return null;
  }
  // 落在列本体（列头/背景）：同列无卡片落点 = 原位，跨列 = 列尾
  if ((PLAN_STATUSES as readonly string[]).includes(overId)) {
    return activeColumn.status === overId
      ? null
      : { status: overId as PlanStatus, afterId: undefined };
  }
  const overCardId = Number(overId);
  // 落点=自身：原地释放，no-op（自身已从 rest 剔除，不得按列首重插）
  if (overCardId === activeId) {
    return null;
  }
  const overColumn = columns.find((column) =>
    column.items.some((item) => item.id === overCardId),
  );
  if (!overColumn) {
    return null;
  }
  // 同列重排：移除自身后按 afterId 重插，序列不变即原位 no-op
  if (overColumn.status === activeColumn.status) {
    const ids = overColumn.items.map((item) => item.id);
    const rest = ids.filter((id) => id !== activeId);
    const insertAt = rest.indexOf(overCardId) + 1;
    const reordered = [
      ...rest.slice(0, insertAt),
      activeId,
      ...rest.slice(insertAt),
    ];
    if (reordered.every((id, index) => id === ids[index])) {
      return null;
    }
  }
  return { status: overColumn.status, afterId: overCardId };
}

/** 列内最大序（空列 0 → 新序 1） */
const columnMaxSortOrder = (items: PlanItemRecord[]): number =>
  items.reduce((max, item) => Math.max(max, item.sortOrder), 0);

/**
 * 列内序号（纯函数）：afterId 缺省 → 列尾 max+1；有 afterId → 该项与其后一项
 * 均值取整（后无项 +1；取整 ≤0 保底 1；afterId 不在列容错回落列尾）。
 * 列内顺序按 sortOrder（id 兜底）推导，与调用方数组序无关。
 */
export function computeSortOrder(
  columnItems: PlanItemRecord[],
  afterId?: number,
): number {
  const sorted = [...columnItems].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.id - b.id,
  );
  if (afterId === undefined) {
    return columnMaxSortOrder(sorted) + 1;
  }
  const afterIndex = sorted.findIndex((item) => item.id === afterId);
  if (afterIndex === -1) {
    return columnMaxSortOrder(sorted) + 1;
  }
  const after = sorted[afterIndex];
  const next = sorted[afterIndex + 1];
  if (!next) {
    return after.sortOrder + 1;
  }
  const mean = Math.floor((after.sortOrder + next.sortOrder) / 2);
  return mean > 0 ? mean : 1;
}

interface PlanKanbanViewProps {
  /** 过滤排序后的可见事项（PlanPane 计算传入；序号仍由 PlanPane 全量推导） */
  items: PlanItemRecord[];
  /** 拖拽落点 → 父层 move 通道（id + 目标状态 + 落点前一项 id） */
  onMove: (id: number, status: PlanStatus, afterId?: number) => Promise<void>;
  /** 列头 + → 父层以该列状态预置打开新建弹窗 */
  onQuickCreate: (status: PlanStatus) => void;
  /** 点击卡片 → 父层打开编辑弹窗 */
  onEdit: (item: PlanItemRecord) => void;
}

/** 可排序卡片：整体可拖可点（PointerSensor 距离阈值区分拖拽与点击） */
function KanbanCard({
  item,
  onEdit,
}: {
  item: PlanItemRecord;
  onEdit: (item: PlanItemRecord) => void;
}) {
  const { t } = useTranslation(["project"]);
  const user = useUserStore((state) => state.user);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: String(item.id) });

  const visibleTags = item.tags.slice(0, MAX_CARD_TAGS);
  const hiddenTagCount = item.tags.length - visibleTags.length;
  // 单成员预留：头像点取昵称/用户名首字符，兜底「我」
  const avatarChar = (
    user.nickname ||
    user.username ||
    t("project:plan.me")
  ).charAt(0);

  return (
    <button
      type="button"
      ref={setNodeRef}
      onClick={() => onEdit(item)}
      title={item.title}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex w-full flex-col gap-1.5 rounded-lg border border-border/50 border-l-4 bg-background px-3 py-2 text-left shadow-sm transition-shadow hover:shadow-md",
        PRIORITY_BORDER_CLASSES[item.priority],
        isDragging && "opacity-50",
      )}
      {...attributes}
      {...listeners}
    >
      <span className="text-sm font-medium leading-snug">{item.title}</span>
      {(visibleTags.length > 0 || hiddenTagCount > 0) && (
        <span className="flex flex-wrap gap-1">
          {visibleTags.map((tag) => (
            <Badge key={tag} variant="secondary" className="px-1.5 text-[10px]">
              {tag}
            </Badge>
          ))}
          {hiddenTagCount > 0 && (
            <Badge
              variant="outline"
              className="px-1.5 text-[10px] text-muted-foreground"
            >
              +{hiddenTagCount}
            </Badge>
          )}
        </span>
      )}
      <span className="flex items-center justify-end">
        <span
          title={t("project:plan.me")}
          className="flex h-5 w-5 items-center justify-center rounded-full bg-primary-subtle text-[10px] font-medium text-primary"
        >
          {avatarChar}
        </span>
      </span>
    </button>
  );
}

/** 泳道列：列头（状态名 + 计数 + 列内 +）与卡片 droppable 区 */
function KanbanColumn({
  status,
  items,
  onQuickCreate,
  onEdit,
}: {
  status: PlanStatus;
  items: PlanItemRecord[];
  onQuickCreate: (status: PlanStatus) => void;
  onEdit: (item: PlanItemRecord) => void;
}) {
  const { t } = useTranslation(["project"]);
  const { setNodeRef, isOver } = useDroppable({ id: status });

  return (
    <section
      aria-label={t(STATUS_LABEL_KEYS[status])}
      className="flex w-64 shrink-0 flex-col rounded-lg border border-border/50 bg-muted/30"
    >
      <header className="flex items-center gap-1.5 px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground">
          {t(STATUS_LABEL_KEYS[status])}
        </span>
        <Badge variant="secondary" className="px-1.5 text-[10px]">
          {items.length}
        </Badge>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`${t("project:plan.add")} ${t(STATUS_LABEL_KEYS[status])}`}
          onClick={() => onQuickCreate(status)}
          className="ml-auto h-6 w-6 p-0 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </header>
      <SortableContext
        items={items.map((item) => String(item.id))}
        strategy={verticalListSortingStrategy}
      >
        <div
          ref={setNodeRef}
          className={cn(
            "flex min-h-32 flex-1 flex-col gap-2 p-2",
            isOver && "rounded-b-lg bg-primary-subtle/50",
          )}
        >
          {items.map((item) => (
            <KanbanCard key={item.id} item={item} onEdit={onEdit} />
          ))}
        </div>
      </SortableContext>
    </section>
  );
}

export default function PlanKanbanView({
  items,
  onMove,
  onQuickCreate,
  onEdit,
}: PlanKanbanViewProps) {
  const sensors = useSensors(
    // 距离阈值：6px 内视为点击（开编辑），超过才进入拖拽
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const columns: KanbanColumnData[] = useMemo(
    () =>
      PLAN_STATUSES.map((status) => ({
        status,
        items: items.filter((item) => item.status === status),
      })),
    [items],
  );

  /** 拖拽结束：纯函数推导落点，无效落点（同列原位）no-op */
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) {
      return;
    }
    const drop = computeDrop(Number(active.id), String(over.id), columns);
    if (!drop) {
      return;
    }
    void onMove(Number(active.id), drop.status, drop.afterId);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragEnd={handleDragEnd}
    >
      <div className="flex h-full min-h-0 items-stretch gap-3 overflow-x-auto px-4 pb-4 pt-3">
        {columns.map((column) => (
          <KanbanColumn
            key={column.status}
            status={column.status}
            items={column.items}
            onQuickCreate={onQuickCreate}
            onEdit={onEdit}
          />
        ))}
      </div>
    </DndContext>
  );
}

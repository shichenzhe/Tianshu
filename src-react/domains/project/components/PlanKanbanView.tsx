/**
 * 计划看板视图（spec §6 计划 Tab 看板分支，dnd-kit 泳道 + groupBy 泛化）：
 * 列由引擎 groupItems(items, groupBy, members) 生成——status 四态全枚举 /
 * priority P0-P3 全枚举 / assignee 未指派 + 候选成员 + 数据内出现者（空组
 * 即空列保留）；列头 = 分组名（columnLabel：状态/优先级走 i18n key、成员取
 * 昵称、unassigned 取 plan.unassigned）+ 计数 Badge + 列内 +（按分组依据
 * 预置该列值的新建弹窗，由 PlanPane 打开）；卡片 = 优先级左色条（P0
 * destructive / P1 primary / P2 muted / P3 border 最弱）+ 标题 + 标签
 * Badge（最多 3 个 + "+N"）+ 处理人头像（assigneeId → 成员昵称首字符，
 * null/未知成员 → 未指派灰点），点击卡片 = onEdit（拖拽与点击由
 * PointerSensor 距离阈值区分）。
 * 拖拽落点语义抽为模块级纯函数（jsdom 不模拟 pointer 拖拽，单测直接覆盖语义）：
 * - computeDrop：active/over → 目标列 key + afterId（落点前一项 id）或 null
 *   （同列原位 no-op）；列 key = status/priority 枚举值或 assignee 的
 *   unassigned/成员 userId 字符串
 * - computeSortOrder：afterId 缺省=列尾 max+1；有 afterId=与后一项均值取整
 *   （后无项 +1；取整 ≤0 保底 1；afterId 不在列容错回落列尾）——仅
 *   groupBy=status 的 move 通道消费（sortOrder 只属于状态列；priority/
 *   assignee 拖拽跨列仅写字段，afterId 被上层忽略，列内不重排）
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
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
import { MessageSquareText, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PRIORITY_LABEL_KEYS, STATUS_LABEL_KEYS } from "./PlanItemDialog";
import { groupItems } from "../model/plan-view-engine";
import type { ProjectMemberItem } from "../../../../electron/domains/project/project.entity";
import type { PlanGroupBy } from "../../../../electron/domains/project/plan-view.entity";
import type {
  PlanItemRecord,
  PlanPriority,
  PlanStatus,
} from "../../../../electron/domains/project/plan-item.entity";

/** 卡片标签展示上限，超出折叠为 "+N" */
const MAX_CARD_TAGS = 3;

/** 优先级左色条：P0 警示 / P1 主题色 / P2 弱化 / P3 最弱 */
const PRIORITY_BORDER_CLASSES: Record<PlanPriority, string> = {
  P0: "border-l-destructive",
  P1: "border-l-primary",
  P2: "border-l-muted-foreground/40",
  P3: "border-l-border/40",
};

/** 一列泳道（分组 key + 该列可见事项，展示序） */
export interface KanbanColumnData {
  key: string;
  items: PlanItemRecord[];
}

/** 有效落点：目标列 key + 落点前一项 id（缺省 = 列尾） */
export interface KanbanDropResult {
  columnKey: string;
  afterId?: number;
}

/**
 * 落点推导（纯函数）：over 为列 key → 该列列尾；over 为卡片 id → 该卡所在列 +
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
  if (columns.some((column) => column.key === overId)) {
    return activeColumn.key === overId
      ? null
      : { columnKey: overId, afterId: undefined };
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
  if (overColumn.key === activeColumn.key) {
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
  return { columnKey: overColumn.key, afterId: overCardId };
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

/** 列头快速新增的预置值：按分组依据携带对应字段 */
export interface KanbanQuickCreatePreset {
  status?: PlanStatus;
  priority?: PlanPriority;
}

interface PlanKanbanViewProps {
  /** 过滤排序后的可见事项（PlanPane 计算传入；序号仍由 PlanPane 全量推导） */
  items: PlanItemRecord[];
  /** 分组依据：status / priority / assignee（决定列集与拖拽写回字段） */
  groupBy: PlanGroupBy;
  /** 项目成员（assignee 分组候选列 + 卡片头像昵称查找） */
  members: ProjectMemberItem[];
  /** 当前用户 id（与 PlanFilterPopover 同口径传入，供后续「我的」标记等扩展） */
  currentUserId: number;
  /** 拖拽落点 → 父层分发（status 分组走 move；priority/assignee 仅写字段） */
  onMoveItem: (id: number, columnKey: string, afterId?: number) => void;
  /** 列头 + → 父层按分组依据预置该列值打开新建弹窗 */
  onQuickCreate: (preset: KanbanQuickCreatePreset) => void;
  /** 点击卡片 → 父层打开编辑弹窗 */
  onEdit: (item: PlanItemRecord) => void;
  /** 卡片标题区推进（会话直达，批 5 D6）→ 父层 openTaskSession；
   *  本地任务不渲染按钮（计划 Tab 事项恒属项目，防御性判空） */
  onAdvanceSession: (item: PlanItemRecord) => void;
}

/**
 * 列头 label（纯函数）：status/priority 走 i18n key；assignee 的 unassigned
 * 走 plan.unassigned，成员列取昵称（不在成员列表的 key 兜底原样显示）。
 */
function columnLabel(
  key: string,
  groupBy: PlanGroupBy,
  members: ProjectMemberItem[],
  t: TFunction,
): string {
  if (groupBy === "status") {
    return t(STATUS_LABEL_KEYS[key as PlanStatus]);
  }
  if (groupBy === "priority") {
    return t(PRIORITY_LABEL_KEYS[key as PlanPriority]);
  }
  if (key === "unassigned") {
    return t("project:plan.unassigned");
  }
  return members.find((m) => String(m.userId) === key)?.nickname ?? key;
}

/** 可排序卡片：整体可拖可点（PointerSensor 距离阈值区分拖拽与点击） */
function KanbanCard({
  item,
  members,
  onEdit,
  onAdvanceSession,
}: {
  item: PlanItemRecord;
  members: ProjectMemberItem[];
  onEdit: (item: PlanItemRecord) => void;
  onAdvanceSession: (item: PlanItemRecord) => void;
}) {
  const { t } = useTranslation(["project"]);
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
  // 处理人头像：assigneeId 在成员列表找昵称（首字符）；null/未知 → 未指派灰点
  const assignee = members.find((member) => member.userId === item.assigneeId);

  return (
    // 推进钮以兄弟节点叠放标题区右上（批 5 D6）：卡体为承载 dnd listeners
    // 的按钮，button 嵌套不合法——overlay 兄弟按钮避免嵌套且保键盘可达
    <div className="group/card relative w-full">
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
              <Badge
                key={tag}
                variant="secondary"
                className="px-1.5 text-[10px]"
              >
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
          {assignee ? (
            <span
              title={assignee.nickname}
              className="flex h-5 w-5 items-center justify-center rounded-full bg-primary-subtle text-[10px] font-medium text-primary"
            >
              {assignee.nickname.charAt(0)}
            </span>
          ) : (
            <span
              title={t("project:plan.unassigned")}
              aria-label={t("project:plan.unassigned")}
              className="h-5 w-5 rounded-full bg-muted-foreground/25"
            />
          )}
        </span>
      </button>
      {item.projectId != null && (
        <button
          type="button"
          aria-label={t("project:plan.advance")}
          title={t("project:plan.advance")}
          onClick={() => onAdvanceSession(item)}
          className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-primary-subtle hover:text-primary focus-visible:opacity-100 group-hover/card:opacity-100"
        >
          <MessageSquareText className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

/** 泳道列：列头（分组名 + 计数 + 列内 +）与卡片 droppable 区 */
function KanbanColumn({
  columnKey,
  items,
  groupBy,
  members,
  onQuickCreate,
  onEdit,
  onAdvanceSession,
}: {
  columnKey: string;
  items: PlanItemRecord[];
  groupBy: PlanGroupBy;
  members: ProjectMemberItem[];
  onQuickCreate: (preset: KanbanQuickCreatePreset) => void;
  onEdit: (item: PlanItemRecord) => void;
  onAdvanceSession: (item: PlanItemRecord) => void;
}) {
  const { t } = useTranslation(["project"]);
  const { setNodeRef, isOver } = useDroppable({ id: columnKey });
  const label = columnLabel(columnKey, groupBy, members, t);
  // 列头 + 预置值：status/priority 携带该列枚举值，assignee 无可预置字段
  const preset: KanbanQuickCreatePreset =
    groupBy === "status"
      ? { status: columnKey as PlanStatus }
      : groupBy === "priority"
        ? { priority: columnKey as PlanPriority }
        : {};

  return (
    <section
      aria-label={label}
      className="flex w-64 shrink-0 flex-col rounded-lg border border-border/50 bg-muted/30"
    >
      <header className="flex items-center gap-1.5 px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground">
          {label}
        </span>
        <Badge variant="secondary" className="px-1.5 text-[10px]">
          {items.length}
        </Badge>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`${t("project:plan.add")} ${label}`}
          onClick={() => onQuickCreate(preset)}
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
            <KanbanCard
              key={item.id}
              item={item}
              members={members}
              onEdit={onEdit}
              onAdvanceSession={onAdvanceSession}
            />
          ))}
        </div>
      </SortableContext>
    </section>
  );
}

export default function PlanKanbanView({
  items,
  groupBy,
  members,
  onMoveItem,
  onQuickCreate,
  onEdit,
  onAdvanceSession,
}: PlanKanbanViewProps) {
  const sensors = useSensors(
    // 距离阈值：6px 内视为点击（开编辑），超过才进入拖拽
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const columns: KanbanColumnData[] = useMemo(
    () => groupItems(items, groupBy, members),
    [items, groupBy, members],
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
    onMoveItem(Number(active.id), drop.columnKey, drop.afterId);
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
            key={column.key}
            columnKey={column.key}
            items={column.items}
            groupBy={groupBy}
            members={members}
            onQuickCreate={onQuickCreate}
            onEdit={onEdit}
            onAdvanceSession={onAdvanceSession}
          />
        ))}
      </div>
    </DndContext>
  );
}

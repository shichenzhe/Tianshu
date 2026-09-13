/**
 * 计划面板（spec §6 计划 Tab）：单表数据源 PLAN_ITEMS_KEY + 字段定义
 * PLAN_FIELDS_KEY；视图切换 ?view=table|kanban（缺省 table，非法回落，
 * 合并式写入保留 ?tab= 等既有参数）；表格/看板双视图（看板 = PlanKanbanView
 * 四态泳道拖拽）。
 * 工具栏：状态/优先级/标签三组多选筛选（标签候选=当前事项 distinct）+
 * 标题搜索（客户端过滤）+「添加」（PlanItemDialog 新建态）。
 * 行内变更统一在本层处理（表格/看板纯触发）：状态切换与看板落点走 move 通道
 * （sortOrder 由全量缓存目标列推导——无落点=列尾 max+1、有落点=与前一项后邻
 * 均值，防筛选错序），优先级走 update，快速新增走 create——均乐观更新
 * setQueryData、失败 invalidate 回滚；create/remove 后失效
 * planItems + planItemsMine 双 key（T4 契约）；删除 AlertDialog 二次确认。
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CalendarDays,
  ChevronDown,
  LayoutGrid,
  ListFilter,
  Loader2,
  Plus,
  Table as TableIcon,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { mapIpcError } from "@/domains/ai/chat/lib/error-message";
import { useUserStore } from "@/domains/user/store/user.store";
import PlanItemApi, {
  PLAN_FIELDS_KEY,
  PLAN_ITEMS_KEY,
  PLAN_ITEMS_MINE_KEY,
} from "../api/plan-item.api";
import CustomFieldsEditor from "./CustomFieldsEditor";
import PlanItemDialog, {
  PRIORITY_LABEL_KEYS,
  STATUS_LABEL_KEYS,
} from "./PlanItemDialog";
import PlanKanbanView, { computeSortOrder } from "./PlanKanbanView";
import PlanTableView from "./PlanTableView";
import {
  PLAN_PRIORITIES,
  PLAN_STATUSES,
} from "../../../../electron/domains/project/plan-item.entity";
import type {
  PlanItemRecord,
  PlanPriority,
  PlanStatus,
} from "../../../../electron/domains/project/plan-item.entity";

interface PlanPaneProps {
  projectId: number;
}

type PlanView = "table" | "kanban";

interface FilterOption {
  value: string;
  label: string;
}

interface FilterMenuProps {
  label: string;
  options: FilterOption[];
  selected: string[];
  onToggle: (value: string) => void;
}

/** 多选筛选下拉：checkbox 勾选即时生效，onSelect preventDefault 保持菜单展开 */
function FilterMenu({ label, options, selected, onToggle }: FilterMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={label}
          className="h-8 gap-1 px-2 text-xs hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
        >
          <ListFilter className="h-3.5 w-3.5" />
          {selected.length > 0 ? `${label} · ${selected.length}` : label}
          <ChevronDown className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="rounded-lg border border-border/50 shadow-lg"
      >
        {options.map((option) => (
          <DropdownMenuCheckboxItem
            key={option.value}
            checked={selected.includes(option.value)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={() => onToggle(option.value)}
          >
            {option.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 维度内 OR、跨维度 AND 的多选匹配 */
const matchesFilter = (selected: string[], value: string) =>
  selected.length === 0 || selected.includes(value);

/** 看板列序即表格缺省排序：状态四态 → 列内 sortOrder → id 兜底 */
function compareItems(a: PlanItemRecord, b: PlanItemRecord): number {
  const statusGap =
    PLAN_STATUSES.indexOf(a.status) - PLAN_STATUSES.indexOf(b.status);
  if (statusGap !== 0) {
    return statusGap;
  }
  return a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : a.id - b.id;
}

/** 列表项局部补丁写入缓存（乐观更新） */
function patchItem(
  prev: PlanItemRecord[] | undefined,
  id: number,
  patch: Partial<PlanItemRecord>,
): PlanItemRecord[] {
  return (prev ?? []).map((item) =>
    item.id === id ? { ...item, ...patch } : item,
  );
}

export default function PlanPane({ projectId }: PlanPaneProps) {
  const { t } = useTranslation(["project", "common"]);
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const user = useUserStore((state) => state.user);

  const [statusFilter, setStatusFilter] = useState<PlanStatus[]>([]);
  const [priorityFilter, setPriorityFilter] = useState<PlanPriority[]>([]);
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<PlanItemRecord | undefined>();
  /** 新建弹窗预置状态（看板列头快速新增；工具栏添加复位缺省） */
  const [dialogDefaultStatus, setDialogDefaultStatus] =
    useState<PlanStatus>("not_started");
  const [fieldEditorOpen, setFieldEditorOpen] = useState(false);
  const [deleting, setDeleting] = useState<PlanItemRecord | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);

  const itemsQuery = useQuery({
    queryKey: PLAN_ITEMS_KEY(projectId),
    queryFn: () => PlanItemApi.list(projectId),
  });
  const fieldsQuery = useQuery({
    queryKey: PLAN_FIELDS_KEY(projectId),
    queryFn: () => PlanItemApi.listFields(projectId),
  });

  const items = useMemo(() => itemsQuery.data ?? [], [itemsQuery.data]);
  const fields = useMemo(() => fieldsQuery.data ?? [], [fieldsQuery.data]);

  /** 非法值回落 table（缺省同） */
  const view: PlanView =
    searchParams.get("view") === "kanban" ? "kanban" : "table";

  /** 合并式写入：保留 ?tab= 等既有参数（replace 不产生历史记录） */
  const switchView = (next: PlanView) => {
    setSearchParams(
      (prev) => {
        prev.set("view", next);
        return prev;
      },
      { replace: true },
    );
  };

  /** 标签候选 = 当前事项 distinct */
  const tagOptions = useMemo(
    () => [...new Set(items.flatMap((item) => item.tags))].sort(),
    [items],
  );

  const keyword = search.trim().toLowerCase();
  const visibleItems = useMemo(
    () =>
      items
        .filter((item) => matchesFilter(statusFilter, item.status))
        .filter((item) => matchesFilter(priorityFilter, item.priority))
        .filter(
          (item) =>
            tagFilter.length === 0 ||
            item.tags.some((tag) => tagFilter.includes(tag)),
        )
        .filter(
          (item) =>
            keyword === "" || item.title.toLowerCase().includes(keyword),
        )
        .sort(compareItems),
    [items, statusFilter, priorityFilter, tagFilter, keyword],
  );

  /** 多选筛选切换（维度内去重增删） */
  const toggleFilter = <T,>(list: T[], value: T): T[] =>
    list.includes(value)
      ? list.filter((entry) => entry !== value)
      : [...list, value];

  /** create/remove 后双失效（计划 Tab + 任务 Tab 数据源，T4 契约） */
  const invalidatePlanCaches = async () => {
    await queryClient.invalidateQueries({
      queryKey: PLAN_ITEMS_KEY(projectId),
    });
    await queryClient.invalidateQueries({
      queryKey: PLAN_ITEMS_MINE_KEY(user.id),
    });
  };

  /**
   * 状态切换/看板落点走 move 通道：sortOrder 由全量缓存目标列推导（T6 决策，
   * 防筛选错序）——无 afterId=列尾 max+1；有 afterId=与后一项均值（computeSortOrder）。
   * 同状态且无落点（表格重选同值/看板拖回本列背景）no-op。
   */
  const handleMove = async (
    id: number,
    status: PlanStatus,
    afterId?: number,
  ) => {
    const target = items.find((item) => item.id === id);
    if (!target || (target.status === status && afterId === undefined)) {
      return;
    }
    // 目标列（排除被移动项自身，均值邻位不受其原位影响）
    const column = items.filter(
      (item) => item.status === status && item.id !== id,
    );
    const sortOrder = computeSortOrder(column, afterId);
    queryClient.setQueryData<PlanItemRecord[]>(
      PLAN_ITEMS_KEY(projectId),
      (prev) => patchItem(prev, id, { status, sortOrder }),
    );
    try {
      await PlanItemApi.move({ id, status, sortOrder });
    } catch (error) {
      // 失败回滚：失效重取恢复服务端真值
      await queryClient.invalidateQueries({
        queryKey: PLAN_ITEMS_KEY(projectId),
      });
      toast.error(mapIpcError(error));
    }
  };

  /** 行内优先级切换走 update（局部键） */
  const handleSetPriority = async (id: number, priority: PlanPriority) => {
    const target = items.find((item) => item.id === id);
    if (!target || target.priority === priority) {
      return;
    }
    queryClient.setQueryData<PlanItemRecord[]>(
      PLAN_ITEMS_KEY(projectId),
      (prev) => patchItem(prev, id, { priority }),
    );
    try {
      await PlanItemApi.update({ id, priority });
    } catch (error) {
      await queryClient.invalidateQueries({
        queryKey: PLAN_ITEMS_KEY(projectId),
      });
      toast.error(mapIpcError(error));
    }
  };

  /** 快速新增：与弹窗共用 create 链（缺省状态/优先级） */
  const handleQuickCreate = async (title: string) => {
    try {
      await PlanItemApi.create({ createdById: user.id, projectId, title });
      await invalidatePlanCaches();
    } catch (error) {
      toast.error(mapIpcError(error));
    }
  };

  /** 删除确认：remove + 双失效 */
  const handleDeleteConfirm = async () => {
    if (!deleting || deletingBusy) {
      return;
    }
    setDeletingBusy(true);
    try {
      await PlanItemApi.remove(deleting.id);
      await invalidatePlanCaches();
      toast.success(t("project:plan.deleted"));
      setDeleting(null);
    } catch (error) {
      toast.error(mapIpcError(error));
    } finally {
      setDeletingBusy(false);
    }
  };

  const openCreate = () => {
    setEditingItem(undefined);
    setDialogDefaultStatus("not_started");
    setDialogOpen(true);
  };

  /** 看板列头快速新增：预置该列状态打开新建弹窗 */
  const openQuickCreateIn = (status: PlanStatus) => {
    setEditingItem(undefined);
    setDialogDefaultStatus(status);
    setDialogOpen(true);
  };

  const openEdit = (item: PlanItemRecord) => {
    setEditingItem(item);
    setDialogOpen(true);
  };

  /** 工具栏按钮共用样式 */
  const toolbarButtonClass =
    "h-8 gap-1 px-2 text-xs hover:border-primary/30 hover:bg-primary-subtle hover:text-primary";

  const viewButtonClass = (active: boolean) =>
    cn(
      "flex h-7 w-7 items-center justify-center transition-colors",
      active
        ? "bg-primary-subtle text-primary"
        : "text-muted-foreground hover:text-primary",
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 工具栏：筛选 + 搜索 + 视图切换 + 添加 */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border/50 px-4 py-2">
        <FilterMenu
          label={t("project:plan.filterStatus")}
          options={PLAN_STATUSES.map((status) => ({
            value: status,
            label: t(STATUS_LABEL_KEYS[status]),
          }))}
          selected={statusFilter}
          onToggle={(value) =>
            setStatusFilter((prev) => toggleFilter(prev, value as PlanStatus))
          }
        />
        <FilterMenu
          label={t("project:plan.filterPriority")}
          options={PLAN_PRIORITIES.map((priority) => ({
            value: priority,
            label: t(PRIORITY_LABEL_KEYS[priority]),
          }))}
          selected={priorityFilter}
          onToggle={(value) =>
            setPriorityFilter((prev) =>
              toggleFilter(prev, value as PlanPriority),
            )
          }
        />
        {tagOptions.length > 0 && (
          <FilterMenu
            label={t("project:plan.filterTag")}
            options={tagOptions.map((tag) => ({ value: tag, label: tag }))}
            selected={tagFilter}
            onToggle={(value) =>
              setTagFilter((prev) => toggleFilter(prev, value))
            }
          />
        )}
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("project:plan.search")}
          aria-label={t("project:plan.search")}
          className="h-8 w-44 text-sm"
        />
        <div className="ml-auto flex items-center gap-1.5">
          {/* 视图切换：表格 / 看板 */}
          <div className="flex items-center overflow-hidden rounded-md border border-border/50">
            <button
              type="button"
              aria-pressed={view === "table"}
              aria-label={t("project:plan.viewTable")}
              onClick={() => switchView("table")}
              className={viewButtonClass(view === "table")}
            >
              <TableIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-pressed={view === "kanban"}
              aria-label={t("project:plan.viewKanban")}
              onClick={() => switchView("kanban")}
              className={viewButtonClass(view === "kanban")}
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
          </div>
          <Button size="sm" onClick={openCreate} className={toolbarButtonClass}>
            <Plus className="h-3.5 w-3.5" />
            {t("project:plan.add")}
          </Button>
        </div>
      </div>

      {/* 内容区：加载 / 错误 / 空态 / 看板占位 / 表格 */}
      {itemsQuery.isError ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {t("project:toast.operationFailed")}
        </div>
      ) : itemsQuery.isLoading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("common:loading")}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary-subtle text-primary">
            <CalendarDays className="h-6 w-6" />
          </span>
          <p className="text-sm">{t("project:plan.empty")}</p>
          <Button size="sm" onClick={openCreate} className={toolbarButtonClass}>
            <Plus className="h-3.5 w-3.5" />
            {t("project:plan.add")}
          </Button>
        </div>
      ) : view === "kanban" ? (
        // 看板视图：四态泳道拖拽（可见项渲染，落点序号由 handleMove 全量推导）
        <PlanKanbanView
          items={visibleItems}
          onMove={handleMove}
          onQuickCreate={openQuickCreateIn}
          onEdit={openEdit}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
          <PlanTableView
            items={visibleItems}
            fields={fields}
            onOpenItem={openEdit}
            onMoveItem={handleMove}
            onSetPriority={handleSetPriority}
            onQuickCreate={handleQuickCreate}
            onOpenFieldEditor={() => setFieldEditorOpen(true)}
            onDeleteItem={setDeleting}
          />
        </div>
      )}

      {/* 新建/编辑弹窗（失效与 toast 在弹窗内处理） */}
      <PlanItemDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        projectId={projectId}
        item={editingItem}
        defaultStatus={dialogDefaultStatus}
        onSaved={() => setEditingItem(undefined)}
      />
      {/* 字段定义管理 */}
      <CustomFieldsEditor
        open={fieldEditorOpen}
        onOpenChange={setFieldEditorOpen}
        projectId={projectId}
      />
      {/* 删除二次确认 */}
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(null);
          }
        }}
      >
        <AlertDialogContent className="rounded-lg border-border/50 shadow-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("project:plan.delete")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("project:plan.confirmDelete")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingBusy}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              className="bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90"
            >
              {t("common:delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

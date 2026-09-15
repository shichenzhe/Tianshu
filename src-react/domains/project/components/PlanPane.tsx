/**
 * 计划面板（spec §6 计划 Tab）：单表数据源 PLAN_ITEMS_KEY + 字段定义
 * PLAN_FIELDS_KEY；视图驱动——usePlanViews 管 ?viewId= 激活路由（兼容旧
 * ?view=，合并式写入保留 ?tab= 等既有参数）与 draft 未保存调整态，
 * visibleItems = 引擎 filterItems（条件 AND + 标题搜索叠加）→ sortItems
 * （空规则沿用缺省序：状态四态 → sortOrder → id）；顶部视图 Tab 栏
 * （PlanViewTabs：切换/添加看板/重命名/删除保护/未保存圆点，视图列表为空
 * 时整条不渲染）；表格/看板/列表/日历/甘特五视图（看板 = PlanKanbanView 分组
 * 泳道拖拽，分组依据 status/priority/assignee 由视图 draft.groupBy 驱动；
 * 列表 = PlanListView 状态四组折叠清单——勾选完成走 move、组内 + 携组状态
 * 快速新增；日历 = PlanCalendarView 月格视图——点格空白预置该日 dueDate
 * 开新建弹窗、点 chip 开编辑；甘特 = PlanGanttView 时间轴条形——pointer
 * 拖拽平移/边缘拉伸调期走 handleChangeDates 乐观落库、点条开编辑）；
 * 项目成员查询（处理人筛选候选/看板分组与头像）。
 * 工具栏：组合筛选面板（PlanFilterPopover 六字段条件增删 + 保存为新视图/
 * 覆盖保存/重置，条件变更写 draft）+ 标题搜索 + 视图设置（PlanViewSettings
 * Popover：类型切换立即保存 + 看板分组依据入 draft）+「添加」（PlanItemDialog
 * 新建态）。
 * 行内变更统一在本层处理（表格/看板纯触发）：表格状态切换与 status 分组看板
 * 落点走 move 通道（sortOrder 由全量缓存目标列推导——无落点=列尾 max+1、
 * 有落点=与前一项后邻均值，防筛选错序），优先级/处理人走 update，快速新增
 * 走 create——均乐观更新 setQueryData、失败 invalidate 回滚；看板拖拽经
 * handleMoveItem 按分组分发（status=move 含列内重排，priority/assignee
 * 仅写对应字段，afterId 忽略）；create/remove 后失效
 * planItems + planItemsMine 双 key（T4 契约）；删除 AlertDialog 二次确认。
 * AI 推进入口（子系统 F）：列表行 hover 按钮与表格行尾菜单统一
 * handleAiAdvance → usePlanAdvanceStore.setPrompt 预填插值引导语
 * （#id《标题》+ 模板），项目底栏 ChatInput 订阅运行期消费聚焦。
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Plus } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { mapIpcError } from "@/domains/ai/chat/lib/error-message";
import { useUserStore } from "@/domains/user/store/user.store";
import ProjectApi from "../api/project.api";
import PlanItemApi, {
  PLAN_FIELDS_KEY,
  PLAN_ITEMS_KEY,
  PLAN_ITEMS_MINE_KEY,
} from "../api/plan-item.api";
import { usePlanViews } from "../model/use-plan-views";
import { dateKeyToIso } from "../model/plan-date";
import { usePlanAdvanceStore } from "../store/plan-advance.store";
import { filterItems, sortItems } from "../model/plan-view-engine";
import CustomFieldsEditor from "./CustomFieldsEditor";
import PlanFilterPopover from "./PlanFilterPopover";
import PlanItemDialog from "./PlanItemDialog";
import PlanGanttView from "./PlanGanttView";
import PlanKanbanView, { computeSortOrder } from "./PlanKanbanView";
import PlanCalendarView from "./PlanCalendarView";
import PlanListView from "./PlanListView";
import PlanTableView from "./PlanTableView";
import PlanViewSettingsPopover from "./PlanViewSettingsPopover";
import PlanViewTabs from "./PlanViewTabs";
import type {
  PlanItemRecord,
  PlanPriority,
  PlanStatus,
} from "../../../../electron/domains/project/plan-item.entity";
import { PLAN_VIEW_NAME_KEYS } from "../../../../electron/domains/project/plan-view.entity";

interface PlanPaneProps {
  projectId: number;
  /** 资产空间 workspace id（事项弹窗附件「从资产挑选」数据源） */
  assetWorkspaceId?: number;
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

export default function PlanPane({
  projectId,
  assetWorkspaceId,
}: PlanPaneProps) {
  const { t } = useTranslation(["project", "common"]);
  const queryClient = useQueryClient();
  const user = useUserStore((state) => state.user);
  const setAdvancePrompt = usePlanAdvanceStore((state) => state.setPrompt);

  const {
    views,
    activeView,
    activeViewId,
    setActiveViewId,
    isDirty,
    isError: isViewsError,
    addView,
    renameView,
    removeView,
    reorderViews,
    changeType,
    resetDraft,
    saveOverwrite,
    saveAsNew,
    draft,
    setDraft,
  } = usePlanViews(projectId);

  // 项目成员（处理人筛选候选；与弹窗共享 projectMembers 缓存）
  const { data: members = [] } = useQuery({
    queryKey: ["projectMembers", projectId],
    queryFn: () => ProjectApi.listMembers(projectId),
  });

  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<PlanItemRecord | undefined>();
  /** 新建弹窗预置状态（看板列头快速新增；工具栏添加复位缺省） */
  const [dialogDefaultStatus, setDialogDefaultStatus] =
    useState<PlanStatus>("not_started");
  /** 新建弹窗预置优先级（看板优先级列头快速新增；工具栏添加复位缺省） */
  const [dialogDefaultPriority, setDialogDefaultPriority] = useState<
    PlanPriority | undefined
  >(undefined);
  /** 新建弹窗预置截止日（日历点格快速新增；工具栏添加复位空） */
  const [dialogDefaultDueDate, setDialogDefaultDueDate] = useState<string>("");
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

  /** 标签候选 = 当前事项 distinct（筛选面板 chips 数据源） */
  const tagOptions = useMemo(
    () => [...new Set(items.flatMap((item) => item.tags))].sort(),
    [items],
  );
  const fields = useMemo(() => fieldsQuery.data ?? [], [fieldsQuery.data]);

  const visibleItems = useMemo(
    () =>
      sortItems(
        filterItems(items, draft.conditions, search, user.id),
        draft.sortRules,
      ),
    [items, draft.conditions, draft.sortRules, search, user.id],
  );

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
   * 状态切换/status 分组看板落点走 move 通道：sortOrder 由全量缓存目标列推导
   * （T6 决策，防筛选错序）——无 afterId=列尾 max+1；有 afterId=与后一项均值
   * （computeSortOrder）。同状态且无落点（表格重选同值/看板拖回本列背景）no-op。
   */
  const handleMoveStatus = async (
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

  /** 看板处理人列拖拽走 update（局部键；null = 拖入未指派列） */
  const handleSetAssignee = async (id: number, assigneeId: number | null) => {
    const target = items.find((item) => item.id === id);
    if (!target || target.assigneeId === assigneeId) {
      return;
    }
    queryClient.setQueryData<PlanItemRecord[]>(
      PLAN_ITEMS_KEY(projectId),
      (prev) => patchItem(prev, id, { assigneeId }),
    );
    try {
      await PlanItemApi.update({ id, assigneeId });
    } catch (error) {
      await queryClient.invalidateQueries({
        queryKey: PLAN_ITEMS_KEY(projectId),
      });
      toast.error(mapIpcError(error));
    }
  };

  /** 甘特拖拽调期：乐观 patch 日期 → update；失败失效回滚（handleSetPriority 同构） */
  const handleChangeDates = async (
    id: number,
    dates: { startKey: string; endKey: string },
  ) => {
    const startDate = dateKeyToIso(dates.startKey);
    const dueDate = dateKeyToIso(dates.endKey);
    queryClient.setQueryData<PlanItemRecord[]>(
      PLAN_ITEMS_KEY(projectId),
      (prev) => patchItem(prev, id, { startDate, dueDate }),
    );
    try {
      await PlanItemApi.update({ id, startDate, dueDate });
    } catch (error) {
      await queryClient.invalidateQueries({
        queryKey: PLAN_ITEMS_KEY(projectId),
      });
      toast.error(mapIpcError(error));
    }
  };

  /**
   * 看板拖拽分发（spec 已批准的简化）：status 分组走 move（sortOrder 语义，
   * 含列内重排）；priority/assignee 分组跨列仅写对应字段（afterId 忽略，
   * 列内不重排——sortOrder 只属于状态列）。groupBy 缺省 null 视同 status。
   */
  const handleMoveItem = (id: number, columnKey: string, afterId?: number) => {
    const groupBy = draft.groupBy ?? "status";
    if (groupBy === "status") {
      return handleMoveStatus(id, columnKey as PlanStatus, afterId);
    }
    if (groupBy === "priority") {
      return handleSetPriority(id, columnKey as PlanPriority);
    }
    if (groupBy === "assignee") {
      return handleSetAssignee(
        id,
        columnKey === "unassigned" ? null : Number(columnKey),
      );
    }
  };

  /** 快速新增（带状态预置；列表组内 + / 表格表头共用）：创建即指派自己 */
  const handleQuickCreateIn = async (status: PlanStatus, title: string) => {
    try {
      await PlanItemApi.create({
        createdById: user.id,
        assigneeId: user.id,
        projectId,
        title,
        status,
      });
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
    setDialogDefaultPriority(undefined);
    setDialogDefaultDueDate("");
    setDialogOpen(true);
  };

  /** 看板列头快速新增：按分组依据预置该列值（status/priority；assignee 缺省） */
  const openQuickCreateIn = (preset: {
    status?: PlanStatus;
    priority?: PlanPriority;
  }) => {
    setEditingItem(undefined);
    setDialogDefaultStatus(preset.status ?? "not_started");
    setDialogDefaultPriority(preset.priority);
    setDialogDefaultDueDate("");
    setDialogOpen(true);
  };

  const openEdit = (item: PlanItemRecord) => {
    setEditingItem(item);
    setDialogOpen(true);
  };

  /** AI 推进入口统一回调（列表 hover 按钮/表格菜单）：预填底栏引导语 */
  const handleAiAdvance = (item: PlanItemRecord) => {
    setAdvancePrompt(
      t("project:plan.advancePrompt", { id: item.id, title: item.title }),
    );
  };

  /** 工具栏按钮共用样式 */
  const toolbarButtonClass =
    "h-8 gap-1 px-2 text-xs hover:border-primary/30 hover:bg-primary-subtle hover:text-primary";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 视图 Tab 栏（视图列表为空——加载失败等——整条不渲染） */}
      {views.length > 0 && (
        /* 添加视图携带类型本地化名：非空名触发后端重名 (n) 后缀（缺省空名
           会使所有新增 Tab 同名不可区分） */
        <PlanViewTabs
          views={views}
          activeViewId={activeViewId}
          isDirty={isDirty}
          onSelect={setActiveViewId}
          onAdd={(type) => void addView(type, t(PLAN_VIEW_NAME_KEYS[type]))}
          onRename={(id, name) => void renameView(id, name)}
          onRemove={(id) => void removeView(id)}
          onReorder={(orderedIds) => void reorderViews(orderedIds)}
        />
      )}
      {/* 视图列表加载失败：可见错误提示（否则静默空白） */}
      {views.length === 0 && isViewsError && (
        <div className="border-b border-border/50 px-4 py-2 text-xs text-muted-foreground">
          {t("project:planView.loadFailed")}
        </div>
      )}

      {/* 工具栏：组合筛选面板 + 搜索 + 添加 */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border/50 px-4 py-2">
        <PlanFilterPopover
          conditions={draft.conditions}
          sortRules={draft.sortRules}
          isDirty={isDirty}
          members={members}
          currentUserId={user.id}
          tagOptions={tagOptions}
          onChange={(updater) =>
            setDraft((prev) => ({
              ...prev,
              conditions: updater(prev.conditions),
            }))
          }
          onSortChange={(updater) =>
            setDraft((prev) => ({
              ...prev,
              sortRules: updater(prev.sortRules),
            }))
          }
          onReset={resetDraft}
          onSaveOverwrite={() => void saveOverwrite()}
          onSaveAsNew={(name) => void saveAsNew(name)}
        />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("project:plan.search")}
          aria-label={t("project:plan.search")}
          className="h-8 w-44 text-sm"
        />
        <PlanViewSettingsPopover
          type={activeView?.type ?? "table"}
          groupBy={draft.groupBy}
          showGroupBy={activeView?.type === "kanban"}
          onTypeChange={(type) => void changeType(type)}
          onGroupByChange={(groupBy) =>
            setDraft((prev) => ({ ...prev, groupBy }))
          }
        />
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" onClick={openCreate} className={toolbarButtonClass}>
            <Plus className="h-3.5 w-3.5" />
            {t("project:plan.add")}
          </Button>
        </div>
      </div>

      {/* 内容区：加载 / 错误 / 看板 / 列表 / 日历 / 甘特 / 表格（空数据渲染各视图骨架） */}
      {itemsQuery.isError ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {t("project:toast.operationFailed")}
        </div>
      ) : itemsQuery.isLoading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("common:loading")}
        </div>
      ) : activeView?.type === "kanban" ? (
        // 看板视图：分组泳道拖拽（可见项渲染，status 分组序号由 move 通道全量推导）
        <PlanKanbanView
          items={visibleItems}
          groupBy={draft.groupBy ?? "status"}
          members={members}
          currentUserId={user.id}
          onMoveItem={handleMoveItem}
          onQuickCreate={openQuickCreateIn}
          onEdit={openEdit}
        />
      ) : activeView?.type === "list" ? (
        // 列表视图：状态分组折叠清单（勾选完成走 move；组内 + 携组状态快速新增）
        <PlanListView
          items={visibleItems}
          members={members}
          currentUserId={user.id}
          onToggleDone={(id, done) =>
            void handleMoveStatus(id, done ? "done" : "not_started")
          }
          onQuickCreate={(status, title) =>
            void handleQuickCreateIn(status, title)
          }
          onEdit={openEdit}
          onAiAdvance={handleAiAdvance}
        />
      ) : activeView?.type === "calendar" ? (
        // 日历视图：点格空白预置该日 dueDate 开新建弹窗（其余预置复位），点 chip 开编辑
        <PlanCalendarView
          items={visibleItems}
          onCreateAt={(dateKey) => {
            setEditingItem(undefined);
            setDialogDefaultStatus("not_started");
            setDialogDefaultPriority(undefined);
            setDialogDefaultDueDate(dateKey);
            setDialogOpen(true);
          }}
          onEdit={openEdit}
        />
      ) : activeView?.type === "gantt" ? (
        // 甘特视图：拖拽调期（乐观落库失败回滚）+ 点条/无日期行开编辑
        <PlanGanttView
          items={visibleItems}
          onEdit={openEdit}
          onChangeDates={handleChangeDates}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
          <PlanTableView
            items={visibleItems}
            fields={fields}
            onOpenItem={openEdit}
            onMoveItem={handleMoveStatus}
            onSetPriority={handleSetPriority}
            onQuickCreate={(title) => handleQuickCreateIn("not_started", title)}
            onOpenFieldEditor={() => setFieldEditorOpen(true)}
            onDeleteItem={setDeleting}
            onAiAdvance={handleAiAdvance}
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
        defaultPriority={dialogDefaultPriority}
        defaultDueDate={dialogDefaultDueDate}
        assetWorkspaceId={assetWorkspaceId}
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

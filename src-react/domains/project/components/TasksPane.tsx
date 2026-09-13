/**
 * 任务面板（spec §6 任务 Tab）：个人聚合清单——listMine（指派给我 OR 我
 * 创建）+ ["projects", user.id] 项目名解析。工具栏：私密提示灰字 + 范围
 * 筛选（mine 全部/assigned 指派给我的/created 我创建的）+ 来源筛选
 * （allSource/local/project）+ 标题搜索 +「新建本地任务」（PlanItemDialog
 * projectId=null，无自定义字段区）。
 * 行式列表：状态徽标（四态配色：进行中 primary-subtle、done muted…）+
 * 标题 + 优先级色点（P0 destructive/P1 primary/P2 muted-foreground）+
 * 来源 Badge（本地 → tasks.fromLocal；项目 → 项目名 secondary）+ 相对时间。
 * 行点击：本地任务 → PlanItemDialog 编辑；项目任务 → 跳项目工作台计划 Tab
 * （字符串模板拼 query，目标页只读无保留需求）。行内不提供删除/状态切换
 * （编辑走弹窗/跳项目，保持清单轻量）。
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { ChevronDown, ListChecks, Loader2, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { getDateFnsLocale } from "@/i18n";
import { cn } from "@/lib/utils";
import { useUserStore } from "@/domains/user/store/user.store";
import PlanItemApi, { PLAN_ITEMS_MINE_KEY } from "../api/plan-item.api";
import ProjectApi from "../api/project.api";
import PlanItemDialog, {
  PRIORITY_LABEL_KEYS,
  STATUS_LABEL_KEYS,
} from "./PlanItemDialog";
import type {
  PlanItemRecord,
  PlanPriority,
  PlanStatus,
} from "../../../../electron/domains/project/plan-item.entity";

/** 范围筛选：mine 全部（listMine 已聚合）/ assigned 指派给我的 / created 我创建的 */
type TaskScope = "mine" | "assigned" | "created";
/** 来源筛选：allSource 全部 / local 本地任务 / project 项目任务 */
type TaskSource = "allSource" | "local" | "project";

const SCOPE_OPTIONS: Array<{ value: TaskScope; labelKey: string }> = [
  { value: "mine", labelKey: "project:tasks.mine" },
  { value: "assigned", labelKey: "project:tasks.assigned" },
  { value: "created", labelKey: "project:tasks.created" },
];

const SOURCE_OPTIONS: Array<{ value: TaskSource; labelKey: string }> = [
  { value: "allSource", labelKey: "project:tasks.allSource" },
  { value: "local", labelKey: "project:tasks.local" },
  { value: "project", labelKey: "project:tasks.project" },
];

/** 状态徽标配色：进行中主题浅底、done muted、其余弱化描边 */
const STATUS_BADGE_CLASSNAMES: Record<PlanStatus, string> = {
  not_started: "border-border/50 bg-muted/30 text-muted-foreground",
  in_progress: "border-primary/20 bg-primary-subtle text-primary",
  paused: "border-border/50 bg-muted/50 text-muted-foreground",
  done: "border-transparent bg-muted text-muted-foreground",
};

/** 优先级色点：P0 destructive / P1 primary / P2 muted-foreground */
const PRIORITY_DOT_CLASSNAMES: Record<PlanPriority, string> = {
  P0: "bg-destructive",
  P1: "bg-primary",
  P2: "bg-muted-foreground",
};

/** 范围谓词：assigned=指派给我的，created=我创建的，mine=listMine 已聚合 */
const matchesScope = (
  item: PlanItemRecord,
  userId: number,
  scope: TaskScope,
) =>
  scope === "assigned"
    ? item.assigneeId === userId
    : scope === "created"
      ? item.createdById === userId
      : true;

/** 来源谓词：local=projectId null 本地任务，project=项目任务 */
const matchesSource = (item: PlanItemRecord, source: TaskSource) =>
  source === "local"
    ? item.projectId === null
    : source === "project"
      ? item.projectId !== null
      : true;

/** 相对时间（locale 跟随界面语言，ProjectCard 同款惯例） */
const formatRelative = (iso: string) =>
  formatDistanceToNow(new Date(iso), {
    addSuffix: true,
    locale: getDateFnsLocale(),
  });

export default function TasksPane() {
  const { t } = useTranslation(["project", "common"]);
  const navigate = useNavigate();
  const user = useUserStore((state) => state.user);

  const [scope, setScope] = useState<TaskScope>("mine");
  const [source, setSource] = useState<TaskSource>("allSource");
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<PlanItemRecord | undefined>();

  const itemsQuery = useQuery({
    queryKey: PLAN_ITEMS_MINE_KEY(user.id),
    queryFn: () => PlanItemApi.listMine(user.id),
  });
  // 项目名解析：复用 hub 的 ["projects", userId] 缓存（前缀一致可共享）
  const projectsQuery = useQuery({
    queryKey: ["projects", user.id],
    queryFn: () => ProjectApi.list(user.id),
  });

  const items = useMemo(() => itemsQuery.data ?? [], [itemsQuery.data]);
  const projectNames = useMemo(
    () => new Map((projectsQuery.data ?? []).map((p) => [p.id, p.name])),
    [projectsQuery.data],
  );

  const keyword = search.trim().toLowerCase();
  const visibleItems = useMemo(
    () =>
      items
        .filter((item) => matchesScope(item, user.id, scope))
        .filter((item) => matchesSource(item, source))
        .filter(
          (item) =>
            keyword === "" || item.title.toLowerCase().includes(keyword),
        ),
    [items, user.id, scope, source, keyword],
  );

  const scopeLabel = t(
    SCOPE_OPTIONS.find((option) => option.value === scope)?.labelKey ?? "",
  );
  const sourceLabel = t(
    SOURCE_OPTIONS.find((option) => option.value === source)?.labelKey ?? "",
  );

  /** 行点击：本地任务 → 编辑弹窗；项目任务 → 项目工作台计划 Tab */
  const handleRowClick = (item: PlanItemRecord) => {
    if (item.projectId === null) {
      setEditingItem(item);
      setDialogOpen(true);
      return;
    }
    navigate(`/module/project/${item.projectId}?tab=plan`);
  };

  /** 新建本地任务：projectId null（无自定义字段区，仅任务 Tab 可见） */
  const openCreateLocal = () => {
    setEditingItem(undefined);
    setDialogOpen(true);
  };

  /** 工具栏筛选触发器共用样式 */
  const filterTriggerClass =
    "h-8 gap-1 px-2 text-xs hover:border-primary/30 hover:bg-primary-subtle hover:text-primary";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 工具栏：私密提示 + 范围/来源筛选 + 搜索 + 新建本地任务 */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border/50 px-4 py-2">
        <p className="mr-1 truncate text-xs text-muted-foreground">
          {t("project:tasks.privateTip")}
        </p>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              aria-label={scopeLabel}
              className={filterTriggerClass}
            >
              {scopeLabel}
              <ChevronDown className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="rounded-lg border border-border/50 shadow-lg"
          >
            {SCOPE_OPTIONS.map((option) => (
              <DropdownMenuItem
                key={option.value}
                onClick={() => setScope(option.value)}
                className={cn(
                  scope === option.value && "text-primary focus:text-primary",
                )}
              >
                {t(option.labelKey)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              aria-label={sourceLabel}
              className={filterTriggerClass}
            >
              {sourceLabel}
              <ChevronDown className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="rounded-lg border border-border/50 shadow-lg"
          >
            {SOURCE_OPTIONS.map((option) => (
              <DropdownMenuItem
                key={option.value}
                onClick={() => setSource(option.value)}
                className={cn(
                  source === option.value && "text-primary focus:text-primary",
                )}
              >
                {t(option.labelKey)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("project:tasks.search")}
          aria-label={t("project:tasks.search")}
          className="h-8 w-44 text-sm"
        />
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            size="sm"
            onClick={openCreateLocal}
            className="h-8 gap-1 px-2 text-xs hover:bg-primary-hover"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("project:tasks.newLocalTask")}
          </Button>
        </div>
      </div>

      {/* 内容区：加载 / 错误 / 空态 / 行式清单 */}
      {itemsQuery.isError ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {t("project:toast.operationFailed")}
        </div>
      ) : itemsQuery.isLoading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("common:loading")}
        </div>
      ) : visibleItems.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary-subtle text-primary">
            <ListChecks className="h-6 w-6" />
          </span>
          <p className="text-sm">{t("project:tasks.empty")}</p>
          <Button
            size="sm"
            onClick={openCreateLocal}
            className="h-8 gap-1 px-2 text-xs hover:bg-primary-hover"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("project:tasks.newLocalTask")}
          </Button>
        </div>
      ) : (
        <div role="list" className="min-h-0 flex-1 overflow-auto px-2 pb-4">
          {visibleItems.map((item) => (
            <div
              key={item.id}
              role="listitem"
              onClick={() => handleRowClick(item)}
              className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-primary-subtle"
            >
              <Badge
                variant="outline"
                className={cn(
                  "shrink-0 px-1.5 text-[10px]",
                  STATUS_BADGE_CLASSNAMES[item.status],
                )}
              >
                {t(STATUS_LABEL_KEYS[item.status])}
              </Badge>
              {/* 优先级色点：title 提供悬停/断言锚点 */}
              <span
                title={t(PRIORITY_LABEL_KEYS[item.priority])}
                className={cn(
                  "h-2 w-2 shrink-0 rounded-full",
                  PRIORITY_DOT_CLASSNAMES[item.priority],
                )}
              />
              <span
                className="min-w-0 flex-1 truncate text-sm"
                title={item.title}
              >
                {item.title}
              </span>
              {/* 来源 Badge：本地 fromLocal / 项目名 secondary（缺名兜底） */}
              {item.projectId === null ? (
                <Badge
                  variant="outline"
                  className="shrink-0 border-border/50 text-muted-foreground"
                >
                  {t("project:tasks.fromLocal")}
                </Badge>
              ) : (
                <Badge variant="secondary" className="shrink-0">
                  {projectNames.get(item.projectId) ??
                    t("project:tasks.project")}
                </Badge>
              )}
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatRelative(item.updatedAt)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 新建/编辑弹窗：本地任务 projectId 恒 null（失效与 toast 在弹窗内处理） */}
      <PlanItemDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        projectId={editingItem?.projectId ?? null}
        item={editingItem}
        onSaved={() => setEditingItem(undefined)}
      />
    </div>
  );
}

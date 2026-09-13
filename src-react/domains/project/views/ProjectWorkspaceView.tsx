/**
 * 项目工作台 /module/project/:projectId（spec §6.3）：
 * 左列 Tab 容器（动态/计划/任务/资产，读写 ?tab= 缺省 activity）+ 筛选
 * 下拉（与我相关/成员动态——单成员等价，UI 预留）+ 配置面板开关；
 * 动态/资产 Tab 分别渲染 ActivityPane（复用 ChatPane）/AssetsPane，
 * 计划/任务 Tab 居中空态；右列 ConfigPanel（w-80 border-l，可收起）。
 * getDetail 抛 PROJECT_NOT_FOUND → toast + 跳回 /module/project。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CalendarDays,
  ChevronDown,
  FolderOpen,
  ListChecks,
  ListFilter,
  MessageSquareText,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import ProjectApi from "../api/project.api";
import ActivityPane from "../components/ActivityPane";
import AssetsPane from "../components/AssetsPane";
import ConfigPanel from "../components/ConfigPanel";

const HUB_ROUTE = "/module/project";

/**
 * 项目不存在错误码：与 electron/domains/project/project.entity 的同名常量
 * 保持同值（渲染进程不 import 主进程运行时代码，镜像声明，先例 ProjectCard）
 */
const PROJECT_NOT_FOUND = "PROJECT_NOT_FOUND";

type WorkspaceTab = "activity" | "plan" | "tasks" | "assets";

const TABS: Array<{
  value: WorkspaceTab;
  icon: LucideIcon;
  labelKey: string;
}> = [
  {
    value: "activity",
    icon: MessageSquareText,
    labelKey: "project:workspace.tabActivity",
  },
  { value: "plan", icon: CalendarDays, labelKey: "project:workspace.tabPlan" },
  { value: "tasks", icon: ListChecks, labelKey: "project:workspace.tabTasks" },
  {
    value: "assets",
    icon: FolderOpen,
    labelKey: "project:workspace.tabAssets",
  },
];

type ActivityFilter = "mine" | "members";

const FILTERS: Array<{ value: ActivityFilter; labelKey: string }> = [
  { value: "mine", labelKey: "project:workspace.filterMine" },
  { value: "members", labelKey: "project:workspace.filterMembers" },
];

const isWorkspaceTab = (value: string | null): value is WorkspaceTab =>
  TABS.some((tab) => tab.value === value);

export default function ProjectWorkspaceView() {
  const { t } = useTranslation(["project"]);
  const navigate = useNavigate();
  const { projectId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [panelOpen, setPanelOpen] = useState(true);
  const [filter, setFilter] = useState<ActivityFilter>("mine");

  const id = Number(projectId);
  const detailQuery = useQuery({
    queryKey: ["project", id],
    queryFn: () => ProjectApi.getDetail(id),
    enabled: Number.isInteger(id) && id > 0,
    retry: false,
  });

  // 404：项目不存在/已删除 → toast + 跳回列表（其余错误落下方错误态）
  useEffect(() => {
    const error = detailQuery.error;
    if (error instanceof Error && error.message.includes(PROJECT_NOT_FOUND)) {
      toast.error(t("project:workspace.notFound"));
      navigate(HUB_ROUTE, { replace: true });
    }
  }, [detailQuery.error, navigate, t]);

  const tabParam = searchParams.get("tab");
  const tab: WorkspaceTab = isWorkspaceTab(tabParam) ? tabParam : "activity";
  const activeTab = TABS.find((entry) => entry.value === tab) ?? TABS[0];

  const switchTab = (value: WorkspaceTab) => {
    if (value !== tab) {
      setSearchParams({ tab: value });
    }
  };

  if (detailQuery.isError) {
    const message =
      detailQuery.error instanceof Error ? detailQuery.error.message : "";
    // 404 分支由上方 effect 接管导航，此处只兜其余错误
    return message.includes(PROJECT_NOT_FOUND) ? null : (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t("project:toast.operationFailed")}
      </div>
    );
  }
  if (!detailQuery.data) {
    return null;
  }

  const filterLabel = t(
    FILTERS.find((entry) => entry.value === filter)?.labelKey ?? "",
  );

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 顶栏：Tab 切换 + 筛选下拉 + 配置面板开关 */}
        <header className="flex items-center justify-between gap-2 border-b border-border/50 px-4 py-1.5">
          <div
            className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
            role="tablist"
          >
            {TABS.map(({ value, icon: Icon, labelKey }) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                onClick={() => switchTab(value)}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 py-2 text-sm transition-colors",
                  tab === value
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="h-4 w-4" />
                {t(labelKey)}
              </button>
            ))}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={filterLabel}
                  className="gap-1 text-muted-foreground hover:text-primary"
                >
                  <ListFilter className="h-4 w-4" />
                  <span className="hidden text-xs md:inline">
                    {filterLabel}
                  </span>
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="rounded-lg border border-border/50 shadow-lg"
              >
                {FILTERS.map(({ value, labelKey }) => (
                  <DropdownMenuItem
                    key={value}
                    onClick={() => setFilter(value)}
                    className={cn(
                      filter === value && "text-primary focus:text-primary",
                    )}
                  >
                    {t(labelKey)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="ghost"
              size="sm"
              aria-label={t("project:workspace.togglePanel")}
              aria-pressed={panelOpen}
              onClick={() => setPanelOpen((open) => !open)}
              className="h-8 w-8 p-0 text-muted-foreground hover:text-primary"
            >
              {panelOpen ? (
                <PanelRightClose className="h-4 w-4" />
              ) : (
                <PanelRightOpen className="h-4 w-4" />
              )}
            </Button>
          </div>
        </header>

        {/* 内容区：动态/资产 Tab 渲染对应面板，计划/任务 Tab 居中空态（三期扩展点） */}
        {tab === "activity" ? (
          <ActivityPane detail={detailQuery.data} />
        ) : tab === "assets" ? (
          <AssetsPane
            key={detailQuery.data.project.id}
            projectId={detailQuery.data.project.id}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary-subtle text-primary">
              <activeTab.icon className="h-6 w-6" />
            </span>
            <p className="text-sm">{t("project:workspace.comingSoon")}</p>
          </div>
        )}
      </div>

      {/* 右列配置面板：默认展开，收起后仅留开关按钮 */}
      {panelOpen && (
        <aside className="w-80 shrink-0 border-l border-border/50">
          <ConfigPanel detail={detailQuery.data} />
        </aside>
      )}
    </div>
  );
}

/**
 * 项目工作台 /module/project/:projectId（spec §6.3）：
 * 左列 Tab 容器（计划/任务/资产，读写 ?tab= 缺省 plan；一期会话统一批 6
 * 删动态 Tab——项目会话统一在会话域 ChatView 查看，发起走底栏快速发起条）
 * + 配置面板开关——已迁入顶栏（TopBar 中段 page-header，44px 行高 pill
 * 风格），页面内容相应上移；计划/资产 Tab 分别渲染 PlanPane/AssetsPane，
 * 任务 Tab 渲染 TasksPane（个人聚合清单，自身拉取 planItemsMine 不依赖
 * projectId）；左列底部为快速发起条 ProjectChatBar（ChatInput 贯穿三 Tab，
 * providers/models 双空引导态不渲染）；右列 ConfigPanel（w-80 border-l，
 * 可收起）。Tab 切换为合并式 query 写入（保留 ?view= 等既有参数）。
 * getDetail 抛 PROJECT_NOT_FOUND → toast + 跳回 /module/project。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CalendarDays,
  FolderOpen,
  ListChecks,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { usePageHeader } from "@/components/layout/page-header.store";
import { cn } from "@/lib/utils";
import { ProviderApi } from "@/domains/ai/api/provider.api";
import { ModelApi } from "@/domains/ai/api/model.api";
import ProjectApi from "../api/project.api";
import AssetsPane from "../components/AssetsPane";
import ConfigPanel from "../components/ConfigPanel";
import PlanPane from "../components/PlanPane";
import ProjectChatBar, {
  chatSettingsRoute,
  needsChatSetup,
} from "../components/ProjectChatBar";
import TasksPane from "../components/TasksPane";

const HUB_ROUTE = "/module/project";

/**
 * 项目不存在错误码：与 electron/domains/project/project.entity 的同名常量
 * 保持同值（渲染进程不 import 主进程运行时代码，镜像声明，先例 ProjectCard）
 */
const PROJECT_NOT_FOUND = "PROJECT_NOT_FOUND";

type WorkspaceTab = "plan" | "tasks" | "assets";

const TABS: Array<{
  value: WorkspaceTab;
  icon: LucideIcon;
  labelKey: string;
}> = [
  { value: "plan", icon: CalendarDays, labelKey: "project:workspace.tabPlan" },
  { value: "tasks", icon: ListChecks, labelKey: "project:workspace.tabTasks" },
  {
    value: "assets",
    icon: FolderOpen,
    labelKey: "project:workspace.tabAssets",
  },
];

const isWorkspaceTab = (value: string | null): value is WorkspaceTab =>
  TABS.some((tab) => tab.value === value);

export default function ProjectWorkspaceView() {
  const { t } = useTranslation(["project"]);
  const navigate = useNavigate();
  const { projectId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [panelOpen, setPanelOpen] = useState(true);

  const id = Number(projectId);
  const detailQuery = useQuery({
    queryKey: ["project", id],
    queryFn: () => ProjectApi.getDetail(id),
    enabled: Number.isInteger(id) && id > 0,
    retry: false,
  });

  // 底栏渲染判据（needsChatSetup 自 ProjectChatBar 导出，批 6 迁移）：
  // 引导态（providers/models 双成功且双空）不渲染输入框
  const providersQuery = useQuery({
    queryKey: ["providers"],
    queryFn: () => ProviderApi.list(),
  });
  const modelsQuery = useQuery({
    queryKey: ["models"],
    queryFn: () => ModelApi.listAll(),
  });
  const chatReady = !needsChatSetup(providersQuery, modelsQuery);

  // 404：项目不存在/已删除 → toast + 跳回列表（其余错误落下方错误态）
  useEffect(() => {
    const error = detailQuery.error;
    if (error instanceof Error && error.message.includes(PROJECT_NOT_FOUND)) {
      toast.error(t("project:workspace.notFound"));
      navigate(HUB_ROUTE, { replace: true });
    }
  }, [detailQuery.error, navigate, t]);

  const tabParam = searchParams.get("tab");
  // 缺省 plan（批 6 起三 Tab）；旧链接 ?tab=activity 非法值回落 plan
  const tab: WorkspaceTab = isWorkspaceTab(tabParam) ? tabParam : "plan";

  const switchTab = (value: WorkspaceTab) => {
    if (value !== tab) {
      setSearchParams(
        (prev) => {
          prev.set("tab", value);
          return prev;
        },
        { replace: true },
      );
    }
  };

  // 页面顶行（TopBar 中段）：Tab 组（44px 行高改 pill 风格）+ 配置面板
  // 开关（原页内 header 行迁入，内容相应上移）；详情未加载置空
  // （hook 无条件调用，置于下方早退之前）
  usePageHeader(
    detailQuery.data
      ? {
          title: (
            <div
              className="flex min-w-0 items-center gap-1 overflow-x-auto"
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
                    "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-sm transition-colors",
                    tab === value
                      ? "bg-primary-subtle text-primary"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {t(labelKey)}
                </button>
              ))}
            </div>
          ),
          trailing: (
            <Button
              variant="ghost"
              size="sm"
              aria-label={t("project:workspace.togglePanel")}
              aria-pressed={panelOpen}
              onClick={() => setPanelOpen((open) => !open)}
              className="h-7 w-7 p-0 text-muted-foreground hover:text-primary"
            >
              {panelOpen ? (
                <PanelRightClose className="h-4 w-4" />
              ) : (
                <PanelRightOpen className="h-4 w-4" />
              )}
            </Button>
          ),
          // 右段：配置面板标题（迁入 TopBar 右段——面板上方空出的条带），
          // 面板收起时不渲染（ConfigPanel 同步卸载）
          right: panelOpen && (
            <span className="truncate text-sm font-medium text-foreground">
              {t("project:panel.title")}
            </span>
          ),
        }
      : null,
  );

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

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 内容区：计划/任务/资产 Tab 渲染对应面板（flex-1 满高，底栏外置） */}
        <div className="flex min-h-0 flex-1 flex-col">
          {tab === "plan" ? (
            <PlanPane
              key={detailQuery.data.project.id}
              projectId={detailQuery.data.project.id}
              assetWorkspaceId={detailQuery.data.assetWorkspaceId}
            />
          ) : tab === "assets" ? (
            <AssetsPane
              key={detailQuery.data.project.id}
              projectId={detailQuery.data.project.id}
            />
          ) : (
            /* 任务 Tab：个人聚合清单（自取 userId，无 projectId 切换重挂需求） */
            <TasksPane />
          )}
        </div>

        {/* 底部快速发起条（批 3 瘦身）：贯穿三 Tab，key 取会话 id 保证切换重建 */}
        {chatReady && (
          <ProjectChatBar
            key={detailQuery.data.session.id}
            detail={detailQuery.data}
            onOpenSettings={(target) => navigate(chatSettingsRoute(target))}
          />
        )}
      </div>

      {/* 右列配置面板：默认展开，收起后仅留开关按钮 */}
      {panelOpen && (
        <aside className="w-80 shrink-0 border-l border-border/50 bg-background">
          <ConfigPanel detail={detailQuery.data} />
        </aside>
      )}
    </div>
  );
}

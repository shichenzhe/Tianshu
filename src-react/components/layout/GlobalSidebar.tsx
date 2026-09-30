/**
 * 全局侧边栏（所有 /module/* 路由共用，MainLayout 渲染）：
 * 壳（w-64 右边框 + macOS Logo 区）+ 功能入口（新建任务/项目/专家/自动化/
 * 资料库，路由命中高亮）+ 主体区空间分组任务树（SessionTreePanel，二期
 * 批 7 D8「我的项目」区移除——项目导航 = 顶部 nav「项目」+ 任务树项目组
 * 组头点击进入）+ 底部用户区（UserMenu，含语言切换，原顶栏右上角移入）。
 * 布局级快捷键分发（useAiLayoutKeybindings）在此挂载（原 AiLayout 职责迁入）。
 */
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Bot,
  Clock,
  FileText,
  FolderKanban,
  MessageSquare,
} from "lucide-react";

import { cn } from "@/lib/utils";
import AppLogo from "@/components/common/AppLogo";
import SessionTreePanel from "@/domains/ai/layout/components/SessionTreePanel";
import { useAiLayoutKeybindings } from "@/domains/ai/layout/hooks/use-ai-layout-keybindings";
import WorkspaceApi from "@/domains/ai/api/workspace.api";
import ProjectApi from "@/domains/project/api/project.api";
import { useAiUiStore } from "@/domains/ai/store/ai-ui.store";
import { useUserStore } from "@/domains/user/store/user.store";
import UserMenu from "./UserMenu";

export default function GlobalSidebar() {
  useAiLayoutKeybindings();
  const { t } = useTranslation(["chat", "common", "project"]);
  const navigate = useNavigate();
  const location = useLocation();
  const collapsed = useAiUiStore((s) => s.sidebarCollapsed);
  const user = useUserStore((state) => state.user);
  const isMac = window.platform === "darwin";

  const isProjectRoute = location.pathname.startsWith("/module/project");

  /** 空间预热查询（key 与 SessionTreePanel 一致）：侧边栏为全局组件，
   *  项目模块等非 AI 路由下无组件观测 ["workspaces"]，挂载此查询兼任
   *  全局缓存预热，避免 gcTime 后缓存为空导致新建任务无目标空间 */
  useQuery({
    queryKey: ["workspaces"],
    queryFn: () => WorkspaceApi.list(),
  });

  /** 项目列表预热（key 与 SessionTreePanel/ChatView 面包屑一致）：
   *  「我的项目」区移除后（批 7 D8）由本体兼任原 ProjectSidebarList 的
   *  预热职责，保证任务树项目组名与面包屑的项目名数据源不空 */
  useQuery({
    queryKey: ["projects", user.id],
    queryFn: () => ProjectApi.list(),
  });

  /** 新建任务：进入 /module/ai/new 落地页（发送时才创建会话） */
  const handleNewTask = () => navigate("/module/ai/new");

  const navEntries = [
    {
      icon: <FolderKanban size={16} />,
      label: t("project:sidebar.projects"),
      onClick: () => navigate("/module/project"),
      active: isProjectRoute,
    },
    {
      icon: <Bot size={16} />,
      label: t("chat:sidebar.experts"),
      onClick: () => navigate("/module/ai/experts"),
      active: location.pathname.startsWith("/module/ai/experts"),
    },
    {
      icon: <Clock size={16} />,
      label: t("chat:sidebar.automation"),
      onClick: () => navigate("/module/ai/automation"),
      active: location.pathname.startsWith("/module/ai/automation"),
    },
    {
      icon: <FileText size={16} />,
      label: t("chat:sidebar.library"),
      onClick: () => navigate("/module/ai/library"),
      active: location.pathname.startsWith("/module/ai/library"),
    },
  ];

  return (
    <aside
      className={cn(
        "flex h-full shrink-0 flex-col overflow-hidden bg-muted/40 transition-[width] duration-200",
        collapsed ? "w-0" : "w-64",
      )}
    >
      {/* 内容层固定宽度 + 自带右边框（收起时随宽度动画一并裁掉，不留残线）；
          data-sidebar-shell 供 skins.css 叠加主题相近侧栏背景色（不显示壁纸） */}
      <div
        data-sidebar-shell=""
        className="flex h-full w-64 shrink-0 flex-col border-r border-border/50"
      >
        {/* macOS 顶部 Logo（Windows 标题在 TopBar） */}
        {isMac && (
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/50 px-3">
            <AppLogo className="h-5 w-5" />
            <span className="truncate text-sm font-semibold tracking-tight text-foreground select-none">
              {t("common:appName")}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground select-none">
              {__APP_VERSION__}
            </span>
          </div>
        )}

        {/* 功能入口区 */}
        <div className="flex flex-col gap-1 p-2">
          <SidebarNavButton
            icon={<MessageSquare size={16} />}
            label={t("chat:sidebar.newTask")}
            onClick={handleNewTask}
          />
          {navEntries.map((entry) => (
            <SidebarNavButton
              key={entry.label}
              icon={entry.icon}
              label={entry.label}
              onClick={entry.onClick}
              active={entry.active}
            />
          ))}
        </div>

        {/* 主体区：空间分组任务树独占（「我的项目」区已移除，批 7 D8；
            收展仅由外层 aside 宽度裁切完成，内容常驻避免动画闪动） */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SessionTreePanel />
        </div>

        {/* 用户区（原顶栏右上角移入）：菜单含语言切换，向上弹出 */}
        <div className="shrink-0 border-t border-border/50 p-2">
          <UserMenu />
        </div>
      </div>
    </aside>
  );
}

interface SidebarNavButtonProps {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  /** 当前路由命中：常亮高亮（bg-primary-subtle text-primary） */
  active?: boolean;
}

/** 侧边栏入口行（图标+文字） */
function SidebarNavButton({
  icon,
  label,
  onClick,
  active,
}: SidebarNavButtonProps) {
  return (
    <div
      className={cn(
        "flex h-8 cursor-pointer items-center gap-2.5 rounded-md px-3 text-sm transition-colors duration-200 hover:bg-primary-subtle hover:text-primary",
        active ? "bg-primary-subtle text-primary" : "text-muted-foreground",
      )}
      onClick={onClick}
    >
      <span className="shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
    </div>
  );
}

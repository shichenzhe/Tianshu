/**
 * 项目模块侧边栏列表（GlobalSidebar 项目路由下的主体区）：
 * 「我的项目」标题 + 项目行（模版图标 + 名称，点击进入 /module/project/:id，
 * 当前项目行高亮）；复用 hub 的 ["projects", ownerId] 查询缓存。
 */
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { cn } from "@/lib/utils";
import { useUserStore } from "@/domains/user/store/user.store";
import ProjectApi from "../api/project.api";
import { getTemplate, getTemplateIcon } from "../model/project-templates";

interface ProjectSidebarListProps {
  /** 侧边栏折叠态（收缩时整体隐藏，与 AI 任务树口径一致） */
  collapsed: boolean;
}

export default function ProjectSidebarList({
  collapsed,
}: ProjectSidebarListProps) {
  const { t } = useTranslation(["project", "common"]);
  const navigate = useNavigate();
  const location = useLocation();
  const user = useUserStore((state) => state.user);

  // 与 hub 共用查询缓存（同一 ["projects", ownerId] key）
  const { data: projects = [] } = useQuery({
    queryKey: ["projects", user.id],
    queryFn: () => ProjectApi.list(user.id),
  });

  // 当前项目行高亮：/module/project/:id
  const activeProjectId =
    Number(location.pathname.match(/^\/module\/project\/(\d+)/)?.[1]) || null;

  return (
    <>
      {!collapsed && (
        <div className="fade-in p-2">
          <p className="flex items-center gap-1 rounded-md px-1 py-1 text-xs font-medium text-muted-foreground">
            {t("project:sidebar.myProjects")} ({projects.length})
          </p>
          {projects.map((project) => {
            const Icon = getTemplateIcon(
              getTemplate(project.templateKey ?? "")?.icon,
            );
            return (
              <button
                key={project.id}
                type="button"
                className={cn(
                  "mb-0.5 flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                  project.id === activeProjectId
                    ? "bg-primary-subtle text-primary"
                    : "text-foreground/90 hover:bg-primary-subtle/60",
                )}
                onClick={() => navigate(`/module/project/${project.id}`)}
                title={project.name}
              >
                <Icon size={14} className="shrink-0" />
                <span className="truncate">{project.name}</span>
              </button>
            );
          })}
          {projects.length === 0 && (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              {t("project:sidebar.empty")}
            </p>
          )}
        </div>
      )}
    </>
  );
}

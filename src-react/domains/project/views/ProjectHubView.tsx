/**
 * 项目列表页 hub /module/project（spec §6.1）：
 * 头部（标题/副标题/新建按钮 + 右侧本地装饰）→ 我的项目（搜索 + 卡片网格，
 * 搜索为客户端 name 过滤）→ 从模版创建（横向模版卡，点击预选模版打开
 * CreateProjectDialog）；创建成功 navigate /module/project/:id。
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Plus, Search, Sparkles, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useUserStore } from "@/domains/user/store/user.store";
import CreateProjectDialog from "../components/CreateProjectDialog";
import ProjectCard from "../components/ProjectCard";
import ProjectApi from "../api/project.api";
import {
  getTemplateIcon,
  PROJECT_TEMPLATES,
  type ProjectTemplate,
} from "../model/project-templates";
import type { ProjectRecord } from "../../../../electron/domains/project/project.entity";

export default function ProjectHubView() {
  const { t } = useTranslation(["project", "common"]);
  const navigate = useNavigate();
  const user = useUserStore((state) => state.user);
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [presetTemplateKey, setPresetTemplateKey] = useState<
    string | undefined
  >(undefined);

  const { data: projects = [] } = useQuery({
    queryKey: ["projects", user.id],
    queryFn: () => ProjectApi.list(user.id),
  });

  // 客户端过滤：name 包含关键词即命中（大小写不敏感）
  const keyword = search.trim().toLowerCase();
  const visibleProjects = useMemo(
    () =>
      projects.filter((project) =>
        project.name.toLowerCase().includes(keyword),
      ),
    [projects, keyword],
  );

  const openCreateDialog = (templateKey?: string) => {
    setPresetTemplateKey(templateKey);
    setCreateOpen(true);
  };

  const handleCreated = (project: ProjectRecord) => {
    navigate(`/module/project/${project.id}`);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-6">
        {/* 头部：标题 + 副标题 + 新建按钮 + 右侧本地装饰（lucide 图标组合，无外链） */}
        <header className="relative overflow-hidden rounded-lg border border-border/50 bg-card p-6 shadow-sm">
          <div className="relative z-10 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1.5">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                {t("project:hub.title")}
              </h1>
              <p className="text-sm text-muted-foreground">
                {t("project:hub.subtitle")}
              </p>
            </div>
            <Button
              onClick={() => openCreateDialog()}
              className="gap-1.5 self-start sm:self-auto"
            >
              <Plus className="h-4 w-4" />
              {t("project:hub.newProject")}
            </Button>
          </div>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 flex items-center gap-3 bg-gradient-to-r from-transparent to-primary/10 px-10"
          >
            <Users className="h-10 w-10 text-primary/25" />
            <Sparkles className="h-6 w-6 text-primary/40" />
          </div>
        </header>

        {/* 我的项目：标题行（标题 + 搜索框）→ 卡片网格 */}
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-base font-medium text-foreground">
              {t("project:hub.myProjects")}
            </h2>
            <div className="relative w-64">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("project:hub.searchPlaceholder")}
                aria-label={t("project:hub.searchPlaceholder")}
                className="pl-8"
              />
            </div>
          </div>
          {visibleProjects.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/60 py-14 text-center text-sm text-muted-foreground">
              {t("project:hub.empty")}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {visibleProjects.map((project) => (
                <ProjectCard key={project.id} project={project} />
              ))}
            </div>
          )}
        </section>

        {/* 从模版创建：横向滚动模版卡，点击预选模版打开新建弹窗 */}
        <section className="space-y-3">
          <h2 className="text-base font-medium text-foreground">
            {t("project:hub.fromTemplate")}
          </h2>
          <div className="flex gap-3 overflow-x-auto pb-2">
            {PROJECT_TEMPLATES.map((template) => (
              <TemplateCard
                key={template.key}
                template={template}
                onClick={() => openCreateDialog(template.key)}
              />
            ))}
          </div>
        </section>
      </div>

      <CreateProjectDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        presetTemplateKey={presetTemplateKey}
        onCreated={handleCreated}
      />
    </div>
  );
}

interface TemplateCardProps {
  template: ProjectTemplate;
  onClick: () => void;
}

/** 模版卡：icon + 名称 + 描述，点击以预选模版打开新建弹窗 */
function TemplateCard({ template, onClick }: TemplateCardProps) {
  const Icon = getTemplateIcon(template.icon);
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-56 shrink-0 cursor-pointer flex-col gap-2 rounded-lg border border-border/50 bg-card p-4 text-left shadow-sm transition-colors hover:border-primary/30 hover:bg-primary-subtle"
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-md bg-primary-subtle text-primary">
        <Icon size={18} />
      </span>
      <span className="text-sm font-medium text-foreground">
        {template.name}
      </span>
      <span className="text-xs leading-relaxed text-muted-foreground">
        {template.description}
      </span>
    </button>
  );
}

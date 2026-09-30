/**
 * 项目会话面包屑（一期会话统一批 4）：主会话单段「项目名」，任务会话
 * 两段「项目名 / 任务标题」。整条为单按钮回 /module/project/:id（实现
 * 取简：两级落点相同，无需分段独立交互）；任务标题未就绪时仅渲染项目
 * 名段（事项缓存到达后自然补全）
 */
import { useNavigate } from "react-router-dom";
import { FolderKanban } from "lucide-react";

interface ProjectBreadcrumbProps {
  projectId: number;
  projectName: string;
  /** 任务会话标题（主会话或事项缓存未就绪时为 null） */
  taskTitle: string | null;
}

export default function ProjectBreadcrumb({
  projectId,
  projectName,
  taskTitle,
}: ProjectBreadcrumbProps) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate(`/module/project/${projectId}`)}
      title={taskTitle ? `${projectName} / ${taskTitle}` : projectName}
      className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-sm text-muted-foreground hover:bg-primary-subtle/60 hover:text-primary"
    >
      <FolderKanban className="h-3.5 w-3.5 shrink-0" />
      <span className="max-w-40 truncate">{projectName}</span>
      {taskTitle && (
        <>
          <span className="shrink-0 opacity-60">/</span>
          <span className="max-w-40 truncate">{taskTitle}</span>
        </>
      )}
    </button>
  );
}

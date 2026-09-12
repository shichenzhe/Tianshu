/**
 * 项目工作台 /module/project/:projectId（spec §6.3）
 * 本任务（Task 8）仅路由占位，Task 10 实现动态流 + 配置面板完整形态
 */
import { useTranslation } from "react-i18next";

export default function ProjectWorkspaceView() {
  const { t } = useTranslation(["project"]);
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      {t("project:workspace.comingSoon")}
    </div>
  );
}

/**
 * 路由配置：登录 + AI 模块（标准侧边栏布局）
 */

import { lazy, Suspense } from "react";
import { createHashRouter, Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import MainLayout from "@/components/layout/MainLayout";
import LoginView from "@/domains/user/views/LoginView";

// 懒加载其他模块
// AI 服务商/模型管理
const ProviderSettingsView = lazy(
  () => import("@/domains/ai/provider/views/ProviderSettingsView"),
);
// AI 对话主界面
const ChatView = lazy(() => import("@/domains/ai/chat/views/ChatView"));
// 新建任务落地页
const NewTaskView = lazy(
  () => import("@/domains/ai/new-task/views/NewTaskView"),
);
// AI 标准侧边栏布局
const AiLayout = lazy(() => import("@/domains/ai/layout/views/AiLayout"));
// 专家·技能·连接器统一管理
const ExpertsView = lazy(
  () => import("@/domains/ai/experts/views/ExpertsView"),
);
// 资料库（占位骨架）
const LibraryView = lazy(
  () => import("@/domains/ai/library/views/LibraryView"),
);
// 自动化（占位）
const AutomationView = lazy(
  () => import("@/domains/ai/automation/views/AutomationView"),
);
// 自动化任务详情/编辑
const TaskDetailView = lazy(
  () => import("@/domains/ai/automation/views/TaskDetailView"),
);
// 项目列表页（hub）
const ProjectHubView = lazy(
  () => import("@/domains/project/views/ProjectHubView"),
);
// 项目工作台（Task 10 完整实现，本任务先占位）
const ProjectWorkspaceView = lazy(
  () => import("@/domains/project/views/ProjectWorkspaceView"),
);

// 加载中组件
function LoadingFallback() {
  const { t } = useTranslation(["common"]);
  return (
    <div className="flex items-center justify-center h-screen">
      <div className="text-muted-foreground">{t("common:loading")}</div>
    </div>
  );
}

// 包装懒加载组件
function LazyWrapper({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<LoadingFallback />}>{children}</Suspense>;
}

export const router = createHashRouter([
  {
    path: "/",
    element: <Navigate to="/module/ai" replace />,
  },
  {
    path: "/login",
    element: <LoginView />,
  },
  {
    path: "/module",
    element: <MainLayout />,
    children: [
      {
        index: true,
        element: <Navigate to="/module/ai" replace />,
      },
      {
        path: "ai",
        element: (
          <LazyWrapper>
            <AiLayout />
          </LazyWrapper>
        ),
        children: [
          {
            index: true,
            element: (
              <LazyWrapper>
                <ChatView />
              </LazyWrapper>
            ),
          },
          {
            path: "new",
            element: (
              <LazyWrapper>
                <NewTaskView />
              </LazyWrapper>
            ),
          },
          {
            path: "providers",
            element: (
              <LazyWrapper>
                <ProviderSettingsView />
              </LazyWrapper>
            ),
          },
          {
            path: "experts",
            element: (
              <LazyWrapper>
                <ExpertsView />
              </LazyWrapper>
            ),
          },
          {
            path: "library",
            element: (
              <LazyWrapper>
                <LibraryView />
              </LazyWrapper>
            ),
          },
          {
            path: "automation",
            element: (
              <LazyWrapper>
                <AutomationView />
              </LazyWrapper>
            ),
          },
          {
            path: "automation/task/:id",
            element: (
              <LazyWrapper>
                <TaskDetailView />
              </LazyWrapper>
            ),
          },
        ],
      },
      {
        path: "project",
        element: (
          <LazyWrapper>
            <ProjectHubView />
          </LazyWrapper>
        ),
      },
      {
        path: "project/:projectId",
        element: (
          <LazyWrapper>
            <ProjectWorkspaceView />
          </LazyWrapper>
        ),
      },
    ],
  },
]);

export default router;

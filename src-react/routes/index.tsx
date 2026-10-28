/**
 * 路由配置：登录 + AI 模块（标准侧边栏布局）
 */

import { lazy, Suspense, useEffect } from "react";
import {
  createHashRouter,
  Navigate,
  useLocation,
  useParams,
} from "react-router-dom";
import { useTranslation } from "react-i18next";

import MainLayout from "@/components/layout/MainLayout";
import LoginView from "@/domains/user/views/LoginView";
import {
  fileWindowRoute,
  forwardMainRoute,
  isFileWindowScope,
} from "@/domains/ai/file-window/lib/window-scope";

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
// 内置浏览器
const BrowserView = lazy(
  () => import("@/domains/ai/browser/views/BrowserView"),
);
// 自动化（占位）
const AutomationView = lazy(
  () => import("@/domains/ai/automation/views/AutomationView"),
);
// 监控页（Token 消耗与工具调用统计）
const MonitorView = lazy(
  () => import("@/domains/ai/monitor/views/MonitorView"),
);
// 自动化任务详情/编辑
const TaskDetailView = lazy(
  () => import("@/domains/ai/automation/views/TaskDetailView"),
);
// 服务端控制台（连接管理 + 远程会话遥控）
const ServerConsoleView = lazy(
  () => import("@/domains/ai/server/views/ServerConsoleView"),
);
// 编排图编辑器（Task 13 完整实现，本任务占位；:id 为数字或 new 新建）
const GraphEditorView = lazy(
  () => import("@/domains/ai/orchestration/views/GraphEditorView"),
);
// 工作流列表（侧边栏一级入口；automation 页 graphs tab 复用同组件）
const GraphListView = lazy(
  () => import("@/domains/ai/orchestration/views/GraphListView"),
);
// 项目列表页（hub）
const ProjectHubView = lazy(
  () => import("@/domains/project/views/ProjectHubView"),
);
// 项目工作台（Task 10 完整实现，本任务先占位）
const ProjectWorkspaceView = lazy(
  () => import("@/domains/project/views/ProjectWorkspaceView"),
);
// 文件独立窗口（与 /login 平级，无 MainLayout 侧边栏）
const FileWindowView = lazy(
  () => import("@/domains/ai/file-window/views/FileWindowView"),
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

/** 旧图编辑路径 → 一级入口新路径（Navigate to 不做 :param 插值，须组件读参） */
function GraphLegacyRedirect() {
  const { id } = useParams();
  return <Navigate to={`/module/ai/graphs/${id ?? "new"}`} replace />;
}

/** 文件窗主窗路由守卫（T22）：文件窗内 ChatPane 子组件的内部 navigate
 *  （ModelPicker「配置模型」、专家/技能子菜单「管理」等）会试图把本窗
 *  跳到 /module/*——文件窗无侧边栏布局语义，转发主窗（openRoute 聚焦
 *  主窗跳同路由）并跳回文件窗；主窗恒走 MainLayout（零行为改动） */
function ModuleRouteGuard() {
  const location = useLocation();
  const inFileWindow = isFileWindowScope();
  useEffect(() => {
    if (inFileWindow) {
      forwardMainRoute(`${location.pathname}${location.search}`);
    }
  }, [inFileWindow, location]);
  if (inFileWindow) {
    return <Navigate to={fileWindowRoute()} replace />;
  }
  return <MainLayout />;
}

export const router = createHashRouter([
  {
    path: "/",
    // 应用默认落地新建任务页（用户裁定；/module/ai index 仍是对话视图，
    // 供侧边栏「对话」入口与 ?session= 会话直达）
    element: <Navigate to="/module/ai/new" replace />,
  },
  {
    path: "/login",
    element: <LoginView />,
  },
  {
    // 文件独立窗口（与 /login 平级，无侧边栏；windowId 经 hash query 携带）
    path: "/file-window",
    element: (
      <LazyWrapper>
        <FileWindowView />
      </LazyWrapper>
    ),
  },
  {
    path: "/module",
    element: <ModuleRouteGuard />,
    children: [
      {
        index: true,
        element: <Navigate to="/module/ai/new" replace />,
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
            path: "browser",
            element: (
              <LazyWrapper>
                <BrowserView />
              </LazyWrapper>
            ),
          },
          {
            path: "graphs",
            element: (
              <LazyWrapper>
                <GraphListView standalone />
              </LazyWrapper>
            ),
          },
          {
            path: "graphs/:id",
            element: (
              <LazyWrapper>
                <GraphEditorView />
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
            path: "server",
            element: (
              <LazyWrapper>
                <ServerConsoleView />
              </LazyWrapper>
            ),
          },
          {
            path: "monitor",
            element: (
              <LazyWrapper>
                <MonitorView />
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
          {
            // 旧路径兼容重定向（工作流已提为一级入口 /module/ai/graphs）
            path: "automation/graphs/:id",
            element: <GraphLegacyRedirect />,
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

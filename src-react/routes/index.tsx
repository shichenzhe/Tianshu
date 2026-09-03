/**
 * 路由配置
 */

import { lazy, Suspense } from "react";
import { createHashRouter, Navigate } from "react-router-dom";

import MainLayout from "@/components/layout/MainLayout";
import LoginView from "@/domains/user/views/LoginView";

// 懒加载其他模块
const WelcomeView = lazy(() => import("@/domains/welcome/views/WelcomeView"));
const SystemConfigView = lazy(
  () => import("@/domains/system-config/SystemConfigView"),
);
// AI 服务商/模型管理
const ProviderSettingsView = lazy(
  () => import("@/domains/ai/provider/views/ProviderSettingsView"),
);
// AI 助手预设管理
const AssistantSettingsView = lazy(
  () => import("@/domains/ai/assistant/views/AssistantSettingsView"),
);
// AI 对话主界面
const ChatView = lazy(() => import("@/domains/ai/chat/views/ChatView"));

// 加载中组件
function LoadingFallback() {
  return (
    <div className="flex items-center justify-center h-screen">
      <div className="text-gray-500">加载中...</div>
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
    element: <Navigate to="/login" replace />,
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
        element: (
          <LazyWrapper>
            <WelcomeView />
          </LazyWrapper>
        ),
      },
      {
        path: "welcome",
        element: (
          <LazyWrapper>
            <WelcomeView />
          </LazyWrapper>
        ),
      },
      {
        path: "ai",
        element: (
          <LazyWrapper>
            <ChatView />
          </LazyWrapper>
        ),
      },
      {
        path: "ai/providers",
        element: (
          <LazyWrapper>
            <ProviderSettingsView />
          </LazyWrapper>
        ),
      },
      {
        path: "ai/assistants",
        element: (
          <LazyWrapper>
            <AssistantSettingsView />
          </LazyWrapper>
        ),
      },
      {
        path: "system-config",
        element: (
          <LazyWrapper>
            <SystemConfigView />
          </LazyWrapper>
        ),
      },
    ],
  },
]);

export default router;

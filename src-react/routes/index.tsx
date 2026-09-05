/**
 * 路由配置：登录 + AI 模块（标准侧边栏布局）
 */

import { lazy, Suspense } from "react";
import { createHashRouter, Navigate } from "react-router-dom";

import MainLayout from "@/components/layout/MainLayout";
import LoginView from "@/domains/user/views/LoginView";

// 懒加载其他模块
// AI 服务商/模型管理
const ProviderSettingsView = lazy(
  () => import("@/domains/ai/provider/views/ProviderSettingsView"),
);
// AI 对话主界面
const ChatView = lazy(() => import("@/domains/ai/chat/views/ChatView"));
// AI 标准侧边栏布局
const AiLayout = lazy(() => import("@/domains/ai/layout/views/AiLayout"));

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
            path: "providers",
            element: (
              <LazyWrapper>
                <ProviderSettingsView />
              </LazyWrapper>
            ),
          },
        ],
      },
    ],
  },
]);

export default router;

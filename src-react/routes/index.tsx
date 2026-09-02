/**
 * 路由配置
 */

import { lazy, Suspense } from "react";
import { createHashRouter, Navigate } from "react-router-dom";

import MainLayout from "@/components/layout/MainLayout";
import LoginView from "@/domains/user/views/LoginView";

// 懒加载其他模块
const WelcomeView = lazy(() => import("@/domains/welcome/views/WelcomeView"));
const ModelConfigView = lazy(
  () => import("@/domains/ai/views/ModelConfigView"),
);
const SystemConfigView = lazy(
  () => import("@/domains/system-config/SystemConfigView"),
);

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
            <ModelConfigView />
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

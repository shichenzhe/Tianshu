/**
 * React 应用入口
 */

import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";

import router from "./routes";
import { initSkin } from "./stores/skin.store";
import { initFontScale } from "@/domains/app-settings/model/font-scale";
import "./i18n";
import { initLocale } from "./i18n";
import "./styles/globals.css";

// 初始化皮肤主题（必须在渲染前执行）
initSkin();

// 初始化语言设置
initLocale();

// 恢复字体缩放档位（必须在渲染前执行，避免首帧字号跳变）
initFontScale();

// 创建 React Query 客户端
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// 确保存在 root 元素
let rootElement = document.getElementById("root");
if (!rootElement) {
  rootElement = document.createElement("div");
  rootElement.id = "root";
  document.body.appendChild(rootElement);
}

ReactDOM.createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster position="top-center" richColors />
    </QueryClientProvider>
  </StrictMode>,
);

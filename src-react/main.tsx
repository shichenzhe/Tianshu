/**
 * React 应用入口
 */

import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DismissableToaster } from "@/components/ui/toast";

import router from "./routes";
import { initSkin } from "./stores/skin.store";
import { initFontScale } from "@/domains/app-settings/model/font-scale";
import { registerMainWindowNavigate } from "@/domains/ai/file-window/lib/main-window-navigate";
import { initUiDriveListener } from "@/domains/ai/server/lib/ui-drive-listener";
import { registerQueryInvalidation } from "@/lib/query-invalidate-events";
import "./i18n";
import { initLocale } from "./i18n";
import "./styles/globals.css";

// 初始化皮肤主题（必须在渲染前执行）
initSkin();

// 初始化语言设置
initLocale();

// 恢复字体缩放档位（必须在渲染前执行，避免首帧字号跳变）
initFontScale();

// 跨窗导航监听（T22 文件窗 ChatPane 设置类入口）：主进程聚焦本窗并推
// fileWindow:navigate 时跳对应路由（事件仅发主窗，文件窗注册无副作用）
registerMainWindowNavigate(router);

// ui-drive 被控监听（UD-T2，spec §2.3）：被控面三端点 → 主进程推
// ui:openSession/notify/openRoute 时激活会话/sonner toast/白名单路由跳转
// （事件仅发主窗 webContents，文件窗注册无副作用——同上先例）
initUiDriveListener(router);

// 创建 React Query 客户端
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      // M14：全局 staleTime——路由/会话往返不重复 IPC 全量重拉（事件
      // invalidate 链路完备，数据新鲜度由失效驱动而非挂载驱动）
      staleTime: 30_000,
    },
  },
});

// changed 事件 → 缓存失效常驻注册（app 级：组件级监听随路由卸载丢事件）
registerQueryInvalidation(queryClient);

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
      <DismissableToaster position="top-center" richColors />
    </QueryClientProvider>
  </StrictMode>,
);

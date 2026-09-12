/**
 * AI 模块布局：薄壳——全局侧边栏与布局快捷键分发已上移
 * MainLayout/GlobalSidebar（见 use-ai-layout-keybindings）；
 * 保留聊天面板纯白背景覆盖（bg-background，仅 AI 模块生效）+ Outlet 挂子路由。
 */

import { Outlet } from "react-router-dom";

export default function AiLayout() {
  return (
    <div className="h-full min-w-0 flex-1 bg-background">
      <Outlet />
    </div>
  );
}

/**
 * AI 模块布局：标准侧边栏 + 主内容区（Outlet 挂子路由）；
 * 挂全局快捷键分发器（布局级 13 条命令接线见 hooks/use-ai-layout-keybindings）
 */

import { Outlet } from "react-router-dom";

import AiSidebar from "../components/AiSidebar";
import { useAiLayoutKeybindings } from "../hooks/use-ai-layout-keybindings";

export default function AiLayout() {
  useAiLayoutKeybindings();
  return (
    <div className="flex h-full">
      <AiSidebar />
      {/* 聊天面板纯白背景（覆盖 MainLayout 的灰白底，仅 AI 模块生效） */}
      <div className="min-w-0 flex-1 bg-background">
        <Outlet />
      </div>
    </div>
  );
}

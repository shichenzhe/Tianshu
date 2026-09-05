/**
 * AI 模块布局：标准侧边栏 + 主内容区（Outlet 挂子路由）
 */

import { Outlet } from "react-router-dom";

import AiSidebar from "../components/AiSidebar";

export default function AiLayout() {
  return (
    <div className="flex h-full">
      <AiSidebar />
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}

/**
 * AI 模块布局：薄壳——全局侧边栏与布局快捷键分发已上移
 * MainLayout/GlobalSidebar（见 use-ai-layout-keybindings）；Outlet 挂子路由。
 * 内容列限宽居中（max-w-3xl，与项目详情 ActivityPane 同宽——验收反馈：
 * 两聊天面板宽度一致）；不设不透明背景，透出 body 壁纸叠加层
 * （皮肤体系起背景统一由 skins.css 的 body overlay 提供）。
 */

import { Outlet } from "react-router-dom";

export default function AiLayout() {
  return (
    <div className="mx-auto h-full min-w-0 w-full max-w-3xl">
      <Outlet />
    </div>
  );
}

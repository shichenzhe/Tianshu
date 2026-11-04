/**
 * 页面顶行宿主（TopBar 中段）：订阅 page-header store 渲染当前页面
 * 注册的标题/Tab/操作按钮（原页内首行迁入）；单测可与页面同树挂载。
 * 容器标 drag、各交互子块（leading/title/trailing）标 no-drag——子块
 * 之间的空白可拖拽窗口（TopBar 空白可拖诉求，各模块一致）
 */

import type { CSSProperties } from "react";

import { usePageHeaderStore } from "./page-header.store";

/** Electron 无边框窗口拖拽区域样式（React CSSProperties 未内置该属性） */
type AppRegionStyle = CSSProperties & { WebkitAppRegion?: string };

const dragStyle = { WebkitAppRegion: "drag" } as AppRegionStyle;
const noDragStyle = { WebkitAppRegion: "no-drag" } as AppRegionStyle;

export default function PageHeaderHost() {
  const slot = usePageHeaderStore((s) => s.slot);
  if (!slot) {
    return null;
  }
  return (
    <div
      className="flex h-full min-w-0 flex-1 items-center gap-2 px-3"
      style={dragStyle}
    >
      {slot.leading && (
        <div className="flex items-center" style={noDragStyle}>
          {slot.leading}
        </div>
      )}
      {slot.title && (
        <div className="flex min-w-0 items-center gap-2" style={noDragStyle}>
          {slot.title}
        </div>
      )}
      {slot.trailing && (
        <div className="ml-auto flex items-center gap-1.5" style={noDragStyle}>
          {slot.trailing}
        </div>
      )}
    </div>
  );
}

/**
 * 右段宿主（TopBar 产物面板段）：订阅 page-header slot.right 渲染——右侧
 * 面板标题等迁入顶栏（pl-4 与面板内容 p-4 左对齐，mr-auto 把窗口控制
 * 推回贴右）；单测可与页面同树挂载。容器 drag、内容块 no-drag——
 * 右段空白同样可拖拽窗口
 */
export function PageHeaderRightHost() {
  const right = usePageHeaderStore((s) => s.slot?.right);
  if (!right) {
    return null;
  }
  return (
    <div
      className="mr-auto flex h-full min-w-0 items-center pl-4"
      style={dragStyle}
    >
      <div className="flex items-center" style={noDragStyle}>
        {right}
      </div>
    </div>
  );
}

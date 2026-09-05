/**
 * 顶部全局操作栏
 * 包含 Logo、应用名、主题切换、用户菜单
 */

import ThemeSelector from "@/components/common/ThemeSelector";
import LanguageSelector from "@/components/common/LanguageSelector";
import UserMenu from "./UserMenu";
import type { CSSProperties, ReactNode } from "react";

/** Electron 无边框窗口拖拽区域样式（React CSSProperties 未内置该属性） */
type AppRegionStyle = CSSProperties & { WebkitAppRegion?: string };

interface TopBarProps {
  /** 左侧插槽（AI 路由下注入折叠/搜索/筛选按钮） */
  leftSlot?: ReactNode;
}

export default function TopBar({ leftSlot }: TopBarProps) {
  const isMac = window.platform === "darwin";
  return (
    <div
      className="fixed top-0 left-0 right-0 z-50 h-9 bg-background flex items-center pr-0 justify-between"
      style={{ WebkitAppRegion: "drag" } as AppRegionStyle}
    >
      {/* 左侧：Logo（Windows）+ 插槽；macOS 让出红绿灯区域 */}
      <div
        className={`flex items-center gap-1 ${isMac ? "pl-20" : "pl-2"}`}
        style={{ WebkitAppRegion: "no-drag" } as AppRegionStyle}
      >
        {!isMac && (
          <div className="flex items-center gap-2 mr-1">
            <img src="./pc_logo.svg" alt="mirror" className="w-5 h-5" />
            <span className="text-sm font-semibold text-foreground tracking-tight select-none">
              {"mirror"}
            </span>
          </div>
        )}
        {leftSlot}
      </div>

      {/* 右侧：主题切换 + 语言切换 + 用户菜单 */}
      <div
        className="flex items-center h-full"
        style={{ WebkitAppRegion: "no-drag" } as AppRegionStyle}
      >
        <div className="flex items-center gap-1 mr-2">
          <ThemeSelector size="sm" />
          <LanguageSelector size="sm" />
          <UserMenu />
          {/* Windows 窗口控制区分隔线（macOS 无） */}
          {!isMac && <div className="w-px h-5 bg-border" />}
        </div>
        {/* Windows Window Controls Placeholder - 保持与 main.ts overlay 一致（macOS 不渲染） */}
        {!isMac && <div className="w-[138px] h-full" />}
      </div>
    </div>
  );
}

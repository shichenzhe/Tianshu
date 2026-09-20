/**
 * 顶部全局操作栏
 * 包含 Logo、应用名、主题切换、用户菜单
 * 背景三段与下方栏位对齐（顶栏背景跟随主题）：左段=侧栏色（sidebar
 * 主题渐变，宽随折叠）、中段=主面板同款底色（panelClass 由 MainLayout
 * 传入，融为一体）、右段=产物面板色（宽度由面板挂载上报 store）
 */

import ThemeSelector from "@/components/common/ThemeSelector";
import LanguageSelector from "@/components/common/LanguageSelector";
import AppLogo from "@/components/common/AppLogo";
import UserMenu from "./UserMenu";
import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useAiUiStore } from "@/domains/ai/store/ai-ui.store";
import { cn } from "@/lib/utils";

/** Electron 无边框窗口拖拽区域样式（React CSSProperties 未内置该属性） */
type AppRegionStyle = CSSProperties & { WebkitAppRegion?: string };

const dragStyle = { WebkitAppRegion: "drag" } as AppRegionStyle;
const noDragStyle = { WebkitAppRegion: "no-drag" } as AppRegionStyle;

interface TopBarProps {
  /** 左侧插槽（AI 路由下注入折叠/搜索/筛选按钮） */
  leftSlot?: ReactNode;
  /** 右侧组前置插槽（AI 路由下注入会话内搜索，渲染在主题切换左边） */
  rightLeadingSlot?: ReactNode;
  /** 中段背景类：与主面板 main 同款（MainLayout 计算传入，视觉融为一体） */
  panelClass: string;
}

export default function TopBar({
  leftSlot,
  rightLeadingSlot,
  panelClass,
}: TopBarProps) {
  const isMac = window.platform === "darwin";
  const { t } = useTranslation(["common"]);
  const sidebarCollapsed = useAiUiStore((s) => s.sidebarCollapsed);
  const rightWidth = useAiUiStore((s) =>
    Object.values(s.topbarRightWidths).reduce((sum, width) => sum + width, 0),
  );

  return (
    <div
      className="fixed top-0 left-0 right-0 z-50 h-9 flex pr-0"
      style={dragStyle}
    >
      {/* 背景层三段（与下方栏位对齐）：左=侧栏、中=主面板、右=产物面板 */}
      <div
        className={cn(
          "h-full shrink-0 bg-muted/40 transition-[width] duration-200",
          sidebarCollapsed ? "w-0" : "w-64",
        )}
        style={{
          ...dragStyle,
          backgroundImage: "var(--skin-sidebar-bg, none)",
        }}
      />
      <div
        className={cn("h-full min-w-0 flex-1", panelClass)}
        style={dragStyle}
      />
      {/* 右段无宽度过渡：产物面板本体为条件渲染瞬切（无动画），
          此处跟随瞬切才能同频（左段有过渡是因为侧栏本体同为 200ms 动画） */}
      <div
        className="h-full shrink-0 bg-background"
        style={{ ...dragStyle, width: rightWidth }}
      />

      {/* 内容层（覆盖三段背景之上）：左（Logo+插槽）/ 右（主题·语言·用户） */}
      <div
        className="absolute inset-0 flex items-center justify-between"
        style={dragStyle}
      >
        {/* 左侧：Logo（Windows）+ 插槽；macOS 让出红绿灯区域 */}
        <div
          className={`flex items-center gap-1 ${isMac ? "pl-20" : "pl-2"}`}
          style={noDragStyle}
        >
          {!isMac && (
            <div className="flex items-center gap-2 mr-1">
              <AppLogo className="w-5 h-5" />
              <span className="text-sm font-semibold text-foreground tracking-tight select-none">
                {t("common:appName")}
              </span>
              <span className="text-xs text-muted-foreground select-none">
                {__APP_VERSION__}
              </span>
            </div>
          )}
          {leftSlot}
        </div>

        {/* 右侧：主题切换 + 语言切换 + 用户菜单 */}
        <div className="flex items-center h-full" style={noDragStyle}>
          <div className="flex items-center gap-1 mr-2">
            {rightLeadingSlot}
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
    </div>
  );
}

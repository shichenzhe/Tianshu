/**
 * 顶部全局操作栏
 * 包含 Logo、应用名与左右插槽（用户菜单与语言切换已移至全局侧边栏底部）
 * 背景三段与下方栏位对齐（顶栏背景跟随主题）：左段=侧栏色（sidebar
 * 主题渐变，宽随折叠）、中段=主面板同款底色（panelClass 由 MainLayout
 * 传入，融为一体）、右段=产物面板色（宽度由面板挂载上报 store；
 * slot.right 注册时右段即右侧面板顶部工具栏，底部 border-b 细线
 * 与左侧侧栏 Logo 行呼应，分隔工具栏与面板内容）
 */

import AppLogo from "@/components/common/AppLogo";
import PageHeaderHost, { PageHeaderRightHost } from "./PageHeaderHost";
import { usePageHeaderStore } from "./page-header.store";
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
  /** 中段背景类：与主面板 main 同款（MainLayout 计算传入，视觉融为一体） */
  panelClass: string;
}

export default function TopBar({ leftSlot, panelClass }: TopBarProps) {
  const isMac = window.platform === "darwin";
  const { t } = useTranslation(["common"]);
  const sidebarCollapsed = useAiUiStore((s) => s.sidebarCollapsed);
  const rightWidth = useAiUiStore((s) =>
    Object.values(s.topbarRightWidths).reduce((sum, width) => sum + width, 0),
  );
  // slot.right 有内容时右段即右侧面板的顶部工具栏（如项目配置面板标题，
  // 面板自身无 header 行）——底部画分隔线与左侧侧栏 Logo 行呼应；未注册
  // 时（会话产物面板，头部行在面板内部自带 border-b）不画，避免双线。
  // 线色取 foreground/15 而非 border：亮色壁纸皮肤（原野/松林等）面板底
  // ~96% 亮度，border 全值 90% 对比不足；foreground 15% 混合约 83% 深一档，
  // 暗色下自动反转为浅线，跨主题/皮肤稳定。中段（页面顶行）用户裁定
  // 不画线
  const hasRightSlot = usePageHeaderStore((s) => Boolean(s.slot?.right));

  return (
    <div
      className="fixed top-0 left-0 right-0 z-50 h-11 flex pr-0"
      style={dragStyle}
    >
      {/* 背景层三段（与下方栏位对齐）：左=侧栏、中=主面板、右=产物面板；
          右段 border-b 见上方 hasRightSlot 注释（data-topbar-right-bg 供
          单测锚定） */}
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
          此处跟随瞬切才能同频（左段有过渡是因为侧栏本体同为 200ms 动画）；
          border-b 见上方 hasRightSlot 注释（data-topbar-right-bg 供单测锚定） */}
      <div
        data-topbar-right-bg=""
        className={cn(
          "h-full shrink-0 bg-background",
          hasRightSlot && "border-b border-foreground/15",
        )}
        style={{ ...dragStyle, width: rightWidth }}
      />

      {/* 内容层（覆盖三段背景之上）：左（Logo+插槽）/ 中（页面顶行
          PageHeaderHost——各模块标题/Tab/操作按钮迁入）/ 右（会话内搜索） */}
      <div
        className="absolute inset-0 flex items-center justify-between"
        style={dragStyle}
      >
        {/* 左侧：Logo（Windows）+ 插槽；macOS 让出红绿灯区域。
            容器宽度与背景左段（侧栏宽）对齐——页面顶行（中段）从主面板
            左缘起渲染，不侵入侧栏背景；折叠时收缩为按钮组本身宽
            （宽度 w-64→auto 不可插值，瞬切——与右段同先例）。
            容器本身 drag：按钮组右侧空白可拖拽窗口（no-drag 仅交互块） */}
        <div
          className={cn(
            "flex shrink-0 items-center",
            sidebarCollapsed ? "w-auto" : "w-64",
          )}
          style={dragStyle}
        >
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
        </div>

        {/* 中段：页面顶行（无注册页面留空，左右仍 justify-between） */}
        <PageHeaderHost />

        {/* 右侧：Windows 窗口控制区；minWidth 与背景右段（产物面板宽）
            对齐——页面顶行（中段）不延伸到产物面板背景上方（与左侧
            侧栏段对称），面板收起时收缩为内容本身宽。
            容器 drag：控制区占位周边空白可拖拽窗口（窗口控制按钮由
            main.ts overlay 绘制在更高层，点击不受影响）；交互块由
            PageHeaderRightHost 自行标 no-drag */}
        <div
          className="flex h-full shrink-0 items-center justify-end pr-2"
          style={{ ...dragStyle, minWidth: rightWidth }}
        >
          {/* 页面顶行右段（右侧面板标题等）：靠左渲染，窗口控制保持贴右 */}
          <PageHeaderRightHost />
          {/* Windows 窗口控制区分隔线（macOS 无） */}
          {!isMac && <div className="w-px h-5 bg-border" />}
          {/* Windows Window Controls Placeholder - 保持与 main.ts overlay 一致（macOS 不渲染） */}
          {!isMac && <div className="w-[138px] h-full" />}
        </div>
      </div>
    </div>
  );
}

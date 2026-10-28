/**
 * 右栏 tab 条：图标 + 标题 + 悬停关闭（参照 BrowserTabBar 交互形态，
 * 紧凑 h-7）。已泛化供文件窗口复用：tabs 项最小形状 {id,title}，图标可经
 * iconOf 注入（缺省 KIND_ICON / FileText 兜底）、关闭可经 beforeClose 拦截。
 * 多 tab 横向滚动（右栏 340px 内），「+」由 DetailPanel 内联
 * 按钮提供（直开 newTab 占位 tab，外层并排，本组件不含）。tab 拖拽重排：
 * HTML5 原生 DnD（零依赖库），拖起半透明，落到目标 tab 位置回调 onReorder。
 * 溢出隐藏滚动条（照 WorkBuddy artifact-tabs__list：scrollbar-width:none +
 * ::-webkit-scrollbar display:none）；滚轮 deltaY 转横滚（触控板 deltaX 原生）；
 * 激活 tab 变化时 scrollIntoView 自动滚入视野。busyLabel（T17）：busy
 * 进行中文案注入——替代 title 渲染 + aria-busy + tab 禁交互。
 */
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  FileDiff,
  FileText,
  FolderTree,
  Globe,
  Package,
  SquarePlus,
  SquareTerminal,
  X,
} from "lucide-react";
import IconTooltip from "@/components/common/icon-tooltip";
import type { DetailTab, DetailTabKind } from "../../store/detail-panel.store";

const KIND_ICON: Record<DetailTabKind, typeof Globe> = {
  artifacts: Package,
  browser: Globe,
  workspace: FolderTree,
  terminal: SquareTerminal,
  changes: FileDiff,
  file: FileText,
  newTab: SquarePlus,
};

/** 泛化 tab 项：最小形状 {id,title}（DetailPanel 传完整 DetailTab；
    文件窗口传 FileWindowTab——kind 缺省时图标落 FileText 兜底或 iconOf 接管）。
    busyLabel（T17）：busy 进行中文案（文件窗口 closing/moving 注入），有值
    时替代 title 渲染 + aria-busy + tab 禁交互（不可点/不可关/不可拖，真实
    浏览器 pointer-events-none 全禁 + 事件守卫双保险）；null/缺省零影响。 */
type DetailTabBarItem = Pick<DetailTab, "id" | "title"> &
  Partial<DetailTab> & { busyLabel?: string | null };

interface DetailTabBarProps {
  tabs: DetailTabBarItem[];
  activeTabId: string;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onReorder: (fromId: string, toId: string) => void;
  /** 图标注入（文件窗口按 contentKind 映射）；缺省沿用 KIND_ICON */
  iconOf?: (tab: DetailTabBarItem) => typeof Globe;
  /** 关闭前拦截（返回 false 阻止；文件窗口关闭握手用）；缺省直关 */
  beforeClose?: (tabId: string) => boolean;
  /** tab 右键菜单挂点（文件窗口 TabContextMenu 用）；缺省不拦系统菜单 */
  onTabContextMenu?: (tabId: string, event: MouseEvent) => void;
}

export default function DetailTabBar({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onReorder,
  iconOf,
  beforeClose,
  onTabContextMenu,
}: DetailTabBarProps) {
  const { t } = useTranslation(["chat"]);
  // 拖拽中源 tab id（半透明反馈 + drop 目标判断）
  const [dragId, setDragId] = useState<string | null>(null);
  // 滚动容器：onWheel 手动横滚 + 激活 tab scrollIntoView 定位
  const listRef = useRef<HTMLDivElement>(null);

  // 激活 tab 变化（切 tab/新开）滚入视野；nearest 不牵动外层（fixed 面板）滚动。
  // 可选调用兜底 jsdom 未实现 scrollIntoView（真实浏览器恒有，仅测试环境缺）
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeTabId]);

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={t("chat:detailPanel.tabs")}
      // 滚动条隐藏三件套照 WorkBuddy artifact-tabs__list；React onWheel 被动
      // 监听无需 preventDefault（tab 条在 fixed 面板内不竖滚），滚轮 deltaY
      // 直接转横滚，触控板 deltaX 原生叠加
      onWheel={(e) => {
        e.currentTarget.scrollLeft += e.deltaY + e.deltaX;
      }}
      className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] overscroll-x-contain [&::-webkit-scrollbar]:hidden"
    >
      {tabs.map((tab) => {
        const Icon = iconOf
          ? iconOf(tab)
          : tab.kind
            ? KIND_ICON[tab.kind]
            : FileText;
        const active = tab.id === activeTabId;
        // busy 态（T17）：busyLabel 替代 title 做无障碍名与渲染文案，
        // tab 禁交互（点击/键盘/关闭/拖拽拾起与落点/右键全守卫 +
        // pointer-events-none；tabIndex -1 移出 Tab 序列——审查 M1/M2）
        const busy = !!tab.busyLabel;
        const label = tab.busyLabel ?? tab.title;
        return (
          <div
            key={tab.id}
            role="tab"
            tabIndex={busy ? -1 : 0}
            aria-selected={active}
            aria-label={label}
            aria-busy={busy ? "true" : undefined}
            draggable={!busy}
            onDragStart={() => {
              if (busy) return;
              setDragId(tab.id);
            }}
            onDragEnd={() => setDragId(null)}
            onDragOver={(e) => {
              if (dragId && dragId !== tab.id) e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              // busy 落点不接受重排（审查 M1：jsdom 直派发 drop 的可达路径；
              // 真实浏览器另有 draggable/dragStart 守卫，双保险）
              if (busy) return;
              if (dragId && dragId !== tab.id) onReorder(dragId, tab.id);
              setDragId(null);
            }}
            onClick={() => {
              if (busy) return;
              onSelect(tab.id);
            }}
            onContextMenu={(e) => {
              if (!onTabContextMenu || busy) return;
              e.preventDefault();
              onTabContextMenu(tab.id, e);
            }}
            onKeyDown={(e) => {
              if (busy) return;
              if (e.key === "Enter" || e.key === " ") onSelect(tab.id);
            }}
            className={`group flex h-7 max-w-32 min-w-20 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-xs ${
              active
                ? "border-primary/30 bg-primary-subtle text-primary"
                : "border-transparent text-muted-foreground hover:bg-primary-subtle hover:text-primary"
            } ${dragId === tab.id ? "opacity-50" : ""} ${
              busy ? "pointer-events-none cursor-default" : ""
            }`}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            <IconTooltip label={t("chat:detailPanel.closeTab")}>
              <button
                type="button"
                aria-label={t("chat:detailPanel.closeTab")}
                onClick={(e) => {
                  e.stopPropagation();
                  if (busy) return;
                  // beforeClose 拦截（false 阻止；无 prop / 返回真值直关）
                  if (beforeClose?.(tab.id) === false) return;
                  onClose(tab.id);
                }}
                className="shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-primary-subtle"
              >
                <X className="h-3 w-3" />
              </button>
            </IconTooltip>
          </div>
        );
      })}
    </div>
  );
}

/**
 * 工具栏右侧 `...` 菜单（WorkBuddy 对齐）：查找页面内容 / 缩放（- % +）/
 * 显示设备工具栏 / 截取屏幕截图 / 清除浏览数据（点击展开子项）/
 * 在外部浏览器打开。动作经 props 回调上抛（BrowserToolbar 负责通道与
 * toast），菜单只管开合、缩放步进钳制与清除子项展开。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { LucideIcon } from "lucide-react";
import {
  ChevronDown,
  Eye,
  Globe,
  Minus,
  MoreHorizontal,
  Plus,
  Scissors,
  Search,
  Trash2,
} from "lucide-react";
import IconTooltip from "@/components/common/icon-tooltip";

/** 缩放步进与钳制区间（WorkBuddy 常见档位：25%–500%） */
const ZOOM_STEP = 0.1;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 5;

/** 步进/重置统一过钳制（浮点累加误差就地取整两位） */
export function clampZoomFactor(factor: number): number {
  const rounded = Math.round(factor * 100) / 100;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, rounded));
}

interface MenuRowProps {
  icon: LucideIcon;
  label: string;
  title?: string;
  disabled?: boolean;
  /** 激活态（图标着主题色——设备工具栏已显示时的回显） */
  active?: boolean;
  onClick: () => void;
}

function MenuRow({
  icon: Icon,
  label,
  title,
  disabled,
  active,
  onClick,
}: MenuRowProps) {
  return (
    <button
      type="button"
      aria-label={title ?? label}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-primary-subtle hover:text-primary disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
    >
      <Icon
        className={`h-3.5 w-3.5 shrink-0 ${active ? "text-primary" : ""}`}
      />
      <span className="flex-1 text-left">{label}</span>
    </button>
  );
}

interface BrowserMoreMenuProps {
  /** 页面已加载（url 非空）——依赖 live guest 的动作禁用 */
  pageReady: boolean;
  zoomFactor: number;
  onZoomChange: (factor: number) => void;
  onFindInPage: () => void;
  deviceBarVisible: boolean;
  onToggleDeviceBar: () => void;
  onScreenshot: () => void;
  onClearData: (type: "cookies" | "cache") => void;
  onOpenExternal: () => void;
}

export default function BrowserMoreMenu({
  pageReady,
  zoomFactor,
  onZoomChange,
  onFindInPage,
  deviceBarVisible,
  onToggleDeviceBar,
  onScreenshot,
  onClearData,
  onOpenExternal,
}: BrowserMoreMenuProps) {
  const { t } = useTranslation(["chat"]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);

  // 动作项点击即收菜单（缩放行内交互不收，可连续加减）
  const run = (action: () => void) => {
    setMenuOpen(false);
    setClearOpen(false);
    action();
  };

  const zoomBtn =
    "rounded p-0.5 text-muted-foreground hover:bg-primary-subtle hover:text-primary";

  return (
    <div className="relative">
      <IconTooltip label={t("chat:browser.moreMenu")}>
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
          aria-label={t("chat:browser.moreMenu")}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </IconTooltip>
      {menuOpen && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => {
              setMenuOpen(false);
              setClearOpen(false);
            }}
          />
          <div className="absolute right-0 top-full z-20 mt-1 w-60 rounded-lg border border-border/50 bg-background p-1 shadow-lg">
            <MenuRow
              icon={Search}
              label={t("chat:browser.findInPage")}
              disabled={!pageReady}
              onClick={() => run(onFindInPage)}
            />
            {/* 缩放行：[- % +]，点百分比回 100%（缩放存 tab 态，不依赖 guest 即刻存活） */}
            <div className="flex items-center gap-2 rounded-md px-2 py-1 text-xs">
              <span className="flex-1">{t("chat:browser.zoomLabel")}</span>
              <IconTooltip label={t("chat:browser.zoomOut")}>
                <button
                  type="button"
                  aria-label={t("chat:browser.zoomOut")}
                  className={zoomBtn}
                  onClick={() =>
                    onZoomChange(clampZoomFactor(zoomFactor - ZOOM_STEP))
                  }
                >
                  <Minus className="h-3.5 w-3.5" />
                </button>
              </IconTooltip>
              <IconTooltip label={t("chat:browser.zoomReset")}>
                <button
                  type="button"
                  aria-label={t("chat:browser.zoomReset")}
                  className="w-11 text-center tabular-nums hover:bg-primary-subtle hover:text-primary"
                  onClick={() => onZoomChange(1)}
                >
                  {Math.round(zoomFactor * 100)}%
                </button>
              </IconTooltip>
              <IconTooltip label={t("chat:browser.zoomIn")}>
                <button
                  type="button"
                  aria-label={t("chat:browser.zoomIn")}
                  className={zoomBtn}
                  onClick={() =>
                    onZoomChange(clampZoomFactor(zoomFactor + ZOOM_STEP))
                  }
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </IconTooltip>
            </div>
            <MenuRow
              icon={Eye}
              label={t("chat:browser.deviceToolbar")}
              disabled={!pageReady}
              active={deviceBarVisible}
              onClick={() => run(onToggleDeviceBar)}
            />
            <MenuRow
              icon={Scissors}
              label={t("chat:browser.captureScreenshot")}
              disabled={!pageReady}
              onClick={() => run(onScreenshot)}
            />
            {/* 清除浏览数据：点击展开子项（子项才真正动手，父项是组头） */}
            <button
              type="button"
              aria-expanded={clearOpen}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-primary-subtle hover:text-primary"
              onClick={() => setClearOpen((v) => !v)}
            >
              <Trash2 className="h-3.5 w-3.5 shrink-0" />
              <span className="flex-1 text-left">
                {t("chat:browser.clearDataMenu")}
              </span>
              <ChevronDown
                className={`h-3 w-3 shrink-0 transition-transform ${clearOpen ? "rotate-180" : ""}`}
              />
            </button>
            {clearOpen && (
              <div className="pl-1">
                <p className="px-2 py-1 text-[10px] text-muted-foreground">
                  {t("chat:browser.clearedNote")}
                </p>
                <MenuRow
                  icon={Trash2}
                  label={t("chat:browser.clearCookies")}
                  onClick={() => run(() => onClearData("cookies"))}
                />
                <MenuRow
                  icon={Trash2}
                  label={t("chat:browser.clearCache")}
                  onClick={() => run(() => onClearData("cache"))}
                />
              </div>
            )}
            <MenuRow
              icon={Globe}
              label={t("chat:browser.openExternal")}
              disabled={!pageReady}
              onClick={() => run(onOpenExternal)}
            />
          </div>
        </>
      )}
    </div>
  );
}

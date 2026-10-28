/**
 * 文件窗口 tab 条：DetailTabBar 泛化复用（iconOf 按 contentKind 映射图标，
 * 闭包按 tab.id 从 store tabs 反查——DetailTabBarItem 类型上无 contentKind
 * 字段，反查即类型安全的下行通道）。行尾「+」挂 NewTabMenu（Task 15：
 * 新建/打开/最近）；tab 右键经 onTabContextMenu 挂 TabContextMenu
 * （移动语义/关闭其他/右侧/复制路径）。X 键关闭走 beforeClose 拦截：
 * 恒返回 false 阻断同步 closeTab，脏 tab 经 close-confirm 注册表确认
 * （确认浮层复用 FileWindowView 的 CloseConfirmBar）后异步落子关闭——
 * 与 tab 菜单「关闭」/关窗握手同一确认流，不绕过脏检查。
 * T17：busy 文案（busyLabel 注入，closing/moving →「正在关闭…/正在移到
 * 新窗口…」）；「+」左侧「打开的文档」下拉（OpenDocumentsMenu）列全部
 * tab 点击激活——tab 条横滚溢出的兜底入口。
 * 平台让位（照 DetailPanel 顶行口径）：darwin pl-20 让红绿灯
 * （trafficLightPosition，行高 h-11 使按钮中心与红绿灯同水平线）；
 * 非 darwin pr-[146px] 让 titleBarOverlay 窗口按钮区（pr-2 + w-[138px]
 * 控制区 = 146px，TopBar 右段口径）。窗口平台渲染期读取（测试可注入）。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  ChevronDown,
  FileCode2,
  FileImage,
  FileText,
  FileType2,
  Headphones,
  Table,
} from "lucide-react";
import IconTooltip from "@/components/common/icon-tooltip";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import DetailTabBar from "@/domains/ai/chat/components/detail-panel/DetailTabBar";
import {
  useFileWindowStore,
  type FileWindowContentKind,
  type FileWindowTab,
} from "../store/file-window.store";
import { confirmBeforeClose } from "../lib/close-confirm";
import NewTabMenu from "./NewTabMenu";
import TabContextMenu from "./TabContextMenu";

const KIND_ICON: Record<FileWindowContentKind, typeof FileText> = {
  md: FileText,
  text: FileText,
  csv: Table,
  image: FileImage,
  pdf: FileType2,
  html: FileCode2,
  audiovideo: Headphones,
};

/** busy 态 → tab 条文案（T17，i18n key 单点收口；null 恒不 busy） */
function busyLabelOf(
  busy: FileWindowTab["busy"],
  t: (key: string) => string,
): string | null {
  if (busy === "closing") return t("chat:fileWindow.tab.closing");
  if (busy === "moving") return t("chat:fileWindow.tab.moving");
  return null;
}

/** 「打开的文档」下拉（T17，spec §12-2）：tab 条横滚溢出兜底——列全部
 *  tabs（图标+标题，激活高亮）点击激活；busy tab 禁用（spec §4.1 溢出
 *  列表禁用）并示 busy 文案；无 tab 不渲染（空窗无入口意义）。 */
function OpenDocumentsMenu() {
  const { t } = useTranslation(["chat"]);
  const tabs = useFileWindowStore((s) => s.tabs);
  const activeTabId = useFileWindowStore((s) => s.activeTabId);
  const activate = useFileWindowStore((s) => s.activate);
  if (tabs.length === 0) return null;
  return (
    <DropdownMenu>
      <IconTooltip label={t("chat:fileWindow.tab.openDocuments")}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("chat:fileWindow.tab.openDocuments")}
            className="h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-primary"
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
      </IconTooltip>
      <DropdownMenuContent align="start" className="w-60">
        {tabs.map((tab) => {
          const Icon = KIND_ICON[tab.contentKind];
          const busyLabel = busyLabelOf(tab.busy, t);
          return (
            <DropdownMenuItem
              key={tab.id}
              disabled={!!busyLabel}
              onSelect={() => activate(tab.id)}
              className={
                tab.id === activeTabId ? "bg-primary-subtle text-primary" : ""
              }
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 max-w-full truncate">
                {busyLabel ?? tab.title}
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default function FileWindowTabBar() {
  const { t } = useTranslation(["chat"]);
  const isMac = window.platform === "darwin";
  const tabs = useFileWindowStore((s) => s.tabs);
  const activeTabId = useFileWindowStore((s) => s.activeTabId);
  const activate = useFileWindowStore((s) => s.activate);
  const closeTab = useFileWindowStore((s) => s.closeTab);
  const reorderTabs = useFileWindowStore((s) => s.reorderTabs);
  // 右键菜单落点（tab 被他路关闭后查无 tab 即不渲染）
  const [ctx, setCtx] = useState<{
    tabId: string;
    x: number;
    y: number;
  } | null>(null);
  const ctxTab = ctx ? tabs.find((t) => t.id === ctx.tabId) : undefined;
  return (
    <div
      className={`flex h-11 items-center gap-1 border-b border-border/50 px-2 [-webkit-app-region:drag] ${
        isMac ? "pl-20" : ""
      } ${!isMac ? "pr-[146px]" : ""}`}
    >
      {/* 顶行整体 drag（hidden 标题栏下窗口拖动唯一来源，红绿灯/overlay
          原生区不冲突）；交互块整体 no-drag 隔离——drag 区内点击不生效。
          wrapper 继承 min-w-0 保 DetailTabBar 横滚收缩链不断 */}
      <div className="flex min-w-0 items-center gap-1 [-webkit-app-region:no-drag]">
        <DetailTabBar
          tabs={tabs.map((tab) => ({
            ...tab,
            busyLabel: busyLabelOf(tab.busy, t),
          }))}
          activeTabId={activeTabId}
          onSelect={activate}
          onClose={closeTab}
          // 恒 false：阻断 DetailTabBar 同步关——非脏/确认放行由异步链手动
          // closeTab（同 TabContextMenu.close 口径，脏 tab 不再静默丢草稿）
          beforeClose={(tabId) => {
            void confirmBeforeClose(tabId, () =>
              toast.error(t("chat:fileWindow.saveFailed")),
            ).then((ok) => {
              if (ok) closeTab(tabId);
            });
            return false;
          }}
          onReorder={reorderTabs}
          iconOf={(tab) =>
            KIND_ICON[tabs.find((x) => x.id === tab.id)?.contentKind ?? "text"]
          }
          onTabContextMenu={(tabId, event) =>
            setCtx({ tabId, x: event.clientX, y: event.clientY })
          }
        />
        <OpenDocumentsMenu />
        <NewTabMenu />
      </div>
      {ctx && ctxTab && (
        <TabContextMenu
          tabId={ctx.tabId}
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
        />
      )}
    </div>
  );
}

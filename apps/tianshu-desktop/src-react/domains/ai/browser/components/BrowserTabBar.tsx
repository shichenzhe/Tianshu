/**
 * tab 条（挂 TopBar 中段 usePageHeader title 槽，照 ExpertsView pill 组
 * 先例——页面内容相应上移）：favicon/标题（title 空则 url hostname 兜底）
 * + 关闭 +「+」新建。TopBar 44px 行高内紧凑形态；tab 多时横向滚动
 * （50vw 硬上限避让右段产物面板）。
 */
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import IconTooltip from "@/components/common/icon-tooltip";
import { useBrowserStore } from "../store/browser.store";

export default function BrowserTabBar() {
  const { t } = useTranslation(["chat"]);
  const tabs = useBrowserStore((s) => s.tabs);
  const activeTabId = useBrowserStore((s) => s.activeTabId);
  const setActive = useBrowserStore((s) => s.setActive);
  const addTab = useBrowserStore((s) => s.addTab);
  const closeTab = useBrowserStore((s) => s.closeTab);

  const labelOf = (tab: { title: string; url: string }) => {
    if (tab.title) return tab.title;
    if (!tab.url) return t("chat:browser.newTab");
    try {
      return new URL(tab.url).hostname;
    } catch {
      return tab.url;
    }
  };

  return (
    <div className="flex min-w-0 items-center gap-1">
      <div className="flex min-w-0 max-w-[50vw] items-center gap-1 overflow-x-auto">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="button"
            tabIndex={0}
            onClick={() => setActive(tab.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") setActive(tab.id);
            }}
            className={`group flex h-7 max-w-36 min-w-24 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-xs ${
              tab.id === activeTabId
                ? "border-primary/30 bg-primary-subtle text-primary"
                : "border-transparent text-muted-foreground hover:bg-primary-subtle hover:text-primary"
            }`}
          >
            {tab.favicon ? (
              <img src={tab.favicon} alt="" className="h-3.5 w-3.5 shrink-0" />
            ) : null}
            <span className="min-w-0 flex-1 truncate">{labelOf(tab)}</span>
            <IconTooltip label={t("chat:browser.closeTab")}>
              <button
                type="button"
                aria-label={t("chat:browser.closeTab")}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                className="shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-primary-subtle"
              >
                <X className="h-3 w-3" />
              </button>
            </IconTooltip>
          </div>
        ))}
      </div>
      <IconTooltip label={t("chat:browser.newTabAction")}>
        <button
          type="button"
          aria-label={t("chat:browser.newTabAction")}
          onClick={() => addTab()}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
        >
          <Plus className="h-4 w-4" />
        </button>
      </IconTooltip>
    </div>
  );
}

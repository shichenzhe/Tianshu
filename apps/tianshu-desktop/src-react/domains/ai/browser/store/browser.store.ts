// src-react/domains/ai/browser/store/browser.store.ts
/**
 * 浏览器 tab 状态（内存态，spec 假设 1：重启回新标签页；登录态由
 * persist partition 保留）。url 为空串即新标签页形态。
 */
import { create } from "zustand";

export interface BrowserTab {
  id: string;
  /** 当前地址（did-navigate 同步）；空串 = 新标签页 */
  url: string;
  /** page-title-updated 同步；空串时 UI 以 url hostname 兜底 */
  title: string;
  /** page-favicon-updated 同步（dataUrl 或 http url） */
  favicon: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  /** 页面缩放（工具栏菜单钳制 0.25–5；缺省 1）。tab 态而非持久化——
   *  重开 tab 回 100%（WorkBuddy 对齐） */
  zoomFactor?: number;
}

function newTab(): BrowserTab {
  return {
    id: crypto.randomUUID(),
    url: "",
    title: "",
    favicon: "",
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
  };
}

interface BrowserState {
  tabs: BrowserTab[];
  activeTabId: string;
  /** 新建 tab 并激活（可带初始 url——站内 target=_blank 转新 tab 用）；
   * 返回新 tab id */
  addTab: (url?: string) => string;
  /** 关 tab；关 active 时切相邻，关最后一个时重置为新标签页 */
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  /** webview 事件回写（url/title/favicon/导航可用性/加载态） */
  syncTab: (id: string, partial: Partial<BrowserTab>) => void;
}

export const useBrowserStore = create<BrowserState>((set) => ({
  tabs: [],
  activeTabId: "",
  addTab: (url = "") => {
    const tab = { ...newTab(), url };
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
    return tab.id;
  },
  closeTab: (id) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return s;
      const tabs = s.tabs.filter((t) => t.id !== id);
      if (tabs.length === 0) {
        const fresh = newTab();
        return { tabs: [fresh], activeTabId: fresh.id };
      }
      const activeTabId =
        s.activeTabId === id
          ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? tabs[0].id)
          : s.activeTabId;
      return { tabs, activeTabId };
    }),
  setActive: (id) => set({ activeTabId: id }),
  syncTab: (id, partial) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...partial } : t)),
    })),
}));

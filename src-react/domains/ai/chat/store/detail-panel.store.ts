/**
 * 会话右栏 DetailPanel tab 状态：sessionId 隔离（切会话各自保留，
 * 切回不丢——browser url / terminal pty id / file 相对路径存负载；
 * 组件重挂重建视图）。
 * 内存态不持久化（重启重置，同 browser.store 假设）。关到最后一个 tab
 * 联动 ai-ui 的 artifactsOpen 收起右栏。
 */
import { create } from "zustand";
import { useAiUiStore } from "../../store/ai-ui.store";

export type DetailTabKind =
  | "artifacts"
  | "browser"
  | "workspace"
  | "terminal"
  | "changes"
  | "file"
  | "newTab";

export interface DetailTab {
  id: string;
  kind: DetailTabKind;
  title: string;
  createdAt: number;
  /** browser：当前地址（空串/undefined = 新标签页形态） */
  url?: string;
  /** terminal：主进程 pty 会话 id（重挂续连凭据） */
  terminalId?: string;
  /** file：工作空间内相对路径（同路径复用判据，标题为 basename） */
  filePath?: string;
}

export interface DetailPanelState {
  tabs: DetailTab[];
  activeTabId: string;
}

const EMPTY: DetailPanelState = { tabs: [], activeTabId: "" };
// 空态单例不可变：getStateOf 将其裸返回调用方，防外部改写污染所有
// 未初始化会话（浅 freeze 不及内层数组，tabs 需单独冻结）
Object.freeze(EMPTY);
Object.freeze(EMPTY.tabs);

interface DetailPanelStore {
  panels: Record<number, DetailPanelState>;
  openTab: (sessionId: number, kind: DetailTabKind, title: string) => string;
  closeTab: (sessionId: number, tabId: string) => void;
  setActive: (sessionId: number, tabId: string) => void;
  /** 新标签页占位 tab 原地替换为所选类型（WorkBuddy 形态）：保序换
      id/kind/title、清空负载并激活；未知 tabId no-op 返回 "" */
  replaceTab: (
    sessionId: number,
    tabId: string,
    kind: DetailTabKind,
    title: string,
  ) => string;
  syncTab: (
    sessionId: number,
    tabId: string,
    partial: Partial<Pick<DetailTab, "url" | "terminalId" | "filePath">>,
  ) => void;
  reorderTab: (sessionId: number, fromId: string, toId: string) => void;
}

const base = create<
  DetailPanelStore & {
    getStateOf: (sessionId: number) => DetailPanelState;
  }
>((set, get) => ({
  panels: {},
  openTab: (sessionId, kind, title) => {
    const tab: DetailTab = {
      id: crypto.randomUUID(),
      kind,
      title,
      createdAt: Date.now(),
    };
    set((s) => {
      const prev = s.panels[sessionId] ?? EMPTY;
      return {
        panels: {
          ...s.panels,
          [sessionId]: {
            tabs: [...prev.tabs, tab],
            activeTabId: tab.id,
          },
        },
      };
    });
    return tab.id;
  },
  closeTab: (sessionId, tabId) => {
    const prev = get().panels[sessionId] ?? EMPTY;
    if (!prev.tabs.some((t) => t.id === tabId)) return;
    const idx = prev.tabs.findIndex((t) => t.id === tabId);
    const tabs = prev.tabs.filter((t) => t.id !== tabId);
    if (tabs.length === 0) {
      // 关空：移除记录并联动收起右栏（等价 artifactsOpen=false）
      set((s) => {
        const panels = { ...s.panels };
        delete panels[sessionId];
        return { panels };
      });
      useAiUiStore.getState().setArtifactsOpen(false);
      return;
    }
    const activeTabId =
      prev.activeTabId === tabId
        ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? tabs[0].id)
        : prev.activeTabId;
    set((s) => ({
      panels: {
        ...s.panels,
        [sessionId]: { tabs, activeTabId },
      },
    }));
  },
  setActive: (sessionId, tabId) =>
    set((s) => {
      const prev = s.panels[sessionId] ?? EMPTY;
      if (!prev.tabs.some((t) => t.id === tabId)) return s;
      return {
        panels: { ...s.panels, [sessionId]: { ...prev, activeTabId: tabId } },
      };
    }),
  syncTab: (sessionId, tabId, partial) =>
    set((s) => {
      const prev = s.panels[sessionId] ?? EMPTY;
      if (!prev.tabs.some((t) => t.id === tabId)) return s;
      return {
        panels: {
          ...s.panels,
          [sessionId]: {
            ...prev,
            tabs: prev.tabs.map((t) =>
              t.id === tabId ? { ...t, ...partial } : t,
            ),
          },
        },
      };
    }),
  replaceTab: (sessionId, tabId, kind, title) => {
    const prev = get().panels[sessionId] ?? EMPTY;
    if (!prev.tabs.some((t) => t.id === tabId)) return "";
    const tab: DetailTab = {
      id: crypto.randomUUID(),
      kind,
      title,
      createdAt: Date.now(),
    };
    set((s) => ({
      panels: {
        ...s.panels,
        [sessionId]: {
          ...prev,
          tabs: prev.tabs.map((t) => (t.id === tabId ? tab : t)),
          activeTabId: tab.id,
        },
      },
    }));
    return tab.id;
  },
  reorderTab: (sessionId, fromId, toId) =>
    set((s) => {
      const prev = s.panels[sessionId] ?? EMPTY;
      const from = prev.tabs.findIndex((t) => t.id === fromId);
      const to = prev.tabs.findIndex((t) => t.id === toId);
      if (from === -1 || to === -1 || from === to) return s;
      const tabs = [...prev.tabs];
      const [moved] = tabs.splice(from, 1);
      // 落点语义「拖到目标上 = 放到目标位置（目标及其后顺移）」：
      // from<to 时目标已随删除左移一位，插 to-1 才落在目标原位
      tabs.splice(to > from ? to - 1 : to, 0, moved);
      return {
        panels: { ...s.panels, [sessionId]: { ...prev, tabs } },
      };
    }),
  getStateOf: (sessionId) => get().panels[sessionId] ?? EMPTY,
}));

export const useDetailPanelStore = Object.assign(base, {
  /** zustand 不把 state 字段挂到 hook 本体（仅 getState/setState/subscribe），
      镜像一份供 useDetailPanelStore.getStateOf(id) 非订阅直读（语义同 state 内版本） */
  getStateOf: (sessionId: number): DetailPanelState =>
    base.getState().getStateOf(sessionId),
});

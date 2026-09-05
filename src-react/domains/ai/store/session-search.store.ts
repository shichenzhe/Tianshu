/**
 * 会话内搜索状态：顶栏输入框与消息区高亮/定位的共享桥梁。
 * activeIndex 是全局命中序号（0 基，跨消息按出现顺序累计）；
 * totalHits 由 MessageList 渲染时回填，供输入框计数与导航取模
 */
import { create } from "zustand";

interface SessionSearchState {
  /** 搜索输入框展开态（false 时查询与命中态一并清空） */
  open: boolean;
  query: string;
  activeIndex: number;
  totalHits: number;
  setOpen: (open: boolean) => void;
  setQuery: (query: string) => void;
  /** Enter/Shift+Enter 导航（delta 1 下一条 / -1 上一条），到底循环 */
  navigate: (delta: 1 | -1) => void;
  /** MessageList 按当前消息流回填命中总数（值不变则不触发订阅刷新） */
  syncTotalHits: (total: number) => void;
  /** 切换会话：残留高亮与序号对不上新消息流，整体复位 */
  reset: () => void;
}

const INITIAL = {
  open: false,
  query: "",
  activeIndex: 0,
  totalHits: 0,
} as const;

export const useSessionSearchStore = create<SessionSearchState>((set, get) => ({
  ...INITIAL,
  setOpen: (open) => {
    if (!open) {
      set({ ...INITIAL });
      return;
    }
    set({ open });
  },
  // 关键字变化后命中集合随之变化：序号回到第一条，旧序号不再有意义
  setQuery: (query) => set({ query, activeIndex: 0 }),
  navigate: (delta) => {
    const { totalHits, activeIndex } = get();
    if (totalHits <= 0) {
      return;
    }
    set({ activeIndex: (activeIndex + delta + totalHits) % totalHits });
  },
  syncTotalHits: (total) => {
    if (total !== get().totalHits) {
      set({ totalHits: total });
    }
  },
  reset: () => set({ ...INITIAL }),
}));

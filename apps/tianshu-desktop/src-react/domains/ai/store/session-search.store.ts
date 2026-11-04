/**
 * 会话内搜索状态：顶栏输入框与消息区高亮/定位的共享桥梁。
 * activeIndex 是全局命中序号（0 基，跨消息按出现顺序累计）；
 * hits 为位置级命中集合（messageIdx 消息序 + blockIdx 原始块下标 +
 * 块内偏移），MessageList 按当前消息流回填；totalHits = hits.length，
 * 供输入框计数与导航取模
 */
import { create } from "zustand";

/** 位置级命中项（与 hit-positions.ts BlockHit 同形 + messageIdx） */
export interface SessionSearchHit {
  messageIdx: number;
  blockIdx: number;
  start: number;
  length: number;
}

interface SessionSearchState {
  /** 搜索输入框展开态（false 时查询与命中态一并清空） */
  open: boolean;
  query: string;
  activeIndex: number;
  totalHits: number;
  /** 位置级命中集合（history 时序序、同消息按块序/偏移序） */
  hits: SessionSearchHit[];
  setOpen: (open: boolean) => void;
  setQuery: (query: string) => void;
  /** Enter/Shift+Enter 导航（delta 1 下一条 / -1 上一条），到底循环 */
  navigate: (delta: 1 | -1) => void;
  /** MessageList 按当前消息流回填命中集合（同引用不触发订阅刷新） */
  setHits: (hits: SessionSearchHit[]) => void;
  /** 切换会话：残留高亮与序号对不上新消息流，整体复位 */
  reset: () => void;
}

const INITIAL = {
  open: false,
  query: "",
  activeIndex: 0,
  totalHits: 0,
  hits: [] as SessionSearchHit[],
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
  setHits: (hits) => {
    if (hits === get().hits) {
      return;
    }
    set({ hits, totalHits: hits.length });
  },
  reset: () => set({ ...INITIAL }),
}));

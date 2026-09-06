/**
 * AI 模块跨组件 UI 状态（侧边栏折叠 / 顶栏筛选 / 全局搜索面板开关）。
 * 折叠态沿用旧 sidebar-collapsed localStorage key（JSON 布尔），
 * 其余为内存态（刷新重置）。
 */

import { create } from "zustand";
import type { TimeFilter } from "../chat/lib/session-list";

/** 产物面板视图（概览总览 / 产物文件 / 工作空间文件） */
export type AiArtifactsView = "overview" | "artifacts" | "workspace";

const SIDEBAR_COLLAPSED_KEY = "sidebar-collapsed";

function readCollapsed(): boolean {
  try {
    return (
      JSON.parse(
        window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) ?? "false",
      ) === true
    );
  } catch {
    return false;
  }
}

interface AiUiState {
  sidebarCollapsed: boolean;
  timeFilter: TimeFilter;
  searchOpen: boolean;
  toggleSidebar: () => void;
  setTimeFilter: (filter: TimeFilter) => void;
  resetFilter: () => void;
  setSearchOpen: (open: boolean) => void;
  artifactsOpen: boolean;
  artifactsView: AiArtifactsView;
  toggleArtifacts: () => void;
  setArtifactsView: (view: AiArtifactsView) => void;
}

export const useAiUiStore = create<AiUiState>((set) => ({
  sidebarCollapsed: readCollapsed(),
  timeFilter: "all",
  searchOpen: false,
  artifactsOpen: false,
  artifactsView: "overview",
  toggleSidebar: () =>
    set((state) => {
      const next = !state.sidebarCollapsed;
      try {
        window.localStorage.setItem(
          SIDEBAR_COLLAPSED_KEY,
          JSON.stringify(next),
        );
      } catch {
        /* 持久化失败静默（隐私模式等） */
      }
      return { sidebarCollapsed: next };
    }),
  setTimeFilter: (filter) => set({ timeFilter: filter }),
  resetFilter: () => set({ timeFilter: "all" }),
  setSearchOpen: (open) => set({ searchOpen: open }),
  toggleArtifacts: () =>
    set((state) => ({ artifactsOpen: !state.artifactsOpen })),
  setArtifactsView: (view) => set({ artifactsView: view }),
}));

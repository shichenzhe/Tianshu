/**
 * 设置面板 UI 状态：open 态由 UserMenu 内部 useState 迁入 Zustand，
 * 供用户菜单入口与 ⌘, 快捷键（GlobalSidebar 分发器）共用；
 * settingsTab 供入口直达指定页（如用户菜单「记忆与进化」直达记忆页）
 */

import { create } from "zustand";

/** 右栏可用页 id（null = 默认 general；与 SettingsDialog 导航对应） */
export type SettingsTab =
  "general" | "profile" | "memory" | "appearance" | "shortcuts";

interface SettingsUiState {
  settingsOpen: boolean;
  /** 打开瞬间定位的页（null = 默认 general）；关闭时复位 null */
  settingsTab: SettingsTab | null;
  setSettingsOpen: (open: boolean) => void;
  /** 打开设置面板，可指定直达页（缺省 general） */
  openSettings: (tab?: SettingsTab) => void;
}

export const useSettingsUiStore = create<SettingsUiState>((set) => ({
  settingsOpen: false,
  settingsTab: null,
  // 关闭时一并复位 tab（定位只在打开瞬间生效，下次打开默认 general）
  setSettingsOpen: (open) =>
    set(
      open
        ? { settingsOpen: true }
        : { settingsOpen: false, settingsTab: null },
    ),
  openSettings: (tab) => set({ settingsOpen: true, settingsTab: tab ?? null }),
}));

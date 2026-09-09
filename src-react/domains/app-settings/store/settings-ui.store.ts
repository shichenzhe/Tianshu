/**
 * 设置面板 UI 状态：open 态由 UserMenu 内部 useState 迁入 Zustand，
 * 供用户菜单入口与 ⌘, 快捷键（AiLayout 分发器）共用
 */

import { create } from "zustand";

interface SettingsUiState {
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
}

export const useSettingsUiStore = create<SettingsUiState>((set) => ({
  settingsOpen: false,
  setSettingsOpen: (open) => set({ settingsOpen: open }),
}));

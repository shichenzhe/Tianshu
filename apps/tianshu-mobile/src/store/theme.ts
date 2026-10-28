import AsyncStorage from "@react-native-async-storage/async-storage";
import { colorScheme, useColorScheme } from "nativewind";
import { create } from "zustand";

import {
  DEFAULT_MODE,
  DEFAULT_THEME,
  THEME_PRESETS,
  resolveThemeColors,
  type ThemeMode,
  type ThemeName,
} from "../theme/colors";

/** 持久化 key（对齐 connections.store 的 tianshu-mobile.* 命名段） */
const STORAGE_KEY = "tianshu-mobile.theme";
const MODE_STORAGE_KEY = "tianshu-mobile.mode";

const THEME_NAMES = Object.keys(THEME_PRESETS) as ThemeName[];
const MODES: ThemeMode[] = ["system", "light", "dark"];

/** 合法主题名校验（恢复档防注入：未知值一律回 DEFAULT_THEME） */
function isThemeName(value: unknown): value is ThemeName {
  return typeof value === "string" && (THEME_NAMES as string[]).includes(value);
}

/** 合法明暗模式校验（恢复档防注入：未知值一律回 DEFAULT_MODE） */
function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && (MODES as string[]).includes(value);
}

/** 明暗模式施加：nativewind colorScheme.set 驱动 dark: 变体与 useColorScheme */
function applyMode(mode: ThemeMode) {
  colorScheme.set(mode);
}

interface ThemeState {
  themeName: ThemeName;
  mode: ThemeMode;
  setTheme: (name: ThemeName) => void;
  setMode: (mode: ThemeMode) => void;
}

/** 主题名 zustand 装配（M1 接 AsyncStorage 持久化：写 fire-and-forget、创建即恢复；
 *  T11 增明暗模式 mode——system 跟随系统、light/dark 手动钉死） */
export const useThemeStore = create<ThemeState>((set) => ({
  themeName: DEFAULT_THEME,
  mode: DEFAULT_MODE,
  setTheme: (themeName) => {
    set({ themeName });
    // fire-and-forget：写失败不阻塞交互，下次切换覆写重试
    void AsyncStorage.setItem(STORAGE_KEY, themeName).catch(() => {
      /* 静默：quota/IO 失败无需上抛 */
    });
  },
  setMode: (mode) => {
    set({ mode });
    applyMode(mode);
    void AsyncStorage.setItem(MODE_STORAGE_KEY, mode).catch(() => {
      /* 静默：quota/IO 失败无需上抛 */
    });
  },
}));

// store 创建即恢复存档（fire-and-forget；非法值/坏档静默保持 DEFAULT_THEME）。
// 恢复守卫（M4）：getItem 异步窗口内用户已手动切换（当前已非缺省主题）则
// 不覆写——存档是旧值，迟到的恢复不得吃掉用户刚做的选择
void AsyncStorage.getItem(STORAGE_KEY)
  .then((saved) => {
    if (
      isThemeName(saved) &&
      useThemeStore.getState().themeName === DEFAULT_THEME
    ) {
      useThemeStore.setState({ themeName: saved });
    }
  })
  .catch(() => {
    /* 静默：原生模块读取异常不阻断启动 */
  });

// 明暗档恢复：守卫同上（恢复窗口内已手动切换则不覆写），命中即施加
void AsyncStorage.getItem(MODE_STORAGE_KEY)
  .then((saved) => {
    if (
      isThemeMode(saved) &&
      useThemeStore.getState().mode === DEFAULT_MODE
    ) {
      useThemeStore.setState({ mode: saved });
      applyMode(saved);
    }
  })
  .catch(() => {
    /* 静默：原生模块读取异常不阻断启动 */
  });

/** 生效配色：主题色 × 明暗（subtle 双态，见 colors.ts 注释） */
export function useThemeColors() {
  const themeName = useThemeStore((state) => state.themeName);
  const { colorScheme } = useColorScheme();
  return resolveThemeColors(
    THEME_PRESETS[themeName],
    colorScheme === "dark" ? "dark" : "light"
  );
}

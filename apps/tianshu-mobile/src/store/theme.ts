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
import { getSkin, isSkinId, type SkinId } from "../theme/skins";

/** 持久化 key（对齐 connections.store 的 tianshu-mobile.* 命名段） */
const STORAGE_KEY = "tianshu-mobile.theme";
const MODE_STORAGE_KEY = "tianshu-mobile.mode";
const SKIN_STORAGE_KEY = "tianshu-mobile.skin";

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
  /** 精选皮肤（null=纯色主题；皮肤生效时 hue/mode 随皮肤三元组） */
  skinId: SkinId | null;
  setTheme: (name: ThemeName) => void;
  setMode: (mode: ThemeMode) => void;
  setSkin: (id: SkinId) => void;
}

/** 主题名 zustand 装配（M1 接 AsyncStorage 持久化：写 fire-and-forget、创建即恢复；
 *  T11 增明暗模式 mode——system 跟随系统、light/dark 手动钉死；
 *  精选皮肤批增 skinId——setSkin 三联动（hue/mode 随皮肤，明暗覆写一次），
 *  setTheme（纯色卡）即退出皮肤） */
export const useThemeStore = create<ThemeState>((set) => ({
  themeName: DEFAULT_THEME,
  mode: DEFAULT_MODE,
  skinId: null,
  setTheme: (themeName) => {
    // 选纯色主题 = 退出皮肤：清 skinId 并移除皮肤存档
    set({ themeName, skinId: null });
    // fire-and-forget：写失败不阻塞交互，下次切换覆写重试
    void AsyncStorage.setItem(STORAGE_KEY, themeName).catch(() => {
      /* 静默：quota/IO 失败无需上抛 */
    });
    void AsyncStorage.removeItem(SKIN_STORAGE_KEY).catch(() => {
      /* 静默：同上 */
    });
  },
  setMode: (mode) => {
    set({ mode });
    applyMode(mode);
    void AsyncStorage.setItem(MODE_STORAGE_KEY, mode).catch(() => {
      /* 静默：quota/IO 失败无需上抛 */
    });
  },
  setSkin: (skinId) => {
    const skin = getSkin(skinId);
    if (!skin) return; // 未知 id 防御：不变不写档
    // 三联动：皮肤携带 hue/mode（明暗档被覆写一次，随后仍可手动改）
    set({ skinId, themeName: skin.hue, mode: skin.mode });
    applyMode(skin.mode);
    void AsyncStorage.setItem(SKIN_STORAGE_KEY, skinId).catch(() => {
      /* 静默：quota/IO 失败无需上抛 */
    });
    void AsyncStorage.setItem(STORAGE_KEY, skin.hue).catch(() => {
      /* 静默：同上 */
    });
    void AsyncStorage.setItem(MODE_STORAGE_KEY, skin.mode).catch(() => {
      /* 静默：同上 */
    });
  },
}));

// store 创建即恢复存档（fire-and-forget；非法值/坏档静默保持缺省）。
// 恢复守卫：恢复窗口内用户已手动切换（任一维度已非缺省）则整体不覆写——
// 存档是旧值，迟到的恢复不得吃掉用户刚做的选择。
// 皮肤档优先：skin 存档在则整体生效（hue/mode 随皮肤三元组），否则回落
// 纯色路径分别恢复 theme/mode 档（三档单窗口统一恢复，杜绝多 promise
// 竞态下「theme 先恢复致皮肤档被 pristine 校验误杀」的时序漏洞）。
void Promise.all([
  AsyncStorage.getItem(STORAGE_KEY),
  AsyncStorage.getItem(MODE_STORAGE_KEY),
  AsyncStorage.getItem(SKIN_STORAGE_KEY),
])
  .then(([savedTheme, savedMode, savedSkin]) => {
    const state = useThemeStore.getState();
    if (
      state.skinId !== null ||
      state.themeName !== DEFAULT_THEME ||
      state.mode !== DEFAULT_MODE
    ) {
      return;
    }
    if (isSkinId(savedSkin)) {
      const skin = getSkin(savedSkin);
      if (!skin) return;
      useThemeStore.setState({
        skinId: savedSkin,
        themeName: skin.hue,
        mode: skin.mode,
      });
      applyMode(skin.mode);
      return;
    }
    if (isThemeName(savedTheme)) {
      useThemeStore.setState({ themeName: savedTheme });
    }
    if (isThemeMode(savedMode)) {
      useThemeStore.setState({ mode: savedMode });
      applyMode(savedMode);
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

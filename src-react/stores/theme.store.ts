/**
 * 主题状态管理
 * 支持四种主题：蓝色(blue)、红色(red)、绿色(green)、橙色(orange)
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemeType = "blue" | "red" | "green" | "orange";

interface ThemeState {
  theme: ThemeType;
  setTheme: (theme: ThemeType) => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: "orange",
      setTheme: (theme) => {
        set({ theme });
        // 立即应用到 DOM
        applyTheme(theme);
      },
    }),
    {
      name: "mirror-theme",
    },
  ),
);

/**
 * 应用主题到 DOM
 */
export function applyTheme(theme: ThemeType): void {
  document.documentElement.setAttribute("data-theme", theme);
}

/**
 * 初始化主题 - 从 store 中读取并应用
 */
export function initTheme(): void {
  // 从 localStorage 读取（因为 persist 中间件可能在组件初始化前未完成）
  const stored = localStorage.getItem("mirror-theme");
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      const theme = parsed.state?.theme as ThemeType;
      if (theme) {
        applyTheme(theme);
        return;
      }
    } catch {
      // 忽略解析错误
    }
  }
  // 默认应用橙色主题
  applyTheme("orange");
}

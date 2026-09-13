/**
 * 主题状态——兼容层（外观模块）
 *
 * 主题状态已迁移至 skin.store（皮肤三元组 { skin, hue } 驱动
 * data-mode/data-theme/data-wallpaper）；本文件保留旧入口兼容：
 * - useThemeStore：旧消费方（ThemeSelector）的适配视图
 *   { theme: hue, setTheme: setHue }——语义为色相微调，保持当前皮肤的
 *   明暗与壁纸不变
 * - ThemeType 类型 re-export
 * 新代码请直接使用 skin.store。
 */

import { useSkinStore } from "./skin.store";
import type { ThemeType } from "./skin.store";

export { useSkinStore };
export type { ThemeType };

/** 旧主题状态视图：字段名适配（theme → skin store 的 hue） */
export function useThemeStore(): {
  theme: ThemeType;
  setTheme: (theme: ThemeType) => void;
} {
  const { hue, setHue } = useSkinStore();
  return { theme: hue, setTheme: setHue };
}

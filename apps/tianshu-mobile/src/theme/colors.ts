/**
 * 四主题色（blue/red 对齐 Apple 系统色板，green/orange 对齐桌面原色；
 * 原 220° 低饱和灰蓝等 LLM 生成系色废弃）。
 *
 * 桌面对齐状态：2026-10-25 起两端主题色同步（用户裁定废分叉），任一侧
 * 改值须双向同步（桌面 mirror globals.css/skins.css；subtle 形态差异：
 * 移动端明暗双 tint alpha，桌面亮色 tint alpha+暗色实底公式——亮度体系
 * 各自维护）。
 *
 * subtle 语义（按压/选中底）改系统 tint 10-12% 透明写法（hsla）；
 * 暗色套用亮色相 + 25% 透明（green/orange；blue/red 保留原 22%）。
 */
export const THEME_PRESETS = {
  blue: {
    // systemBlue #007AFF
    primary: "hsl(211, 100%, 50%)",
    primaryHover: "hsl(211, 100%, 42%)",
    primaryActive: "hsl(211, 100%, 36%)",
    subtle: "hsla(211, 100%, 50%, 0.12)",
    subtleDark: "hsla(211, 100%, 60%, 0.22)",
  },
  red: {
    // systemRed #FF3B30
    primary: "hsl(0, 100%, 59%)",
    primaryHover: "hsl(0, 100%, 51%)",
    primaryActive: "hsl(0, 100%, 45%)",
    subtle: "hsla(0, 100%, 59%, 0.12)",
    subtleDark: "hsla(0, 100%, 66%, 0.22)",
  },
  green: {
    primary: "hsl(150, 60%, 40%)",
    primaryHover: "hsl(150, 60%, 35%)",
    primaryActive: "hsl(150, 60%, 30%)",
    subtle: "hsla(150, 60%, 40%, 0.12)",
    subtleDark: "hsla(150, 55%, 60%, 0.25)",
  },
  orange: {
    primary: "hsl(18, 65%, 60%)",
    primaryHover: "hsl(18, 65%, 53%)",
    primaryActive: "hsl(18, 65%, 46%)",
    subtle: "hsla(18, 65%, 60%, 0.12)",
    subtleDark: "hsla(18, 60%, 65%, 0.25)",
  },
} as const;

export type ThemeName = keyof typeof THEME_PRESETS;

export type ThemePreset = (typeof THEME_PRESETS)[ThemeName];

/** 明暗模式：system 跟随系统，light/dark 手动钉死（nativewind colorScheme.set 同语义） */
export type ThemeMode = "system" | "light" | "dark";

export const DEFAULT_THEME: ThemeName = "blue";

export const DEFAULT_MODE: ThemeMode = "system";

/** 明暗模式下生效的配色：subtle 按 scheme 取亮/暗套，其余色两态同值 */
export function resolveThemeColors(
  preset: ThemePreset,
  scheme: "light" | "dark",
) {
  return {
    ...preset,
    subtle: scheme === "dark" ? preset.subtleDark : preset.subtle,
  };
}

// 按钮样式映射纯函数（连接域按钮批 2026-11-01）：实色底必须对象式 style
// 下发——nativewind v4 下与 className 共存的函数式 style 的
// backgroundColor 会被静默丢弃（连接页六处实底按钮曾因此透明、白字浮
// 浅底近乎不可见），样式计算收敛于此作唯一取样式通道；按压反馈收敛为
// 背景层 opacity 0.72（同为对象式属性，不依赖函数式 style）。
import type { ViewStyle } from "react-native";

import { ACTION_DANGER, resolveThemeColors } from "../theme/colors";

export type ResolvedThemeColors = ReturnType<typeof resolveThemeColors>;

/** 五变体对齐 iOS 按钮语义：filled 主色实底 / tinted 主色淡底 /
 *  outlined 主色描边 / plain 中性描边 / danger 破坏性红淡底 */
export type ButtonVariant =
  "filled" | "tinted" | "outlined" | "plain" | "danger";

/** sm=行内操作钮（13px/px-3/gap-1），md=表单主钮（14px/px-4/gap-1.5） */
export type ButtonSize = "sm" | "md";

/** 背景/边框层样式（绝对定位铺满按钮，圆角随布局层 rounded-lg 同值） */
export function buttonShellStyle(
  variant: ButtonVariant,
  colors: ResolvedThemeColors,
  dark: boolean,
  pressed: boolean,
): ViewStyle {
  const shell: ViewStyle = { borderRadius: 8 };
  switch (variant) {
    case "filled":
      shell.backgroundColor = colors.primary;
      break;
    case "tinted":
      shell.backgroundColor = colors.subtle;
      break;
    case "outlined":
      shell.borderWidth = 1;
      shell.borderColor = colors.primary;
      shell.backgroundColor = "transparent";
      break;
    case "plain":
      shell.borderWidth = 1;
      // 中性边框：亮 rgba(60,60,67,0.18) / 暗 #545458A6（对齐既有描边钮）
      shell.borderColor = dark ? "#545458A6" : "rgba(60,60,67,0.18)";
      shell.backgroundColor = "transparent";
      break;
    case "danger":
      shell.backgroundColor = `${ACTION_DANGER}1a`;
      break;
  }
  return pressed ? { ...shell, opacity: 0.72 } : shell;
}

/** 文字对象式色（可靠通道）；null=走静态 className（filled 白 / plain 灰） */
export function buttonLabelTint(
  variant: ButtonVariant,
  colors: ResolvedThemeColors,
): string | null {
  switch (variant) {
    case "filled":
      return null;
    case "tinted":
      return colors.primaryActive;
    case "outlined":
      return colors.primary;
    case "plain":
      return null;
    case "danger":
      return ACTION_DANGER;
  }
}

/** 文字静态 className（tint 非 null 时被对象式色覆盖，垫中性即可） */
export function buttonLabelClassName(variant: ButtonVariant): string {
  switch (variant) {
    case "filled":
      return "text-white";
    case "plain":
      return "text-label2 dark:text-[#EBEBF599]";
    default:
      return "text-black dark:text-white";
  }
}

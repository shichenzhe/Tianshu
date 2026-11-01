import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useColorScheme } from "nativewind";

import {
  buttonLabelClassName,
  buttonLabelTint,
  buttonShellStyle,
  type ButtonSize,
  type ButtonVariant,
} from "@/logic/button-styles";
import { useThemeColors } from "@/store/theme";

interface Props {
  label: string;
  onPress?: () => void;
  /** 默认 filled；变体语义见 logic/button-styles */
  variant?: ButtonVariant;
  /** 默认 md（表单主钮）；sm=行内操作钮 */
  size?: ButtonSize;
  /** 左图标（色由调用方按变体给定，如 filled 传白） */
  icon?: ReactNode;
  /** 仅禁点不变灰（如「使用中」态） */
  disabled?: boolean;
  /** 禁点+半透明（加载/提交中） */
  busy?: boolean;
  selected?: boolean;
  /** 布局附加类（flex-1 等；勿传颜色类） */
  className?: string;
}

/** 实色底按钮统一件（连接域按钮批 2026-11-01）：背景/边框层在 children
 *  函数式内以普通 View 对象式 style 下发——nativewind v4 下与 className
 *  共存的函数式 style 的 backgroundColor 会被静默丢弃（连接页六处实底
 *  曾因此透明、浅色白字近乎不可见），样式收敛在 logic/button-styles；
 *  按压反馈=背景层 opacity 0.72。 */
export function PressableButton({
  label,
  onPress,
  variant = "filled",
  size = "md",
  icon,
  disabled = false,
  busy = false,
  selected,
  className,
}: Props) {
  const colors = useThemeColors();
  const { colorScheme } = useColorScheme();
  const dark = colorScheme === "dark";
  const tint = buttonLabelTint(variant, colors);
  const inactive = disabled || busy;
  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityState={{
        disabled: inactive || undefined,
        selected,
        busy: busy || undefined,
      }}
      className={`min-h-11 flex-row items-center justify-center rounded-lg ${
        size === "sm" ? "gap-1 px-3" : "gap-1.5 px-4"
      } ${busy ? "opacity-50" : ""} ${className ?? ""}`}
    >
      {({ pressed }) => (
        <>
          <View
            className="absolute inset-0 rounded-lg"
            style={buttonShellStyle(variant, colors, dark, pressed)}
          />
          {icon}
          <Text
            className={`${
              size === "sm" ? "text-[13px]" : "text-sm"
            } ${buttonLabelClassName(variant)}`}
            style={tint == null ? undefined : { color: tint }}
          >
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

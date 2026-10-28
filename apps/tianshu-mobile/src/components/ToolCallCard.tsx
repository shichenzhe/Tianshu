import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, Pressable, Text, View } from "react-native";

import { useThemeColors } from "@/store/theme";

/** 工具六态 → 徽章色（语义状态色非主题色：灰/蓝/绿/红/橙） */
const STATE_COLOR: Record<string, string> = {
  ready: "#8E8E93",
  "awaiting-approval": "#8E8E93",
  running: "#3b82f6",
  done: "#22c55e",
  error: "#FF3B30",
  denied: "#f97316",
};

const MONO = Platform.select({ ios: "Menlo", android: "monospace" });
/** 参数/输出预览硬截上限（防超长 JSON 撑爆列表） */
const ARGS_MAX = 160;
const OUTPUT_MAX = 2000;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** output 规整为字符串（协议 output?: unknown——live 流可能透传非字符串） */
function normalizeOutput(output: unknown): string | undefined {
  if (output == null) return undefined;
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

interface Props {
  toolName: string;
  args: Record<string, unknown>;
  /** 六值枚举（宽 string：历史数据不收窄） */
  state: string;
  output?: unknown;
}

/** 工具调用卡（T14）：工具名 + 状态徽章 + 参数摘要（截断）+ 输出折叠 */
export function ToolCallCard({ toolName, args, state, output }: Props) {
  const { t } = useTranslation("chat");
  const colors = useThemeColors();
  const [showOutput, setShowOutput] = useState(false);

  const color = STATE_COLOR[state] ?? "#8E8E93";
  const argsText = truncate(JSON.stringify(args ?? {}), ARGS_MAX);
  const outputText = normalizeOutput(output);

  return (
    <View className="mb-2 rounded-lg border border-sep px-3 py-2 dark:border-[#545458A6]">
      <View className="flex-row items-center gap-2">
        <Text
          numberOfLines={1}
          className="flex-1 text-xs font-medium text-black/80 dark:text-white/80"
          style={{ fontFamily: MONO }}
        >
          {toolName}
        </Text>
        <View
          className="flex-row items-center gap-1 rounded-full px-2 py-0.5"
          style={{ backgroundColor: `${color}1f` }}
        >
          <View className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
          <Text className="text-[10px]" style={{ color }}>
            {t(`toolState.${state}`, { defaultValue: state })}
          </Text>
        </View>
      </View>

      <Text
        numberOfLines={2}
        className="mt-1 text-xs text-label2 dark:text-[#EBEBF599]"
        style={{ fontFamily: MONO }}
      >
        {argsText}
      </Text>

      {outputText !== undefined && (
        <>
          <Pressable
            onPress={() => setShowOutput((v) => !v)}
            className="mt-1 self-start"
            hitSlop={6}
          >
            <Text className="text-xs" style={{ color: colors.primary }}>
              {showOutput ? t("hideOutput") : t("showOutput")}
            </Text>
          </Pressable>
          {showOutput && (
            <Text
              numberOfLines={24}
              className="mt-1 text-xs leading-4 text-label2 dark:text-[#EBEBF599]"
            >
              {truncate(outputText, OUTPUT_MAX)}
            </Text>
          )}
        </>
      )}
    </View>
  );
}

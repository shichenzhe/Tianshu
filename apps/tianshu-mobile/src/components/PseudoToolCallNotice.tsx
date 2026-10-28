import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, Text, View } from "react-native";
import { AlertTriangle, ChevronDown, ChevronUp } from "lucide-react-native";

import { useThemeColors } from "@/store/theme";

/** 折叠区原文预览字符预算（超出截断加省略号，原文仍可经复制取全） */
const MAX_PREVIEW_CHARS = 16000;

/** 伪工具调用警示折叠条（MR-T4）：警示头 + 原文保真（不进 Markdown） */
export function PseudoToolCallNotice({ rawText }: { rawText: string }) {
  const { t } = useTranslation("chat");
  const colors = useThemeColors();
  const [open, setOpen] = useState(false);

  return (
    <View className="my-1 rounded-md border border-amber-500/40 bg-amber-500/10">
      <Pressable
        onPress={() => setOpen((prev) => !prev)}
        accessibilityLabel={t("pseudoToolCallNotice")}
        className="flex-row items-center gap-2 px-3 py-1.5"
      >
        <AlertTriangle size={13} color="#f59e0b" />
        <Text
          numberOfLines={1}
          className="flex-1 text-xs text-amber-700 dark:text-amber-400"
        >
          {t("pseudoToolCallNotice")}
        </Text>
        {open ? (
          <ChevronUp size={13} color={colors.primary} />
        ) : (
          <ChevronDown size={13} color={colors.primary} />
        )}
      </Pressable>
      {open && (
        <ScrollView
          style={{ maxHeight: 300 }}
          nestedScrollEnabled
          className="px-3 pb-2"
        >
          <Text className="text-[11px] leading-4 text-label2 dark:text-[#EBEBF599]">
            {rawText.slice(0, MAX_PREVIEW_CHARS)}
            {rawText.length > MAX_PREVIEW_CHARS ? "…" : ""}
          </Text>
        </ScrollView>
      )}
    </View>
  );
}

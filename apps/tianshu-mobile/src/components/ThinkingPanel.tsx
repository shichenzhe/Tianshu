import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { ChevronRight } from "lucide-react-native";

import { summarizeThinking } from "@/logic/group-blocks";

/** 思考过程面板（T14）：默认收起（角标字符数 + 首句摘要），点按展开全文 */
export function ThinkingPanel({ text }: { text: string }) {
  const { t } = useTranslation("chat");
  const [expanded, setExpanded] = useState(false);

  return (
    <View className="mb-2 rounded-lg border border-sep px-3 py-2 dark:border-[#545458A6]">
      <Pressable
        onPress={() => setExpanded((v) => !v)}
        className="flex-row items-center gap-1.5"
      >
        <ChevronRight
          size={14}
          color="#8E8E93"
          style={{ transform: [{ rotate: expanded ? "90deg" : "0deg" }] }}
        />
        <Text className="text-xs font-medium text-label2 dark:text-[#EBEBF599]">
          {t("thinking")}
        </Text>
        <Text className="text-xs text-label3 dark:text-[#EBEBF54D]">{text.length}</Text>
      </Pressable>
      {expanded ? (
        <Text className="mt-2 text-xs leading-4 text-label2 dark:text-[#EBEBF599]">
          {text}
        </Text>
      ) : (
        <Text
          numberOfLines={1}
          className="mt-1 text-xs text-label3 dark:text-[#EBEBF54D]"
        >
          {summarizeThinking(text)}
        </Text>
      )}
    </View>
  );
}

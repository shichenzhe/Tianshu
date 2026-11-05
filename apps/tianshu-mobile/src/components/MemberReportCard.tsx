import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";

import type { MemberReportBlock } from "@tianshu/protocol";

/** 成员报告卡（memberReport 块，专家团可观测性批）：桌面专家团会话产块
 *  的远端历史回看——头部成员名 + 轮次 + 任务摘要，点按折叠/展开产出全文
 *  （ToolCallCard 的 Pressable 折叠先例，RN 无 details 原生形态） */
export function MemberReportCard({ block }: { block: MemberReportBlock }) {
  const { t } = useTranslation("chat");
  const [expanded, setExpanded] = useState(false);

  return (
    <View className="mb-2 rounded-lg border border-sep px-3 py-2 dark:border-[#545458A6]">
      <Pressable
        onPress={() => setExpanded((v) => !v)}
        accessibilityLabel={t("memberReportTitle", {
          member: block.memberName,
          round: block.round,
        })}
      >
        <View className="flex-row items-center gap-2">
          <Text
            numberOfLines={1}
            className="flex-1 text-xs font-medium text-black/80 dark:text-white/80"
          >
            {t("memberReportTitle", {
              member: block.memberName,
              round: block.round,
            })}
          </Text>
          <Text className="text-[10px] text-label3 dark:text-[#EBEBF54D]">
            {expanded ? t("memberReportCollapse") : t("memberReportExpand")}
          </Text>
        </View>
        {block.task !== "" && (
          <Text
            numberOfLines={1}
            className="mt-1 text-xs text-label2 dark:text-[#EBEBF599]"
          >
            {block.task}
          </Text>
        )}
      </Pressable>
      {expanded && (
        <Text className="mt-2 text-xs leading-[18px] text-black/80 dark:text-white/80">
          {block.content}
        </Text>
      )}
    </View>
  );
}

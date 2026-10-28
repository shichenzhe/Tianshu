import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { Sparkles } from "lucide-react-native";

import { useThemeColors } from "@/store/theme";

/**
 * 专家推荐卡（MR-T2，桌面 ExpertRecommendCard 只读版）：reason + slug
 * 胶囊行；「添加并启用」裁剪（需 assistant/save+marketplace，远控协议
 * 无此端点——spec §4 留档另行立批），脚注引导桌面端操作。
 */
export function RecommendCard({
  reason,
  slugs,
}: {
  reason: string;
  slugs: string[];
}) {
  const { t } = useTranslation("chat");
  const colors = useThemeColors();

  return (
    <View className="my-2 rounded-lg border border-sep bg-white px-3 py-2.5 dark:border-[#545458A6] dark:bg-neutral-800">
      <View className="mb-1 flex-row items-center gap-1.5">
        <Sparkles size={13} color={colors.primary} />
        <Text className="text-xs font-medium text-label2 dark:text-[#EBEBF599]">
          {t("recommendTitle")}
        </Text>
      </View>
      {reason !== "" && (
        <Text className="mb-2 text-sm leading-5 text-black dark:text-white">
          {reason}
        </Text>
      )}
      {slugs.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 6, paddingBottom: 4 }}
        >
          {slugs.map((slug) => (
            <View
              key={slug}
              className="rounded-full border px-3 py-1"
              style={{
                borderColor: `${colors.primary}40`,
                backgroundColor: colors.subtle,
              }}
            >
              <Text
                className="text-xs"
                style={{ color: colors.primary }}
                numberOfLines={1}
              >
                {slug}
              </Text>
            </View>
          ))}
        </ScrollView>
      )}
      <Text className="mt-1 text-[10px] text-black/35 dark:text-white/35">
        {t("recommendAddOnDesktop")}
      </Text>
    </View>
  );
}

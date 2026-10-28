// 技能市场独立页（抽取批）：原内嵌「我的-设置」页的发现区抽为本页——
// 照专家页范式，列表独立成页、行点进 /skills/[slug] 详情页。内容为
// SkillHubSection（搜索/分类/列表/安装，能力门禁 skillhub——无能力时
// 页内显「市场不可用」占位）。路由注意：静态段 skills/market 优先于
// skills/[slug] 动态段匹配，故 slug 恰为 "market" 的技能详情不可达
// （上游 slug 命名惯例 kebab-case 技术词，撞名概率忽略，留档于此）。
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { PageHeader } from "@/components/PageHeader";
import { SkillHubSection } from "@/components/SkillHubSection";
import {
  useConnectionCapabilities,
  useConnectionsStore,
} from "@/store/connections.store";

export default function SkillMarketScreen() {
  const { t } = useTranslation(["skills"]);
  const activeConnId = useConnectionsStore((s) => s.activeConnId);
  const capabilities = useConnectionCapabilities(activeConnId);
  const skillhubCap = capabilities?.includes("skillhub") ?? false;

  return (
    <SafeAreaView style={{ flex: 1 }} edges={["top", "bottom"]}>
      <PageHeader title={t("skills:marketTitle")} />
      <ScrollView
        className="flex-1 bg-grouped dark:bg-black"
        contentContainerStyle={{ padding: 16, gap: 16 }}
      >
        {skillhubCap ? (
          <SkillHubSection />
        ) : (
          <View className="items-center py-10">
            <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
              {t("skills:error.SKILLHUB_UNAVAILABLE")}
            </Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

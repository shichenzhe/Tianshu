// 技能详情页（技能市场详情页化批，/skills/[slug] 动态路由，照 session/[id]
// 先例）：PageHeader（返回+技能名）+ 概要区（图标/名称/版本/分类/双语描述/
// 下载量/星标/评分——SkillHubSkillDto 全字段，v1 无 detail 端点概要为
// 尽力度）+ 底部安装操作（runSkillInstall 共用链：安装中单槽态/已安装
// 标注/冲突覆盖确认）。取数经 loadSkillDetail：marketItems 直找 → fallback
// searchMarket 回捞 → missing「不存在/已下架」占位。RN 铁律：行禁 flex-1、
// 零硬编码主题色（theme store + 既有 label 类）。
import { useEffect, useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { Image } from "expo-image";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  Download,
  Package,
  ShieldAlert,
  ShieldCheck,
  Star,
  User,
} from "lucide-react-native";
import type { SkillHubSkillDto } from "@tianshu/protocol";

import { MarkdownLite } from "@/components/MarkdownLite";
import { PageHeader } from "@/components/PageHeader";
import { loadSkillDetail } from "@/logic/skill-detail";
import { runSkillInstall } from "@/logic/skill-install";
import { useSkillsStore } from "@/store/skills.store";
import { useThemeColors } from "@/store/theme";

export default function SkillDetailScreen() {
  const { t, i18n } = useTranslation(["skills", "common"]);
  const colors = useThemeColors();
  const params = useLocalSearchParams<{ slug?: string | string[] }>();
  const raw = params.slug;
  const slug = Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
  const categories = useSkillsStore((s) => s.categories);
  const installedRows = useSkillsStore((s) => s.rows);
  const installingSlug = useSkillsStore((s) => s.installingSlug);
  const detail = useSkillsStore((s) => s.detail);
  const detailLoading = useSkillsStore((s) => s.detailLoading);
  const [skill, setSkill] = useState<SkillHubSkillDto | null>(null);
  const [searching, setSearching] = useState(false);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSkill(null);
    setMissing(false);
    setSearching(true);
    void loadSkillDetail(slug).then((result) => {
      if (cancelled) return;
      setSearching(false);
      if (result.kind === "found") setSkill(result.skill);
      else setMissing(true);
    });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // detail 批：进页/换 slug 拉取 hub 详情增广区（失败写 detailError
  // 静默——概要区不受影响；store 起始已清 detail 防跨技能陈旧闪现）
  useEffect(() => {
    if (!slug) return;
    void useSkillsStore.getState().loadDetail(slug);
  }, [slug]);

  const installing = skill !== null && installingSlug === skill.slug;
  const installed =
    skill !== null && installedRows.some((row) => row.name === skill.name);
  const categoryEntry = categories.find(
    (entry) => entry.key === skill?.category,
  );
  const categoryLabel = categoryEntry
    ? i18n.language.startsWith("zh")
      ? categoryEntry.name
      : categoryEntry.nameEn
    : (skill?.category ?? "");
  const description =
    skill !== null && i18n.language.startsWith("zh")
      ? skill.description_zh || skill.description
      : skill?.description;

  // 增广区数据（detail 批）：slug 匹配防陈旧；security 三态本地化
  const pageDetail =
    detail !== null && detail.skill.slug === slug ? detail : null;
  const securityStatus = pageDetail?.security ?? "unknown";
  const securityColor =
    securityStatus === "benign"
      ? "#34C759"
      : securityStatus === "caution"
        ? "#FF9500"
        : colors.primary;
  const SecurityIcon =
    securityStatus === "caution" ? ShieldAlert : ShieldCheck;
  const securityText =
    securityStatus === "benign"
      ? t("skills:detailSecurityBenign")
      : securityStatus === "caution"
        ? t("skills:detailSecurityCaution")
        : t("skills:detailSecurityUnknown");
  const detailSummary =
    pageDetail !== null && i18n.language.startsWith("zh")
      ? pageDetail.skill.summary_zh || pageDetail.skill.summary
      : pageDetail?.skill.summary;

  return (
    <SafeAreaView style={{ flex: 1 }} edges={["top", "bottom"]}>
      <PageHeader title={skill?.name ?? t("skills:detailTitle")} />
      <ScrollView className="flex-1 px-4" contentContainerStyle={{ gap: 12 }}>
        {searching ? (
          <View className="items-center py-10">
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : missing || skill === null ? (
          <View className="items-center py-10">
            <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
              {t("skills:detailNotFound")}
            </Text>
          </View>
        ) : (
          <>
            <View className="flex-row items-center gap-3">
              {skill.iconUrl ? (
                <Image
                  source={{ uri: skill.iconUrl }}
                  style={{ width: 56, height: 56 }}
                  className="rounded-xl"
                  contentFit="cover"
                />
              ) : (
                <View
                  className="h-14 w-14 items-center justify-center rounded-xl"
                  style={{ backgroundColor: colors.subtle }}
                >
                  <Package size={26} color={colors.primary} />
                </View>
              )}
              <View className="min-w-0 flex-1">
                <Text
                  numberOfLines={1}
                  className="text-lg font-semibold text-black dark:text-white"
                >
                  {skill.name}
                </Text>
                <Text className="mt-0.5 text-xs text-label3 dark:text-[#EBEBF54D]">
                  v{skill.version} · {categoryLabel}
                </Text>
              </View>
            </View>
            <View
              className="flex-row rounded-lg px-3 py-2.5"
              style={{ backgroundColor: colors.subtle }}
            >
              <View className="min-w-0 flex-1 items-center">
                <Text className="text-sm font-semibold text-black dark:text-white">
                  {skill.downloads}
                </Text>
                <Text className="mt-0.5 text-[10px] text-label3 dark:text-[#EBEBF54D]">
                  {t("skills:detailDownloads")}
                </Text>
              </View>
              <View className="min-w-0 flex-1 items-center">
                <View className="flex-row items-center gap-1">
                  <Star size={12} color={colors.primary} />
                  <Text className="text-sm font-semibold text-black dark:text-white">
                    {skill.stars}
                  </Text>
                </View>
                <Text className="mt-0.5 text-[10px] text-label3 dark:text-[#EBEBF54D]">
                  {t("skills:detailStars")}
                </Text>
              </View>
              <View className="min-w-0 flex-1 items-center">
                <Text className="text-sm font-semibold text-black dark:text-white">
                  {skill.score}
                </Text>
                <Text className="mt-0.5 text-[10px] text-label3 dark:text-[#EBEBF54D]">
                  {t("skills:detailScore")}
                </Text>
              </View>
            </View>
            {description ? (
              <Text className="text-sm leading-6 text-black dark:text-white">
                {description}
              </Text>
            ) : null}
            {pageDetail !== null ? (
              <>
                <View className="flex-row items-center gap-3">
                  {pageDetail.owner ? (
                    <View className="flex-row items-center gap-1">
                      <User size={12} color={colors.primary} />
                      <Text
                        numberOfLines={1}
                        className="text-xs text-label2 dark:text-[#EBEBF599]"
                      >
                        {pageDetail.owner.displayName}
                      </Text>
                    </View>
                  ) : null}
                  <View className="flex-row items-center gap-1">
                    <SecurityIcon size={12} color={securityColor} />
                    <Text
                      className="text-xs font-medium"
                      style={{ color: securityColor }}
                    >
                      {securityText}
                    </Text>
                  </View>
                </View>
                {pageDetail.skill.stats ? (
                  <Text className="text-xs text-label3 dark:text-[#EBEBF54D]">
                    {t("skills:detailMetaLine", {
                      installs: pageDetail.skill.stats.installs,
                      versions: pageDetail.skill.stats.versions,
                      comments: pageDetail.skill.stats.comments,
                    })}
                  </Text>
                ) : null}
                <Text className="text-sm font-semibold text-black dark:text-white">
                  {t("skills:detailOverview")}
                </Text>
                {pageDetail.skill.overviewMd ? (
                  <MarkdownLite text={pageDetail.skill.overviewMd} />
                ) : detailSummary ? (
                  <Text className="text-sm leading-6 text-black dark:text-white">
                    {detailSummary}
                  </Text>
                ) : (
                  <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
                    {t("skills:detailOverviewEmpty")}
                  </Text>
                )}
              </>
            ) : detailLoading ? (
              <View className="items-center py-2">
                <ActivityIndicator size="small" color={colors.primary} />
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
      {skill !== null ? (
        <View className="border-t border-sep px-4 py-3 dark:border-[#545458A6]">
          {installed ? (
            <Text className="py-2.5 text-center text-sm font-medium text-label3 dark:text-[#EBEBF54D]">
              {t("skills:installed")}
            </Text>
          ) : (
            <Pressable
              accessibilityRole="button"
              disabled={installing}
              onPress={() => void runSkillInstall(skill.slug)}
              className="flex-row items-center justify-center gap-2 rounded-lg py-3"
              style={{
                backgroundColor: colors.primary,
                opacity: installing ? 0.6 : 1,
              }}
            >
              {installing ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Download size={16} color="#FFFFFF" />
              )}
              <Text className="text-sm font-semibold text-white">
                {installing ? t("skills:installing") : t("skills:install")}
              </Text>
            </Pressable>
          )}
        </View>
      ) : null}
    </SafeAreaView>
  );
}

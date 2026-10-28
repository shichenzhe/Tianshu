// SkillHub 技能市场内容区（A3 批；抽取批起宿主为 /skills/market 独立页，
// 原「我的-设置」内嵌形态改入口行跳转）：分类横滚条 +
// 搜索（300ms 防抖，MarketSearchScheduler 调度——定时器回调读最新
// keyword/category，切分类后旧定时器不发陈旧组合）+ 列表分页（初始 top
// 推荐位，条件搜索走 list）+ install（宿主侧下载 zip，手机零流量；经
// runSkillInstall 共用安装链，conflict Alert 覆盖确认）。筛选失败行内
// 错误条可见不静默（marketError + 重试；install 失败走 toast 由
// installError 供码）。能力门禁：连接 capabilities 不含 "skillhub" 时整区
// 隐藏（无头端不报，零迁移）。
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { Download } from "lucide-react-native";

import { PLACEHOLDER } from "@/components/FormField";

import { MarketSearchScheduler } from "@/logic/market-search-scheduler";
import {
  sortMarketItems,
  type MarketSortMode,
} from "@/logic/skill-market-sort";
import { runSkillInstall } from "@/logic/skill-install";
import {
  useConnectionCapabilities,
  useConnectionsStore,
} from "@/store/connections.store";
import { useSkillsStore } from "@/store/skills.store";
import { useThemeColors } from "@/store/theme";

const SEARCH_DEBOUNCE_MS = 300;

/** 市场排序三档（detail 批）：综合=score / 热门=downloads / 最新=
 *  createdAt——纯客户端排序，最新档缺 createdAt 行沉底（旧被控端回退） */
const MARKET_SORTS: MarketSortMode[] = ["comprehensive", "hot", "newest"];
const MARKET_SORT_LABEL_KEYS: Record<MarketSortMode, string> = {
  comprehensive: "skills:sortComprehensive",
  hot: "skills:sortHot",
  newest: "skills:sortNewest",
};

/** 市场分类标签：按当前语言取 name/nameEn */
function categoryLabel(name: string, nameEn: string, language: string): string {
  return language.startsWith("zh") ? name : nameEn;
}

export function SkillHubSection() {
  const router = useRouter();
  const { t, i18n } = useTranslation(["settings", "skills", "common"]);
  const colors = useThemeColors();
  const activeConnId = useConnectionsStore((s) => s.activeConnId);
  const capabilities = useConnectionCapabilities(activeConnId);
  const skillhubCap = capabilities?.includes("skillhub") ?? false;
  const categories = useSkillsStore((s) => s.categories);
  const items = useSkillsStore((s) => s.marketItems);
  const total = useSkillsStore((s) => s.marketTotal);
  const loading = useSkillsStore((s) => s.marketLoading);
  const loadingMore = useSkillsStore((s) => s.marketLoadingMore);
  const marketError = useSkillsStore((s) => s.marketError);
  const installingSlug = useSkillsStore((s) => s.installingSlug);
  const installedRows = useSkillsStore((s) => s.rows);
  const [keywordInput, setKeywordInput] = useState("");
  const [keyword, setKeyword] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<MarketSortMode>("comprehensive");
  const sortedItems = useMemo(
    () => sortMarketItems(items, sortMode),
    [items, sortMode],
  );

  const search = useCallback(
    (nextKeyword: string, nextCategory: string | null) => {
      setKeyword(nextKeyword);
      setCategory(nextCategory);
      void useSkillsStore
        .getState()
        .searchMarket(
          { keyword: nextKeyword, category: nextCategory ?? undefined },
          true,
        );
    },
    [],
  );

  // 防抖调度器：内部以最新值语义存 keyword/category，定时器到点读最新
  // 组合（修旧闭包捕获创建时 category 的陈旧请求问题）
  const scheduler = useMemo(
    () => new MarketSearchScheduler(search, SEARCH_DEBOUNCE_MS),
    [search],
  );

  useEffect(() => {
    if (!skillhubCap) return;
    const store = useSkillsStore.getState();
    void store.loadCategories();
    void store.loadMarketTop();
    // 已装列表用于「已安装」标注（skills/query 与 skillhub 同面加载）
    void store.load();
  }, [skillhubCap, activeConnId]);

  useEffect(() => () => scheduler.dispose(), [scheduler]);

  const onSearchChange = useCallback(
    (value: string) => {
      setKeywordInput(value);
      scheduler.input(value);
    },
    [scheduler],
  );

  const onSelectCategory = useCallback(
    (next: string | null) => {
      scheduler.select(next);
    },
    [scheduler],
  );

  if (!skillhubCap) return null;

  const installedNames = new Set(installedRows.map((row) => row.name));

  const canLoadMore =
    !loading && !loadingMore && keyword !== "" && items.length < total;

  function renderRow({ item }: { item: (typeof sortedItems)[number] }) {
    const installing = installingSlug === item.slug;
    const installed = installedNames.has(item.name);
    const description = i18n.language.startsWith("zh")
      ? item.description_zh || item.description
      : item.description;
    return (
      // 整行可点进详情页（/skills/[slug]）；内嵌安装钮为独立 Pressable，
      // 点钮不触发行导航（RN 内层优先消费按压）
      <Pressable
        accessibilityRole="button"
        onPress={() => router.push(`/skills/${item.slug}`)}
        className="flex-row items-center gap-2 border-b border-black/5 py-2 dark:border-white/10"
      >
        <View className="min-w-0 flex-1">
          <View className="flex-row items-center gap-1.5">
            <Text
              numberOfLines={1}
              className="min-w-0 flex-1 text-sm text-black dark:text-white"
            >
              {item.name}
            </Text>
            <Text className="text-[10px] text-label3 dark:text-[#EBEBF54D]">
              v{item.version}
            </Text>
          </View>
          <Text
            numberOfLines={2}
            className="mt-0.5 text-xs text-label3 dark:text-[#EBEBF54D]"
          >
            {description}
          </Text>
        </View>
        {installed ? (
          <Text className="text-xs text-label3 dark:text-[#EBEBF54D]">
            {t("skills:installed")}
          </Text>
        ) : (
          <Pressable
            accessibilityRole="button"
            disabled={installing}
            onPress={() => void runSkillInstall(item.slug)}
            hitSlop={8}
            className="flex-row items-center gap-1 rounded-md px-2 py-1"
            style={{
              backgroundColor: colors.subtle,
              opacity: installing ? 0.5 : 1,
            }}
          >
            {installing ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Download size={12} color={colors.primary} />
            )}
            <Text
              className="text-xs font-medium"
              style={{ color: colors.primary }}
            >
              {installing ? t("skills:installing") : t("skills:install")}
            </Text>
          </Pressable>
        )}
      </Pressable>
    );
  }

  return (
    <View className="gap-2">
      <View className="gap-2 rounded-lg border border-sep px-3 py-2 dark:border-[#545458A6]">
        <TextInput
          value={keywordInput}
          onChangeText={onSearchChange}
          placeholder={t("skills:marketSearchPlaceholder")}
          placeholderTextColor={PLACEHOLDER}
          autoCapitalize="none"
          autoCorrect={false}
          className="rounded-lg border border-sep bg-field px-3 py-2 text-sm text-black dark:border-[#545458A6] dark:bg-[#2C2C2E] dark:text-white"
        />
        <View className="flex-row rounded-lg border border-sep p-0.5 dark:border-[#545458A6]">
          {MARKET_SORTS.map((key) => {
            const active = sortMode === key;
            return (
              <Pressable
                key={key}
                onPress={() => setSortMode(key)}
                className="flex-1 items-center rounded-md py-1.5"
                style={{
                  backgroundColor: active ? colors.primary : "transparent",
                }}
              >
                <Text
                  className="text-xs font-medium"
                  style={{ color: active ? "#FFFFFF" : colors.primary }}
                >
                  {t(MARKET_SORT_LABEL_KEYS[key])}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <FlatList
          horizontal
          data={categories}
          keyExtractor={(item) => item.key}
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0, flexShrink: 0 }}
          contentContainerStyle={{ gap: 6, alignItems: "center" }}
          ListHeaderComponent={
            <Pressable
              onPress={() => onSelectCategory(null)}
              className="rounded-full px-3 py-1"
              style={{
                backgroundColor:
                  category === null ? colors.primary : colors.subtle,
              }}
            >
              <Text
                className="text-xs"
                style={{
                  color: category === null ? "#FFFFFF" : colors.primary,
                }}
              >
                {t("skills:allCategories")}
              </Text>
            </Pressable>
          }
          renderItem={({ item }) => {
            const active = category === item.key;
            return (
              <Pressable
                onPress={() => onSelectCategory(active ? null : item.key)}
                className="rounded-full px-3 py-1"
                style={{
                  backgroundColor: active ? colors.primary : colors.subtle,
                }}
              >
                <Text
                  className="text-xs"
                  style={{ color: active ? "#FFFFFF" : colors.primary }}
                >
                  {categoryLabel(item.name, item.nameEn, i18n.language)}
                </Text>
              </Pressable>
            );
          }}
        />
        {marketError && !loading ? (
          <View
            className="flex-row items-center gap-2 rounded-lg px-3 py-2"
            style={{ backgroundColor: colors.subtle }}
          >
            <Text className="min-w-0 flex-1 text-xs text-black dark:text-white">
              {t("skills:marketLoadFailed")}
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => scheduler.select(category)}
              hitSlop={8}
            >
              <Text
                className="text-xs font-medium"
                style={{ color: colors.primary }}
              >
                {t("skills:retry")}
              </Text>
            </Pressable>
          </View>
        ) : null}
        {loading && items.length === 0 ? (
          <View className="items-center py-4">
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : items.length === 0 ? (
          <Text className="py-4 text-center text-xs text-label2 dark:text-[#EBEBF599]">
            {t("skills:marketEmpty")}
          </Text>
        ) : (
          <FlatList
            data={sortedItems}
            keyExtractor={(item) => item.slug}
            scrollEnabled={false}
            renderItem={renderRow}
            ListFooterComponent={
              canLoadMore ? (
                <Pressable
                  onPress={() =>
                    void useSkillsStore
                      .getState()
                      .searchMarket(
                        { keyword, category: category ?? undefined },
                        false,
                      )
                  }
                  disabled={loadingMore}
                  className="items-center py-2"
                >
                  {loadingMore ? (
                    <ActivityIndicator size="small" color={colors.primary} />
                  ) : (
                    <Text
                      className="text-xs font-medium"
                      style={{ color: colors.primary }}
                    >
                      {t("skills:loadMore")}
                    </Text>
                  )}
                </Pressable>
              ) : null
            }
          />
        )}
      </View>
    </View>
  );
}

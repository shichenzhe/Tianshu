import { useEffect, useMemo } from "react";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useTranslation } from "react-i18next";
import { FlatList, Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { AutomationRunStatus } from "@tianshu/protocol";

import { relativeTimeLabel } from "@/lib/relative-time-label";
import { durationLabel, formatRelative } from "@/logic/time";
import { runStatusColor } from "@/logic/run-node";
import { useOrchestrationStore } from "@/store/orchestration.store";
import { useThemeColors } from "@/store/theme";

const FILTERS: Array<{ value: AutomationRunStatus | null; key: string }> = [
  { value: null, key: "filterAll" },
  { value: "running", key: "statusRunning" },
  { value: "success", key: "statusSuccess" },
  { value: "failed", key: "statusFailed" },
  { value: "skipped", key: "statusSkipped" },
];

/**
 * 运行历史页（CRUD 批）：automation/runPage 分页列表。状态筛选/任务预筛
 * （?taskId=，任务长按「运行历史」入口带入）服务端下推；automation.changed
 * 收尾事件自动重拉（orchestration.store）；行点击进执行详情页
 * /automation/history/[id]（执行详情批，全状态可进）。
 */
export default function AutomationHistoryScreen() {
  const { t } = useTranslation(["orchestration", "common"]);
  const colors = useThemeColors();
  const params = useLocalSearchParams<{ taskId?: string }>();
  const routeTaskId =
    params.taskId != null && params.taskId !== ""
      ? Number(params.taskId)
      : null;

  const runs = useOrchestrationStore((s) => s.historyRuns);
  const total = useOrchestrationStore((s) => s.historyTotal);
  const loading = useOrchestrationStore((s) => s.historyLoading);
  const filter = useOrchestrationStore((s) => s.historyFilter);
  const taskId = useOrchestrationStore((s) => s.historyTaskId);
  const loadHistory = useOrchestrationStore((s) => s.loadHistory);
  const loadMoreHistory = useOrchestrationStore((s) => s.loadMoreHistory);
  const setHistoryFilter = useOrchestrationStore((s) => s.setHistoryFilter);
  const setHistoryTaskId = useOrchestrationStore((s) => s.setHistoryTaskId);

  // 进页：路由预筛落 store（重拉一次）+ 首屏拉取
  useEffect(() => {
    setHistoryTaskId(routeTaskId);
    void loadHistory();
  }, [routeTaskId, setHistoryTaskId, loadHistory]);

  const rows = useMemo(() => runs, [runs]);

  function statusColor(status: AutomationRunStatus): string {
    const color = runStatusColor(status);
    return color === "__primary__" ? colors.primary : color;
  }

  return (
    <SafeAreaView
      className="flex-1 bg-grouped dark:bg-black"
      edges={["bottom"]}
    >
      <Stack.Screen options={{ title: t("orchestration:history") }} />

      {/* 状态筛选 chips（服务端下推；切即重拉） */}
      <View className="px-4 pb-1 pt-2">
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0, flexShrink: 0 }}
          contentContainerStyle={{ alignItems: "center", gap: 8 }}
        >
          {FILTERS.map(({ value, key }) => {
            const active = filter === value;
            return (
              <Pressable
                key={key}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => setHistoryFilter(value)}
                className="rounded-full border border-sep px-3 py-1.5 dark:border-[#545458A6]"
                style={{
                  backgroundColor: active ? colors.subtle : "transparent",
                }}
              >
                <Text
                  className={`text-xs ${active ? "font-medium" : ""}`}
                  style={{ color: active ? colors.primary : "#8E8E93" }}
                >
                  {t(`orchestration:${key}`)}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      <FlatList
        data={rows}
        keyExtractor={(run) => String(run.id)}
        onEndReached={() => void loadMoreHistory()}
        onEndReachedThreshold={0.3}
        onRefresh={() => void loadHistory()}
        refreshing={loading}
        contentContainerStyle={{
          flexGrow: rows.length === 0 ? 1 : 0,
          margin: 16,
          overflow: "hidden",
          borderRadius: 16,
        }}
        ListEmptyComponent={
          <View className="flex-1 items-center justify-center gap-1 px-4">
            <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
              {t("orchestration:historyEmpty")}
            </Text>
            <Text className="text-xs text-label3 dark:text-[#EBEBF54D]">
              {t("orchestration:historyEmptyTip")}
            </Text>
          </View>
        }
        renderItem={({ item, index }) => (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push(`/automation/history/${item.id}`)}
            className={`bg-card px-4 py-3 dark:bg-[#1C1C1E] ${
              index === rows.length - 1
                ? ""
                : "border-b border-sep dark:border-[#545458A6]"
            }`}
            style={({ pressed }) =>
              pressed ? { backgroundColor: colors.subtle } : undefined
            }
          >
            <View className="flex-row items-center gap-2">
              <View
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: statusColor(item.status) }}
              />
              <Text
                numberOfLines={1}
                className="flex-1 text-[15px] text-black dark:text-white"
              >
                {item.taskName}
              </Text>
              <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
                {relativeTimeLabel(formatRelative(item.startedAt), t)}
              </Text>
            </View>
            <View className="mt-1 flex-row items-center gap-3">
              <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
                {t(`orchestration:trigger_${item.triggerType}`)}
              </Text>
              {item.durationMs != null && (
                <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
                  {durationLabel(item.durationMs)}
                </Text>
              )}
              {(item.promptTokens != null || item.completionTokens != null) && (
                <Text className="text-xs text-label3 dark:text-[#EBEBF54D]">
                  {t("orchestration:tokensShort", {
                    prompt: item.promptTokens ?? 0,
                    completion: item.completionTokens ?? 0,
                  })}
                </Text>
              )}
              {item.status === "running" && (
                <Text
                  className="text-xs font-medium"
                  style={{ color: colors.primary }}
                >
                  {t("orchestration:statusRunning")}
                </Text>
              )}
            </View>
          </Pressable>
        )}
      />
    </SafeAreaView>
  );
}

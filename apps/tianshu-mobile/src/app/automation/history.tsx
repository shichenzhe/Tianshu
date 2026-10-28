import { useEffect, useMemo, useState } from "react";
import { Stack, useLocalSearchParams } from "expo-router";
import { useTranslation } from "react-i18next";
import { FlatList, Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type {
  AutomationRunRecord,
  AutomationRunStatus,
} from "@tianshu/protocol";

import { DetailSheet } from "@/components/DetailSheet";
import { relativeTimeLabel } from "@/lib/relative-time-label";
import { formatRelative } from "@/logic/time";
import { useOrchestrationStore } from "@/store/orchestration.store";
import { useThemeColors } from "@/store/theme";

/** 运行状态 → 展示色（红=失败/绿=成功/主题=运行中/灰=跳过） */
const STATUS_COLOR: Record<AutomationRunStatus, string> = {
  running: "__primary__",
  success: "#34C759",
  failed: "#FF3B30",
  skipped: "#8E8E93",
};

const FILTERS: Array<{ value: AutomationRunStatus | null; key: string }> = [
  { value: null, key: "filterAll" },
  { value: "running", key: "statusRunning" },
  { value: "success", key: "statusSuccess" },
  { value: "failed", key: "statusFailed" },
  { value: "skipped", key: "statusSkipped" },
];

/** 耗时格式化：<60s 秒一位小数、否则分钟整数；运行中/无值空串 */
function durationLabel(ms: number | undefined): string {
  if (ms == null) return "";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

/**
 * 运行历史页（CRUD 批）：automation/runPage 分页列表。状态筛选/任务预筛
 * （?taskId=，任务长按「运行历史」入口带入）服务端下推；automation.changed
 * 收尾事件自动重拉（orchestration.store）；失败行点开错误详情 DetailSheet。
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
  const [detail, setDetail] = useState<AutomationRunRecord | null>(null);

  // 进页：路由预筛落 store（重拉一次）+ 首屏拉取
  useEffect(() => {
    setHistoryTaskId(routeTaskId);
    void loadHistory();
  }, [routeTaskId, setHistoryTaskId, loadHistory]);

  const rows = useMemo(() => runs, [runs]);

  function statusColor(status: AutomationRunStatus): string {
    return status === "running" ? colors.primary : STATUS_COLOR[status];
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
            disabled={!item.error}
            onPress={() => setDetail(item)}
            className={`bg-card px-4 py-3 dark:bg-[#1C1C1E] ${
              index === rows.length - 1
                ? ""
                : "border-b border-sep dark:border-[#545458A6]"
            }`}
            style={({ pressed }) =>
              pressed && item.error
                ? { backgroundColor: colors.subtle }
                : undefined
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

      <DetailSheet
        visible={detail !== null}
        title={detail?.taskName ?? ""}
        onClose={() => setDetail(null)}
      >
        <Text className="px-1 pb-2 text-xs text-label2 dark:text-[#EBEBF599]">
          {detail
            ? `${t(`orchestration:trigger_${detail.triggerType}`)} · ${relativeTimeLabel(formatRelative(detail.startedAt), t)}`
            : ""}
        </Text>
        <Text className="rounded-lg bg-field px-3 py-2.5 text-sm text-black dark:bg-[#2C2C2E] dark:text-white">
          {detail?.error ?? ""}
        </Text>
      </DetailSheet>
    </SafeAreaView>
  );
}

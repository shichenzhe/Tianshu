import { useEffect, type ReactNode } from "react";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { MonitorStats } from "@tianshu/protocol";

import { trendBarHeights } from "@/logic/monitor-trend";
import { PageHeader } from "@/components/PageHeader";
import { useConnectionsStore } from "@/store/connections.store";
import {
  useMonitorStore,
  type MonitorSceneFilter,
} from "@/store/monitor.store";
import { useThemeColors } from "@/store/theme";

const SCENES: MonitorSceneFilter[] = ["all", "chat", "graph", "automation"];
const SCENE_LABELS: Record<MonitorSceneFilter, string> = {
  all: "sceneAll",
  chat: "sceneChat",
  graph: "sceneGraph",
  automation: "sceneAutomation",
};
const TREND_HEIGHT = 72;

function formatCount(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact" }).format(
    value,
  );
}

function formatDuration(value: number | null): string {
  if (value === null) return "-";
  return value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(1)}s`;
}

function SectionCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <View className="gap-3 rounded-2xl border border-sep bg-card px-4 py-3 dark:border-[#545458A6] dark:bg-[#1C1C1E]">
      <Text className="text-[13px] font-medium text-label2 dark:text-[#EBEBF599]">
        {title}
      </Text>
      {children}
    </View>
  );
}

function SceneSegments({
  scene,
  onSelect,
}: {
  scene: MonitorSceneFilter;
  onSelect: (scene: MonitorSceneFilter) => void;
}) {
  const { t } = useTranslation("monitor");
  const colors = useThemeColors();
  return (
    <View className="flex-row rounded-lg border border-sep p-0.5 dark:border-[#545458A6]">
      {SCENES.map((key) => {
        const active = scene === key;
        return (
          <Pressable
            key={key}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => onSelect(key)}
            className="flex-1 items-center rounded-md py-2"
            style={{ backgroundColor: active ? colors.primary : "transparent" }}
          >
            <Text
              className={`text-xs ${active ? "font-medium text-white" : "text-label2 dark:text-[#EBEBF599]"}`}
            >
              {t(SCENE_LABELS[key])}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-1 gap-1 rounded-xl bg-field px-3 py-3 dark:bg-black/30">
      <Text className="text-xs text-label2 dark:text-[#EBEBF599]">{label}</Text>
      <Text className="text-2xl font-semibold text-black dark:text-white">
        {value}
      </Text>
    </View>
  );
}

function TodaySection({ stats }: { stats: MonitorStats }) {
  const { t } = useTranslation("monitor");
  const { today } = stats;
  const successRate = `${Math.round(today.toolSuccessRate * 100)}%`;
  const cards = [
    { label: t("inputTokens"), value: formatCount(today.inputTokens) },
    { label: t("outputTokens"), value: formatCount(today.outputTokens) },
    { label: t("llmCalls"), value: formatCount(today.llmCalls) },
    {
      label: `${t("toolCalls")} · ${t("successRate")} ${successRate}`,
      value: formatCount(today.toolCalls),
    },
  ];
  return (
    <SectionCard title={t("todayTitle")}>
      <View className="gap-2">
        {[0, 2].map((start) => (
          <View key={start} className="flex-row gap-2">
            {cards.slice(start, start + 2).map((card) => (
              <KpiCard key={card.label} {...card} />
            ))}
          </View>
        ))}
      </View>
    </SectionCard>
  );
}

function TrendLegend() {
  const { t } = useTranslation("monitor");
  const colors = useThemeColors();
  return (
    <View className="flex-row gap-4">
      {(["trendInput", "trendOutput"] as const).map((key, index) => (
        <View key={key} className="flex-row items-center gap-1.5">
          <View
            className={`h-2.5 w-2.5 rounded-sm ${index === 1 ? "opacity-40" : ""}`}
            style={{ backgroundColor: colors.primary }}
          />
          <Text className="text-[11px] text-label2 dark:text-[#EBEBF599]">
            {t(key)}
          </Text>
        </View>
      ))}
    </View>
  );
}

function TrendSection({ stats }: { stats: MonitorStats }) {
  const { t } = useTranslation("monitor");
  const colors = useThemeColors();
  const heights = trendBarHeights(stats.trend, TREND_HEIGHT);
  return (
    <SectionCard title={t("trendTitle")}>
      <TrendLegend />
      {stats.trend.length === 0 ? (
        <Text className="py-4 text-center text-xs text-label2 dark:text-[#EBEBF599]">
          {t("empty")}
        </Text>
      ) : (
        <View className="flex-row items-end">
          {stats.trend.map((day, index) => (
            <View key={day.date} className="flex-1 items-center gap-1.5">
              <View
                className="flex-row items-end justify-center gap-1"
                style={{ height: TREND_HEIGHT }}
              >
                <View
                  className="w-2 rounded-sm"
                  style={{
                    height: heights[index].input,
                    backgroundColor: colors.primary,
                  }}
                />
                <View
                  className="w-2 rounded-sm opacity-40"
                  style={{
                    height: heights[index].output,
                    backgroundColor: colors.primary,
                  }}
                />
              </View>
              <Text className="text-[10px] text-label3 dark:text-[#EBEBF54D]">
                {day.date.slice(5)}
              </Text>
            </View>
          ))}
        </View>
      )}
    </SectionCard>
  );
}

function ModelSection({ stats }: { stats: MonitorStats }) {
  const { t } = useTranslation("monitor");
  const rows = stats.byModel.slice(0, 10);
  return (
    <SectionCard title={t("byModelTitle")}>
      {rows.length === 0 ? (
        <Text className="py-2 text-center text-xs text-label2 dark:text-[#EBEBF599]">
          {t("empty")}
        </Text>
      ) : (
        <View>
          {rows.map((model, index) => (
            <View
              key={model.modelId}
              className={`py-2 ${index > 0 ? "border-t border-sep dark:border-[#545458A6]" : ""}`}
            >
              <View className="flex-row items-center gap-2">
                <Text
                  numberOfLines={1}
                  className="min-w-0 flex-1 text-sm text-black dark:text-white"
                >
                  {model.name}
                </Text>
                <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
                  {t("callsLabel", { count: model.calls })}
                </Text>
              </View>
              <Text className="mt-1 text-[11px] text-label3 dark:text-[#EBEBF54D]">
                ↑{formatCount(model.inputTokens)} ↓
                {formatCount(model.outputTokens)}
              </Text>
            </View>
          ))}
        </View>
      )}
    </SectionCard>
  );
}

function ToolsSection({ stats }: { stats: MonitorStats }) {
  const { t } = useTranslation("monitor");
  const rows = stats.tools.slice(0, 10);
  return (
    <SectionCard title={t("toolsTitle")}>
      {rows.length === 0 ? (
        <Text className="py-2 text-center text-xs text-label2 dark:text-[#EBEBF599]">
          {t("empty")}
        </Text>
      ) : (
        <View>
          {rows.map((tool, index) => (
            <View
              key={tool.toolName}
              className={`py-2 ${index > 0 ? "border-t border-sep dark:border-[#545458A6]" : ""}`}
            >
              <View className="flex-row items-center gap-2">
                <Text
                  numberOfLines={1}
                  className="min-w-0 flex-1 text-sm text-black dark:text-white"
                >
                  {tool.toolName}
                </Text>
                <Text className="text-xs font-medium text-black dark:text-white">
                  {Math.round(tool.successRate * 100)}%
                </Text>
              </View>
              <Text className="mt-1 text-[11px] leading-4 text-label3 dark:text-[#EBEBF54D]">
                {t("avgDuration", {
                  value: formatDuration(tool.avgDurationMs),
                })}
                {" · "}
                {t("total", { count: tool.total })}
                {" · "}
                {t("denied", { count: tool.denied })}
                {" · "}
                {t("error", { count: tool.error })}
              </Text>
            </View>
          ))}
        </View>
      )}
    </SectionCard>
  );
}

function MonitorContent({ stats }: { stats: MonitorStats }) {
  return (
    <View className="gap-4">
      <TodaySection stats={stats} />
      <TrendSection stats={stats} />
      <ModelSection stats={stats} />
      <ToolsSection stats={stats} />
    </View>
  );
}

export default function MonitorScreen() {
  const { t } = useTranslation(["monitor", "chat", "common"]);
  const router = useRouter();
  const colors = useThemeColors();
  const activeConnId = useConnectionsStore((s) => s.activeConnId);
  const scene = useMonitorStore((s) => s.scene);
  const stats = useMonitorStore((s) => s.stats);
  const loading = useMonitorStore((s) => s.loading);
  const error = useMonitorStore((s) => s.error);
  const load = useMonitorStore((s) => s.load);

  useEffect(() => {
    if (activeConnId) void load("all");
  }, [activeConnId, load]);

  return (
    <SafeAreaView
      className="flex-1 bg-grouped dark:bg-black"
      edges={["top", "bottom"]}
    >
      <PageHeader title={t("title")} backLabel={t("monitor:back")} />
      {!activeConnId ? (
        <View className="flex-1 items-center justify-center gap-3 px-6">
          <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
            {t("chat:noConnection")}
          </Text>
          <Pressable
            onPress={() => router.push("/connections")}
            className="rounded-lg px-4 py-2"
            style={{ backgroundColor: colors.primary }}
          >
            <Text className="text-sm text-white">
              {t("common:nav.toConnections")}
            </Text>
          </Pressable>
        </View>
      ) : loading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      ) : error ? (
        <View className="flex-1 items-center justify-center gap-3 px-6">
          <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
            {t("loadFailed")}
          </Text>
          <Pressable
            onPress={() => void load()}
            className="rounded-lg px-4 py-2"
            style={{ backgroundColor: colors.primary }}
          >
            <Text className="text-sm text-white">{t("chat:retry")}</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView
          className="flex-1"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 16 }}
        >
          <SceneSegments scene={scene} onSelect={(next) => void load(next)} />
          {stats ? (
            <MonitorContent stats={stats} />
          ) : (
            <View className="items-center py-20">
              <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
                {t("empty")}
              </Text>
            </View>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

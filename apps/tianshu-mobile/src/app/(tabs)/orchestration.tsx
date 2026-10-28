import { useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { FlatList, Pressable, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { History, MessageSquarePlus } from "lucide-react-native";
import type { GraphRecord, TaskRecord } from "@tianshu/protocol";

import { AutomationCard } from "@/components/AutomationCard";
import { GraphCard } from "@/components/GraphCard";
import {
  useConnectionCapabilities,
  useConnectionsStore,
} from "@/store/connections.store";
import { useOrchestrationStore } from "@/store/orchestration.store";
import { useThemeColors } from "@/store/theme";

type Tab = "graphs" | "tasks";

const TABS: Array<{ key: Tab; labelKey: string }> = [
  { key: "graphs", labelKey: "orchestration:tabGraphs" },
  { key: "tasks", labelKey: "orchestration:tabAutomations" },
];

/**
 * 自动化/编排页（M2c + CRUD 批）：graph/automation 双段遥控列表。列表/
 * 事件/乐观态全在 orchestration.store（server.connected 双拉、
 * graph.run.updated 投影、automation.changed 重拉）；门禁 = graph ||
 * automation（CRUD 批：桌面被控端报 automation 不报 graph——Graphs 段
 * 仅 graph 能力显示，Automations 段双能力皆可；能力协商语义：未知不视为
 * 具备，server.connected 到达后自愈）。
 */
export default function OrchestrationScreen() {
  const { t } = useTranslation(["orchestration", "chat", "common"]);
  const colors = useThemeColors();
  const router = useRouter();

  const activeConnId = useConnectionsStore((s) => s.activeConnId);
  const capabilities = useConnectionCapabilities(activeConnId);
  const hasGraph = capabilities?.includes("graph") ?? false;

  const graphs = useOrchestrationStore((s) => s.graphs);
  const graphsLoading = useOrchestrationStore((s) => s.graphsLoading);
  const loadGraphs = useOrchestrationStore((s) => s.loadGraphs);
  const loadMoreGraphs = useOrchestrationStore((s) => s.loadMoreGraphs);
  const tasks = useOrchestrationStore((s) => s.tasks);
  const tasksLoading = useOrchestrationStore((s) => s.tasksLoading);
  const loadTasks = useOrchestrationStore((s) => s.loadTasks);
  const loadMoreTasks = useOrchestrationStore((s) => s.loadMoreTasks);

  // Graphs 段按能力显隐（连桌面端只显示 Automations 段）；缺省落 tasks
  const tabs = hasGraph ? TABS : TABS.filter(({ key }) => key !== "graphs");
  const [tab, setTab] = useState<Tab>("graphs");
  const activeTab: Tab = tab === "graphs" && !hasGraph ? "tasks" : tab;

  // 进页即拉（事件驱动的重拉覆盖后续刷新；无连接时静默空表；Graphs 段
  // 不可见时 graph/query 不再请求——桌面被控端只报 automation）
  useEffect(() => {
    if (hasGraph) void loadGraphs();
    void loadTasks();
  }, [loadGraphs, loadTasks, hasGraph]);

  // 空态/门禁判定顺序（Fix Round 1）：无活动连接先走连接空态（此前 capability
  // 门禁先判会把断连/未连误导成「不支持编排」，noConnection 分支不可达）；
  // 有连接但能力面不含 graph（未知不视为具备，server.connected 后自愈）
  if (!activeConnId) {
    return (
      <SafeAreaView style={{ flex: 1 }} edges={["bottom"]}>
        <View className="flex-1 items-center justify-center gap-3 bg-white px-4 dark:bg-black">
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
      </SafeAreaView>
    );
  }
  if (!(hasGraph || capabilities?.includes("automation"))) {
    return (
      <SafeAreaView style={{ flex: 1 }} edges={["bottom"]}>
        <View className="flex-1 items-center justify-center bg-white px-6 dark:bg-black">
          <Text className="text-center text-sm text-label2 dark:text-[#EBEBF599]">
            {t("orchestration:unsupported")}
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  function renderEmpty() {
    const empty =
      activeTab === "graphs"
        ? t("orchestration:emptyGraphs")
        : t("orchestration:emptyTasks");
    const tip =
      activeTab === "graphs"
        ? t("orchestration:emptyGraphsTip")
        : t("orchestration:emptyTasksTip");
    return (
      <View className="flex-1 items-center justify-center gap-1 px-4">
        <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
          {empty}
        </Text>
        <Text className="text-xs text-label3 dark:text-[#EBEBF54D]">{tip}</Text>
      </View>
    );
  }

  const items = (activeTab === "graphs" ? graphs : tasks) as Array<
    GraphRecord | TaskRecord
  >;

  function openTaskCreate() {
    if (hasGraph && graphs.length === 0 && !graphsLoading) void loadGraphs();
    router.push("/automation/new");
  }

  const automationHeader = (
    <View className="flex-row items-center justify-end px-1 pb-2 pt-1">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("orchestration:history")}
        onPress={() => router.push("/automation/history")}
        hitSlop={8}
        className="rounded-full p-1"
        style={({ pressed }) => ({
          backgroundColor: pressed ? colors.subtle : "transparent",
        })}
      >
        <History size={17} color={colors.primary} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("orchestration:newTask")}
        onPress={openTaskCreate}
        hitSlop={8}
        className="rounded-full p-1"
        style={({ pressed }) => ({
          backgroundColor: pressed ? colors.subtle : "transparent",
        })}
      >
        <MessageSquarePlus size={17} color={colors.primary} />
      </Pressable>
    </View>
  );

  return (
    <SafeAreaView style={{ flex: 1 }} edges={["bottom"]}>
      <View className="flex-1 bg-grouped dark:bg-black">
        {/* 两段切换（Graphs / Automations；Graphs 段按 graph 能力显隐） */}
        <View className="mx-4 mt-2 flex-row rounded-lg border border-sep p-0.5 dark:border-[#545458A6]">
          {tabs.map(({ key, labelKey }) => {
            const active = activeTab === key;
            return (
              <Pressable
                key={key}
                onPress={() => setTab(key)}
                className="flex-1 items-center rounded-md py-1.5"
                style={{
                  backgroundColor: active ? colors.primary : "transparent",
                }}
              >
                <Text
                  className="text-sm"
                  style={{
                    color: active ? "#fff" : "#8E8E93",
                    fontWeight: active ? "500" : "400",
                  }}
                >
                  {t(labelKey)}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <FlatList
          data={items}
          keyExtractor={(item) => String(item.id)}
          // data 为按 tab 二选一的数组：联合元素经 tab 分支收窄（构造上安全）
          renderItem={({ item, index }) =>
            activeTab === "graphs" ? (
              <GraphCard
                graph={item as GraphRecord}
                isLast={index === items.length - 1}
              />
            ) : (
              <AutomationCard
                task={item as TaskRecord}
                isLast={index === items.length - 1}
              />
            )
          }
          onEndReached={() =>
            void (activeTab === "graphs" ? loadMoreGraphs() : loadMoreTasks())
          }
          onEndReachedThreshold={0.3}
          onRefresh={() =>
            void (activeTab === "graphs" ? loadGraphs() : loadTasks())
          }
          refreshing={activeTab === "graphs" ? graphsLoading : tasksLoading}
          contentContainerStyle={{
            flexGrow: items.length === 0 ? 1 : 0,
            margin: 16,
            overflow: "hidden",
            borderRadius: 16,
          }}
          ListEmptyComponent={renderEmpty}
          ListHeaderComponent={activeTab === "tasks" ? automationHeader : null}
        />
      </View>
    </SafeAreaView>
  );
}

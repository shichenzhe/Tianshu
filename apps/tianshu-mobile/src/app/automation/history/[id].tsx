import { useEffect, useMemo, useState } from "react";
import { Stack, useLocalSearchParams } from "expo-router";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Platform } from "react-native";
import type {
  AutomationRunNodeRecord,
  AutomationRunStatus,
} from "@tianshu/protocol";

import { relativeTimeLabel } from "@/lib/relative-time-label";
import {
  durationLabel,
  formatAbsolute,
  formatRelative,
} from "@/logic/time";
import {
  parseNodeError,
  parseNodeFallback,
  parseNodeToolCalls,
  runStatusColor,
} from "@/logic/run-node";
import { useOrchestrationStore } from "@/store/orchestration.store";
import { useThemeColors } from "@/store/theme";

/** mono 深底文本块（GraphCard DetailSheet 同款语义色系） */
function MonoBlock({
  value,
  tone,
}: {
  value: string;
  tone?: "error";
}) {
  return (
    <Text
      className="rounded-lg px-3 py-2 text-xs leading-4"
      style={{
        fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
        backgroundColor: "#1e293b",
        color: tone === "error" ? "#fca5a5" : "#e2e8f0",
      }}
    >
      {value}
    </Text>
  );
}

/** 小节标签（输入/输出/错误等） */
function SectionLabel({ label }: { label: string }) {
  return (
    <Text className="pb-1 pt-2 text-xs font-medium text-label2 dark:text-[#EBEBF599]">
      {label}
    </Text>
  );
}

/** 元信息行（label: value 灰字两列） */
function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-start gap-3">
      <Text className="w-16 shrink-0 text-xs text-label3 dark:text-[#EBEBF54D]">
        {label}
      </Text>
      <Text className="flex-1 text-xs text-black dark:text-white">{value}</Text>
    </View>
  );
}

/** 节点行展开详情（桌面 GraphRunTraceView TraceDetail 的 RN 版） */
function NodeDetail({ node }: { node: AutomationRunNodeRecord }) {
  const { t } = useTranslation("orchestration");
  const err = parseNodeError(node.errorJson);
  const fallback = parseNodeFallback(node.fallbackJson);
  const toolCalls = parseNodeToolCalls(node.toolCallsJson);
  return (
    <View className="border-b border-sep pb-3 dark:border-[#545458A6]">
      <MetaRow
        label={t("startedAt")}
        value={formatAbsolute(node.startedAt)}
      />
      {node.input != null && (
        <>
          <SectionLabel label={t("nodeInput")} />
          <MonoBlock value={node.input} />
        </>
      )}
      {node.output != null && (
        <>
          <SectionLabel label={t("nodeOutput")} />
          <MonoBlock value={node.output} tone={node.status === "failed" ? "error" : undefined} />
        </>
      )}
      {err != null && (
        <>
          <SectionLabel label={t("nodeError")} />
          <View className="gap-1">
            {err.code != null && <MetaRow label="code" value={err.code} />}
            {err.toolName != null && (
              <MetaRow label="tool" value={err.toolName} />
            )}
            {err.message != null && (
              <MetaRow label="message" value={err.message} />
            )}
            {err.detail != null && (
              <MonoBlock value={err.detail} tone="error" />
            )}
          </View>
        </>
      )}
      {toolCalls.length > 0 && (
        <>
          <SectionLabel label={t("toolCalls")} />
          <View className="gap-1">
            {toolCalls.map((call, i) => (
              <View key={`${call.name}-${i}`} className="flex-row gap-2">
                <Text
                  className="text-xs"
                  style={{ color: call.ok ? "#34C759" : "#FF3B30" }}
                >
                  {call.ok ? "✓" : "✗"}
                </Text>
                <Text className="flex-1 text-xs text-black dark:text-white">
                  {call.name}
                </Text>
                <Text className="text-xs text-label3 dark:text-[#EBEBF54D]">
                  {durationLabel(call.durationMs) || "-"}
                </Text>
              </View>
            ))}
          </View>
        </>
      )}
      {node.errorOutput != null && (
        <>
          <SectionLabel label={t("errorOutputLabel")} />
          <MonoBlock value={node.errorOutput} tone="error" />
        </>
      )}
      {fallback != null && (
        <Text className="pt-2 text-xs text-label2 dark:text-[#EBEBF599]">
          {t("fallbackLabel")}
          {fallback.message != null ? `：${fallback.message}` : ""}
        </Text>
      )}
    </View>
  );
}

/**
 * 运行详情页（执行详情批）：run 级信息面板 + 图运行节点时间线
 * （automation/runNodes 透传全文输入/输出/工具调用/失败全貌；桌面
 * GraphRunTraceView 同构信息面）。running 态经 graph.run.updated 事件
 * 自动重拉节点（orchestration.store）；prompt 任务 run 无节点段
 * （桌面跳会话的移动端等价物——去会话化后 sessionId 恒 null）。
 */
export default function AutomationRunDetailScreen() {
  const { t } = useTranslation(["orchestration", "common"]);
  const colors = useThemeColors();
  const params = useLocalSearchParams<{ id: string }>();
  const runId = Number(params.id);

  const runs = useOrchestrationStore((s) => s.historyRuns);
  const nodesMap = useOrchestrationStore((s) => s.runNodes);
  const loadingMap = useOrchestrationStore((s) => s.runNodesLoading);
  const loadRunNodes = useOrchestrationStore((s) => s.loadRunNodes);

  const run = useMemo(
    () => runs.find((r) => r.id === runId),
    [runs, runId],
  );
  const nodes = runId != null && !Number.isNaN(runId) ? nodesMap[runId] : undefined;
  const nodesLoading = runId != null && !Number.isNaN(runId) ? loadingMap[runId] : false;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // 进页拉节点（图 run 才有节点段；重进/事件重拉共用同一 fetch）
  const isGraphRun = run?.graphId != null;
  useEffect(() => {
    if (isGraphRun) void loadRunNodes(runId);
  }, [isGraphRun, runId, loadRunNodes]);

  if (run == null) {
    return (
      <SafeAreaView className="flex-1 bg-grouped dark:bg-black" edges={["bottom"]}>
        <Stack.Screen options={{ title: t("orchestration:runDetail") }} />
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
            {t("orchestration:runNotFound")}
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  function statusColor(status: AutomationRunStatus): string {
    const color = runStatusColor(status);
    return color === "__primary__" ? colors.primary : color;
  }

  const statusKey =
    run.status === "success"
      ? "statusSuccess"
      : run.status === "failed"
        ? "statusFailed"
        : run.status === "skipped"
          ? "statusSkipped"
          : "statusRunning";

  return (
    <SafeAreaView className="flex-1 bg-grouped dark:bg-black" edges={["bottom"]}>
      <Stack.Screen options={{ title: t("orchestration:runDetail") }} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {/* run 级面板 */}
        <View className="gap-2 rounded-2xl bg-card px-4 py-3 dark:bg-[#1C1C1E]">
          <View className="flex-row items-center gap-2">
            <View
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: statusColor(run.status) }}
            />
            <Text
              className="text-xs font-medium"
              style={{ color: statusColor(run.status) }}
            >
              {t(`orchestration:${statusKey}`)}
            </Text>
            {run.attempt > 1 && (
              <Text className="text-xs text-label3 dark:text-[#EBEBF54D]">
                {t("orchestration:attemptN", { n: run.attempt })}
              </Text>
            )}
          </View>
          <Text className="text-[15px] font-medium text-black dark:text-white">
            {run.taskName}
          </Text>
          <View className="gap-1 pt-1">
            <MetaRow
              label={t("orchestration:triggerLabel")}
              value={t(`orchestration:trigger_${run.triggerType}`)}
            />
            <MetaRow
              label={t("orchestration:startedAt")}
              value={`${formatAbsolute(run.startedAt)} · ${relativeTimeLabel(formatRelative(run.startedAt), t)}`}
            />
            {run.finishedAt != null && (
              <MetaRow
                label={t("orchestration:finishedAt")}
                value={formatAbsolute(run.finishedAt)}
              />
            )}
            {run.durationMs != null && (
              <MetaRow
                label={t("orchestration:durationLabel")}
                value={durationLabel(run.durationMs)}
              />
            )}
            {(run.promptTokens != null || run.completionTokens != null) && (
              <MetaRow
                label={t("orchestration:tokensLabel")}
                value={t("orchestration:tokensShort", {
                  prompt: run.promptTokens ?? 0,
                  completion: run.completionTokens ?? 0,
                })}
              />
            )}
          </View>
          {run.error != null && (
            <>
              <SectionLabel label={t("orchestration:runError")} />
              <MonoBlock value={run.error} tone="error" />
            </>
          )}
        </View>

        {/* 节点时间线（图 run 专有） */}
        {isGraphRun && (
          <View className="gap-2 rounded-2xl bg-card px-4 py-3 dark:bg-[#1C1C1E]">
            <View className="flex-row items-center gap-2">
              <Text className="flex-1 text-xs font-medium text-label2 dark:text-[#EBEBF599]">
                {t("orchestration:nodeSection")}
              </Text>
              {nodesLoading && <ActivityIndicator size="small" />}
            </View>
            {nodes != null && nodes.length === 0 && !nodesLoading && (
              <Text className="py-2 text-xs text-label3 dark:text-[#EBEBF54D]">
                {t("orchestration:noNodes")}
              </Text>
            )}
            {nodes?.map((node) => {
              const open = expanded[node.nodeId] === true;
              const nodeColor =
                node.status === "failed" ? "#FF3B30" : "#34C759";
              return (
                <View key={node.nodeId} className="gap-1">
                  <Pressable
                    accessibilityRole="button"
                    onPress={() =>
                      setExpanded((prev) => ({
                        ...prev,
                        [node.nodeId]: !open,
                      }))
                    }
                    className="flex-row items-center gap-2 py-2"
                    style={({ pressed }) =>
                      pressed ? { backgroundColor: colors.subtle } : undefined
                    }
                  >
                    <View
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: nodeColor }}
                    />
                    <Text className="flex-1 text-sm text-black dark:text-white">
                      {node.nodeName ?? node.nodeId}
                    </Text>
                    {(node.promptTokens != null ||
                      node.completionTokens != null) && (
                      <Text className="text-xs text-label3 dark:text-[#EBEBF54D]">
                        {t("orchestration:tokensShort", {
                          prompt: node.promptTokens ?? 0,
                          completion: node.completionTokens ?? 0,
                        })}
                      </Text>
                    )}
                    <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
                      {durationLabel(node.durationMs)}
                    </Text>
                    <Text className="text-xs text-label3 dark:text-[#EBEBF54D]">
                      {open ? "▾" : "▸"}
                    </Text>
                  </Pressable>
                  {open && <NodeDetail node={node} />}
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

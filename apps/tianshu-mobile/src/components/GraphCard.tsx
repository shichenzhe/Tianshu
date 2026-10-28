import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { Play, Square } from "lucide-react-native";
import type { GraphRecord, GraphRunStatus } from "@tianshu/protocol";

import { DetailSheet } from "@/components/DetailSheet";
import { toast } from "@/lib/toast-bus";
import {
  describeGraphError,
  useOrchestrationStore,
  type GraphRunEntry,
} from "@/store/orchestration.store";
import { useThemeColors } from "@/store/theme";

/** 五态徽标色（语义固定色，非主题强调色）：运行蓝/成功绿/失败红/中止橙/排队灰 */
const STATE_STYLE: Record<GraphRunStatus, { fg: string; bg: string }> = {
  queued: { fg: "#8E8E93", bg: "#8E8E9324" },
  running: { fg: "#2563eb", bg: "#3b82f622" },
  succeeded: { fg: "#16a34a", bg: "#22c55e22" },
  failed: { fg: "#FF3B30", bg: "#FF3B3022" },
  aborted: { fg: "#ea580c", bg: "#f9731622" },
};

/** 终态详情长度上限（Alert 弹窗可读性） */
const DETAIL_MAX = 800;

interface Props {
  graph: GraphRecord;
  isLast?: boolean;
}

/**
 * 编排图卡片（M2c）：name/description 截断 + nodeCount 徽标 + enabled 灰显；
 * 「运行」202 受理乐观转运行中，运行中换「中止」；run 状态徽标五态着色，
 * 终态（output/error）点击弹详情；长按弹删除确认（SessionRow 同款）。
 */
export function GraphCard({ graph, isLast = false }: Props) {
  const { t } = useTranslation(["orchestration"]);
  const colors = useThemeColors();
  const run = useOrchestrationStore((s) => s.runs[graph.id]);
  const runGraph = useOrchestrationStore((s) => s.runGraph);
  const abortRun = useOrchestrationStore((s) => s.abortRun);
  const deleteGraph = useOrchestrationStore((s) => s.deleteGraph);
  const [busy, setBusy] = useState(false);
  // 终态详情底部面板（Alert 替换批）：非空即展示，output/error 截断移入
  // 渲染层（DETAIL_MAX 同值）
  const [detail, setDetail] = useState<GraphRunEntry | null>(null);

  const inFlight = run?.state === "running" || run?.state === "queued";

  function openDetail(entry: GraphRunEntry) {
    const body = entry.error ?? entry.output;
    if (!body) return;
    setDetail(entry);
  }

  function confirmDelete() {
    Alert.alert(
      t("orchestration:delete"),
      t("orchestration:deleteGraphConfirm", { name: graph.name }),
      [
        { text: t("orchestration:cancel"), style: "cancel" },
        {
          text: t("orchestration:delete"),
          style: "destructive",
          onPress: () => {
            void deleteGraph(graph.id).then((r) => {
              if (!r.ok) {
                toast.error(describeGraphError(r.code, r.message, t));
              }
            });
          },
        },
      ],
      { cancelable: true },
    );
  }

  async function handleRun() {
    if (busy) return;
    setBusy(true);
    const r = await runGraph(graph.id);
    setBusy(false);
    if (!r.ok) {
      toast.error(describeGraphError(r.code, r.message, t));
    }
  }

  async function handleAbort() {
    if (busy) return;
    setBusy(true);
    const r = await abortRun(graph.id);
    setBusy(false);
    if (!r.ok) {
      toast.error(describeGraphError(r.code, r.message, t));
    }
  }

  return (
    <>
      <Pressable
        onLongPress={confirmDelete}
        className={`bg-card px-4 py-3 dark:bg-[#1C1C1E] ${
          isLast ? "" : "border-b border-sep dark:border-[#545458A6]"
        }`}
        style={({ pressed }) =>
          pressed ? { backgroundColor: colors.subtle } : undefined
        }
      >
        {/* enabled=false 整块信息灰显（图停用仅视觉弱化，动作仍可用） */}
        <View style={{ opacity: graph.enabled ? 1 : 0.55 }}>
          <View className="flex-row items-center gap-2">
            <Text
              numberOfLines={1}
              className="flex-1 text-base text-black dark:text-white"
            >
              {graph.name}
            </Text>
            {run && (
              <Pressable
                onPress={() => openDetail(run)}
                hitSlop={6}
                className="rounded px-2 py-0.5"
                style={{ backgroundColor: STATE_STYLE[run.state].bg }}
              >
                <Text
                  className="text-xs font-medium"
                  style={{ color: STATE_STYLE[run.state].fg }}
                >
                  {t(`orchestration:runState.${run.state}`)}
                </Text>
              </Pressable>
            )}
          </View>
          <View className="mt-1 flex-row items-center gap-2">
            <View
              className="rounded px-1.5 py-0.5"
              style={{ backgroundColor: colors.subtle }}
            >
              <Text className="text-xs" style={{ color: colors.primaryActive }}>
                {t("orchestration:nodes", { count: graph.nodeCount })}
              </Text>
            </View>
            {graph.description ? (
              <Text
                numberOfLines={1}
                className="flex-1 text-xs text-label2 dark:text-[#EBEBF599]"
              >
                {graph.description}
              </Text>
            ) : null}
          </View>
        </View>
        <View className="mt-2 flex-row justify-end">
          {inFlight ? (
            <Pressable
              onPress={() => void handleAbort()}
              disabled={busy}
              className="flex-row items-center gap-1 rounded-lg border border-sep px-3 py-1.5 dark:border-[#545458A6]"
              style={({ pressed }) => ({
                backgroundColor: pressed ? colors.subtle : "transparent",
                opacity: busy ? 0.6 : 1,
              })}
            >
              <Square size={13} color="#FF3B30" />
              <Text className="text-sm" style={{ color: "#FF3B30" }}>
                {t("orchestration:abort")}
              </Text>
            </Pressable>
          ) : (
            <Pressable
              onPress={() => void handleRun()}
              disabled={busy}
              className="flex-row items-center gap-1 rounded-lg px-3 py-1.5"
              style={{
                backgroundColor: colors.primary,
                opacity: busy ? 0.6 : 1,
              }}
            >
              <Play size={13} color="#fff" />
              <Text className="text-sm text-white">
                {t("orchestration:run")}
              </Text>
            </Pressable>
          )}
        </View>
      </Pressable>
      <DetailSheet
        visible={detail != null}
        title={
          detail != null
            ? `${t(`orchestration:runState.${detail.state}`)} #${detail.runId}`
            : ""
        }
        onClose={() => setDetail(null)}
      >
        {/* mono 深底展示 output/error（错误浅红同语义色系），超长截断 + 滚动 */}
        <ScrollView style={{ maxHeight: 360 }}>
          <Text
            className="rounded-lg px-3 py-2 text-xs leading-4"
            style={{
              fontFamily: Platform.select({
                ios: "Menlo",
                android: "monospace",
              }),
              backgroundColor: "#1e293b",
              color: detail?.error != null ? "#fca5a5" : "#e2e8f0",
            }}
          >
            {(() => {
              const body = detail?.error ?? detail?.output ?? "";
              return body.length > DETAIL_MAX
                ? `${body.slice(0, DETAIL_MAX)}…`
                : body;
            })()}
          </Text>
        </ScrollView>
      </DetailSheet>
    </>
  );
}

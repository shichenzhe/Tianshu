import { useState } from "react";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { Alert, Pressable, Switch, Text, View } from "react-native";
import { Play } from "lucide-react-native";
import type { TaskRecord } from "@tianshu/protocol";

import { toast } from "@/lib/toast-bus";
import { relativeTimeLabel } from "@/lib/relative-time-label";
import { formatRelative } from "@/logic/time";
import {
  describeGraphError,
  useOrchestrationStore,
} from "@/store/orchestration.store";
import { useThemeColors } from "@/store/theme";

interface Props {
  task: TaskRecord;
  isLast?: boolean;
}

/** targetKind 徽标色点：graph 橙点 / prompt 蓝点（执行体形态一目了然） */
const KIND_DOT_COLOR: Record<TaskRecord["targetKind"], string> = {
  graph: "#f97316",
  prompt: "#3b82f6",
};

/** 下次运行文案（wire 口径 ISO 字符串 → 本地相对时间；M2c 未来分支） */
function nextRunLabel(
  task: TaskRecord,
  t: (key: string, vars?: Record<string, unknown>) => string,
): string {
  if (!task.enabled) return t("orchestration:paused");
  if (!task.nextRunAt) return t("orchestration:nextRunNone");
  return t("orchestration:nextRun", {
    time: relativeTimeLabel(formatRelative(task.nextRunAt), t),
  });
}

/**
 * 自动化任务卡片（M2c）：name + targetKind 徽标点 + scheduleText +
 * nextRunAt 相对时间 + enabled 开关（save 全量翻转）+「立即运行」202 受理；
 * 长按弹删除确认（SessionRow 同款）。
 */
export function AutomationCard({ task, isLast = false }: Props) {
  const { t } = useTranslation(["orchestration", "chat"]);
  const colors = useThemeColors();
  const toggleTask = useOrchestrationStore((s) => s.toggleTask);
  const runNow = useOrchestrationStore((s) => s.runNow);
  const deleteTask = useOrchestrationStore((s) => s.deleteTask);
  const router = useRouter();
  function openEdit() {
    router.push(`/automation/new?id=${task.id}`);
  }

  function openHistory() {
    router.push(`/automation/history?taskId=${task.id}`);
  }

  function showActions() {
    Alert.alert(task.name, undefined, [
      { text: t("orchestration:history"), onPress: openHistory },
      {
        text: t("orchestration:delete"),
        style: "destructive",
        onPress: confirmDeleteAction,
      },
      { text: t("orchestration:cancel") },
    ]);
  }
  const [busy, setBusy] = useState(false);

  function confirmDeleteAction() {
    Alert.alert(
      t("orchestration:delete"),
      t("orchestration:deleteTaskConfirm", { name: task.name }),
      [
        { text: t("orchestration:cancel"), style: "cancel" },
        {
          text: t("orchestration:delete"),
          style: "destructive",
          onPress: () => {
            void deleteTask(task.id).then((r) => {
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

  async function handleToggle(next: boolean) {
    if (busy) return;
    setBusy(true);
    const r = await toggleTask(task, next);
    setBusy(false);
    if (!r.ok) {
      toast.error(describeGraphError(r.code, r.message, t));
    }
  }

  async function handleRunNow() {
    if (busy) return;
    setBusy(true);
    const r = await runNow(task.id);
    setBusy(false);
    if (r.ok) {
      // 202 受理回执（轻提示——toast 体系对齐桌面 Sonner 语义）
      toast.info(t("orchestration:runNowAccepted"));
    } else {
      toast.error(describeGraphError(r.code, r.message, t));
    }
  }

  return (
    <Pressable
      onPress={openEdit}
      onLongPress={showActions}
      className={`bg-card px-4 py-3 dark:bg-[#1C1C1E] ${
        isLast ? "" : "border-b border-sep dark:border-[#545458A6]"
      }`}
      style={({ pressed }) =>
        pressed ? { backgroundColor: colors.subtle } : undefined
      }
    >
      <View className="flex-row items-center gap-2">
        <View className="flex-row items-center gap-1.5">
          <View
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: KIND_DOT_COLOR[task.targetKind] }}
          />
          {task.targetKind === "graph" && (
            <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
              {t("orchestration:kindGraph")}
            </Text>
          )}
        </View>
        <Text
          numberOfLines={1}
          className="flex-1 text-base text-black dark:text-white"
        >
          {task.name}
        </Text>
        <Switch
          value={task.enabled}
          disabled={busy}
          onValueChange={(next) => void handleToggle(next)}
          trackColor={{ false: "#d4d4d8", true: colors.primary }}
          ios_backgroundColor="#3f3f46"
        />
      </View>
      <Text
        numberOfLines={1}
        className="mt-1 text-xs text-label2 dark:text-[#EBEBF599]"
      >
        {(task.scheduleText || t("orchestration:scheduleNone")) +
          " · " +
          nextRunLabel(task, t)}
      </Text>
      <View className="mt-2 flex-row justify-end">
        <Pressable
          onPress={() => void handleRunNow()}
          disabled={busy}
          className="flex-row items-center gap-1 rounded-lg border border-sep px-3 py-1.5 dark:border-[#545458A6]"
          style={({ pressed }) => ({
            backgroundColor: pressed ? colors.subtle : "transparent",
            opacity: busy ? 0.6 : 1,
          })}
        >
          <Play size={13} color={colors.primary} />
          <Text className="text-sm" style={{ color: colors.primary }}>
            {t("orchestration:runNow")}
          </Text>
        </Pressable>
      </View>
    </Pressable>
  );
}

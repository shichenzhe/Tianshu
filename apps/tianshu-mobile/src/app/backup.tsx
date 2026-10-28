import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  FlatList,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { HardDriveUpload, Trash2 } from "lucide-react-native";
import type { BackupMeta } from "@tianshu/protocol";

import { GroupSection } from "@/components/GroupSection";
import { PageHeader } from "@/components/PageHeader";
import { relativeTimeLabel } from "@/lib/relative-time-label";
import { formatRelative } from "@/logic/time";
import { useBackupStore } from "@/store/backup.store";
import {
  useConnectionCapabilities,
  useConnectionsStore,
} from "@/store/connections.store";
import { useThemeColors } from "@/store/theme";

/** 字节数 → 人读（<1MB KB / <1GB MB / 其余 GB，一位小数） */
function sizeLabel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** 进度帧文案：packing 无字节维度（阶段文案）；uploading 百分比 */
function progressLabel(
  payload: { phase: string; current: number; total: number },
  t: (key: string, vars?: Record<string, unknown>) => string,
): string {
  if (payload.phase === "packing") return t("phasePacking");
  if (payload.total > 0) {
    return t("phaseUploadingPercent", {
      percent: Math.floor((payload.current / payload.total) * 100),
    });
  }
  return t("phaseUploading");
}

/**
 * 备份页（备份面批）：capability backup 门禁（桌面被控面专属——遥控桌面
 * 备份客户端打包上传它所配 direct 连接的无头端）。触发（note 可选，202
 * 受理+事件流进度）+ 列表（元数据行）+ 行删除（Alert 确认）。恢复桌面端
 * 做（重操作不进移动端，spec 裁定）。
 */
export default function BackupScreen() {
  const { t } = useTranslation(["backup", "common"]);
  const colors = useThemeColors();

  const activeConnId = useConnectionsStore((s) => s.activeConnId);
  const capabilities = useConnectionCapabilities(activeConnId);
  const backups = useBackupStore((s) => s.backups);
  const loading = useBackupStore((s) => s.loading);
  const creating = useBackupStore((s) => s.creating);
  const progress = useBackupStore((s) => s.progress);
  const lastError = useBackupStore((s) => s.lastError);
  const load = useBackupStore((s) => s.load);
  const trigger = useBackupStore((s) => s.trigger);
  const remove = useBackupStore((s) => s.remove);
  const clearLastError = useBackupStore((s) => s.clearLastError);
  const [note, setNote] = useState("");

  useEffect(() => {
    void load();
  }, [load]);

  // 终态错误即时提示后清空（toast 体系对齐：一次性轻提示）
  useEffect(() => {
    if (lastError !== null && lastError !== "") {
      Alert.alert(t("createFailedTitle"), lastError);
      clearLastError();
    }
  }, [lastError, clearLastError, t]);

  if (capabilities && !capabilities.includes("backup")) {
    return (
      <SafeAreaView
        className="flex-1 items-center justify-center bg-grouped dark:bg-black"
        edges={["top", "bottom"]}
      >
        <Text className="px-6 text-center text-sm text-label2 dark:text-[#EBEBF599]">
          {t("unsupported")}
        </Text>
      </SafeAreaView>
    );
  }

  function confirmDelete(meta: BackupMeta) {
    Alert.alert(
      t("deleteTitle"),
      t("deleteConfirm", {
        time: relativeTimeLabel(formatRelative(meta.createdAt), t),
      }),
      [
        { text: t("common:cancel"), style: "cancel" },
        {
          text: t("deleteTitle"),
          style: "destructive",
          onPress: () => {
            void remove(meta.id);
          },
        },
      ],
    );
  }

  async function handleTrigger() {
    const text = note.trim();
    const ok = await trigger(text || undefined);
    if (ok) setNote("");
  }

  return (
    <SafeAreaView
      className="flex-1 bg-grouped dark:bg-black"
      edges={["top", "bottom"]}
    >
      <PageHeader title={t("title")} backLabel={t("common:back")} />

      <FlatList
        data={backups}
        keyExtractor={(meta) => meta.id}
        onRefresh={() => void load()}
        refreshing={loading}
        contentContainerStyle={{
          flexGrow: backups.length === 0 ? 1 : 0,
          padding: 16,
          paddingBottom: 24,
          gap: 16,
        }}
        ListHeaderComponent={
          <GroupSection>
            <View className="gap-2 px-4 py-3">
              <Text className="text-[13px] font-medium text-label2 dark:text-[#EBEBF599]">
                {t("triggerSection")}
              </Text>
              <Text className="text-xs text-label3 dark:text-[#EBEBF54D]">
                {t("triggerHint")}
              </Text>
              <View className="flex-row items-center gap-2">
                <TextInput
                  value={note}
                  onChangeText={setNote}
                  maxLength={512}
                  placeholder={t("notePlaceholder")}
                  placeholderTextColor="#8E8E93"
                  editable={!creating}
                  className="min-h-10 flex-1 rounded-lg border border-sep bg-field px-3 py-2 text-sm text-black dark:border-[#545458A6] dark:bg-[#2C2C2E] dark:text-white"
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("trigger")}
                  disabled={creating}
                  onPress={() => void handleTrigger()}
                  className="flex-row items-center gap-1.5 rounded-lg border border-sep px-3 py-2 dark:border-[#545458A6]"
                  style={({ pressed }) => ({
                    backgroundColor: pressed ? colors.subtle : "transparent",
                    opacity: creating ? 0.5 : 1,
                  })}
                >
                  <HardDriveUpload size={15} color={colors.primary} />
                  <Text className="text-sm" style={{ color: colors.primary }}>
                    {t("trigger")}
                  </Text>
                </Pressable>
              </View>
              {creating && (
                <View className="gap-1 pt-1">
                  <View className="h-1.5 overflow-hidden rounded-full bg-field">
                    <View
                      className="h-full rounded-full"
                      style={{
                        backgroundColor: colors.primary,
                        width:
                          progress && progress.total > 0
                            ? `${Math.min(100, Math.floor((progress.current / progress.total) * 100))}%`
                            : "8%",
                      }}
                    />
                  </View>
                  <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
                    {progress ? progressLabel(progress, t) : t("phasePacking")}
                  </Text>
                </View>
              )}
            </View>
          </GroupSection>
        }
        ListEmptyComponent={
          <View className="flex-1 items-center justify-center gap-1 px-4">
            <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
              {t("empty")}
            </Text>
            <Text className="text-xs text-label3 dark:text-[#EBEBF54D]">
              {t("emptyTip")}
            </Text>
          </View>
        }
        renderItem={({ item, index }) => (
          <Pressable
            onLongPress={() => confirmDelete(item)}
            className={`bg-card px-4 py-3 dark:bg-[#1C1C1E] ${
              index === backups.length - 1
                ? ""
                : "border-b border-sep dark:border-[#545458A6]"
            }`}
          >
            <View className="flex-row items-center gap-2">
              <View className="min-w-0 flex-1">
                <Text
                  numberOfLines={1}
                  className="text-[15px] text-black dark:text-white"
                >
                  {item.note?.trim() || t("unnamedBackup")}
                </Text>
                <Text className="mt-0.5 text-xs text-label2 dark:text-[#EBEBF599]">
                  {relativeTimeLabel(formatRelative(item.createdAt), t)} ·{" "}
                  {sizeLabel(item.fileSize)} · v{item.appVersion}
                  {item.deviceName ? ` · ${item.deviceName}` : ""}
                </Text>
              </View>
              {item.status === "uploading" ? (
                <Text className="text-xs text-label3 dark:text-[#EBEBF54D]">
                  {t("statusUploading")}
                </Text>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("deleteTitle")}
                  onPress={() => confirmDelete(item)}
                  hitSlop={8}
                  className="rounded-full p-1"
                  style={({ pressed }) => ({
                    backgroundColor: pressed ? colors.subtle : "transparent",
                  })}
                >
                  <Trash2 size={16} color="#FF3B30" />
                </Pressable>
              )}
            </View>
          </Pressable>
        )}
      />
    </SafeAreaView>
  );
}

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { RefreshCw, Send, Trash2 } from "lucide-react-native";

import { MarkdownLite } from "@/components/MarkdownLite";
import { ModelPicker } from "@/components/ModelPicker";
import { PageHeader } from "@/components/PageHeader";
import { GroupSection } from "@/components/GroupSection";
import { relativeTimeLabel } from "@/lib/relative-time-label";
import { formatRelative } from "@/logic/time";
import { describeMemoryResult } from "@/logic/memory-error";
import {
  useConnectionCapabilities,
  useConnectionsStore,
} from "@/store/connections.store";
import { useMemoryStore } from "@/store/memory.store";
import { useThemeColors } from "@/store/theme";

/**
 * 记忆进化页（记忆批）：capability memory 门禁（桌面被控面专属）。开关/
 * 整理模型（saveConfig）+ 画像视图（MarkdownLite 渲染四板块全文）+ AI
 * 指令（applyInstruction）+ 手动整理（compile）+ 重置（saveProfile 空串，
 * Alert 二次确认）。AI 操作错码经 describeMemoryResult 映射文案。
 */
export default function MemoryScreen() {
  const { t } = useTranslation(["memory", "common"]);
  const colors = useThemeColors();

  const activeConnId = useConnectionsStore((s) => s.activeConnId);
  const capabilities = useConnectionCapabilities(activeConnId);
  const state = useMemoryStore((s) => s.state);
  const loading = useMemoryStore((s) => s.loading);
  const busy = useMemoryStore((s) => s.busy);
  const load = useMemoryStore((s) => s.load);
  const saveConfig = useMemoryStore((s) => s.saveConfig);
  const saveProfile = useMemoryStore((s) => s.saveProfile);
  const applyInstruction = useMemoryStore((s) => s.applyInstruction);
  const compile = useMemoryStore((s) => s.compile);
  const [instruction, setInstruction] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  if (capabilities && !capabilities.includes("memory")) {
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

  function confirmReset() {
    Alert.alert(t("resetTitle"), t("resetConfirm"), [
      { text: t("common:cancel"), style: "cancel" },
      {
        text: t("resetTitle"),
        style: "destructive",
        onPress: () => {
          void saveProfile("").then((ok) => {
            if (!ok) setActionError(t("saveFailed"));
          });
        },
      },
    ]);
  }

  async function handleInstruction() {
    const text = instruction.trim();
    if (!text || busy !== null) return;
    setActionError(null);
    const result = await applyInstruction(text);
    const message = describeMemoryResult(result, t);
    if (message !== null) {
      setActionError(message);
      return;
    }
    setInstruction("");
  }

  async function handleCompile() {
    if (busy !== null) return;
    setActionError(null);
    const result = await compile();
    const message = describeMemoryResult(result, t);
    if (message !== null) setActionError(message);
  }

  return (
    <SafeAreaView
      className="flex-1 bg-grouped dark:bg-black"
      edges={["top", "bottom"]}
    >
      <PageHeader title={t("title")} backLabel={t("common:back")} />

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ padding: 16, paddingBottom: 24, gap: 16 }}
        refreshControl={undefined}
      >
        <GroupSection>
          <View className="flex-row items-center gap-3 px-4 py-3">
            <View className="min-w-0 flex-1">
              <Text className="text-[15px] text-black dark:text-white">
                {t("enabled")}
              </Text>
              <Text className="mt-0.5 text-xs text-label2 dark:text-[#EBEBF599]">
                {t("enabledHint")}
              </Text>
            </View>
            <Switch
              value={state?.enabled ?? false}
              disabled={loading}
              onValueChange={(next) => {
                void saveConfig({ enabled: next });
              }}
              trackColor={{ false: "#d4d4d8", true: colors.primary }}
              ios_backgroundColor="#3f3f46"
            />
          </View>
        </GroupSection>

        <GroupSection>
          <View className="gap-1 px-4 pb-2 pt-3">
            <Text className="text-[13px] font-medium text-label2 dark:text-[#EBEBF599]">
              {t("modelSection")}
            </Text>
          </View>
          <View className="items-start px-4 pb-3">
            <ModelPicker
              modelId={state?.modelId ?? null}
              onPick={(modelId) => {
                void saveConfig({ modelId });
              }}
            />
            <Text className="mt-1.5 text-xs text-label3 dark:text-[#EBEBF54D]">
              {t("modelHint")}
            </Text>
          </View>
        </GroupSection>

        <GroupSection>
          <View className="gap-1 px-4 pb-2 pt-3">
            <Text className="text-[13px] font-medium text-label2 dark:text-[#EBEBF599]">
              {t("profileSection")}
            </Text>
            {state?.lastCompiledAt ? (
              <Text className="text-xs text-label3 dark:text-[#EBEBF54D]">
                {t("lastCompiledAt", {
                  time: relativeTimeLabel(
                    formatRelative(state.lastCompiledAt),
                    t,
                  ),
                })}
              </Text>
            ) : null}
            {state?.lastError ? (
              <Text className="text-xs text-red-500">
                {t("lastError", { message: state.lastError })}
              </Text>
            ) : null}
          </View>
          <View className="px-4 pb-3">
            {state && state.profile !== "" ? (
              <MarkdownLite text={state.profile} />
            ) : (
              <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
                {t("profileEmpty")}
              </Text>
            )}
          </View>
        </GroupSection>

        <GroupSection>
          <View className="gap-2 px-4 py-3">
            <Text className="text-[13px] font-medium text-label2 dark:text-[#EBEBF599]">
              {t("instructionSection")}
            </Text>
            <View className="flex-row items-center gap-2">
              <TextInput
                value={instruction}
                onChangeText={setInstruction}
                maxLength={2000}
                placeholder={t("instructionPlaceholder")}
                placeholderTextColor="#8E8E93"
                className="min-h-10 flex-1 rounded-lg border border-sep bg-field px-3 py-2 text-sm text-black dark:border-[#545458A6] dark:bg-[#2C2C2E] dark:text-white"
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("apply")}
                disabled={busy !== null || !instruction.trim()}
                onPress={() => void handleInstruction()}
                hitSlop={8}
                className="rounded-lg p-2"
                style={({ pressed }) => ({
                  backgroundColor: pressed ? colors.subtle : "transparent",
                  opacity: busy !== null || !instruction.trim() ? 0.4 : 1,
                })}
              >
                <Send size={18} color={colors.primary} />
              </Pressable>
            </View>
            <View className="flex-row gap-2 pt-1">
              <Pressable
                accessibilityRole="button"
                disabled={busy !== null}
                onPress={() => void handleCompile()}
                className="flex-1 flex-row items-center justify-center gap-1.5 rounded-lg border border-sep px-3 py-2 dark:border-[#545458A6]"
                style={({ pressed }) => ({
                  backgroundColor: pressed ? colors.subtle : "transparent",
                  opacity: busy !== null ? 0.5 : 1,
                })}
              >
                <RefreshCw size={15} color={colors.primary} />
                <Text className="text-sm" style={{ color: colors.primary }}>
                  {t("compileNow")}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={busy !== null}
                onPress={confirmReset}
                className="flex-row items-center justify-center gap-1.5 rounded-lg border border-sep px-3 py-2 dark:border-[#545458A6]"
                style={({ pressed }) => ({
                  backgroundColor: pressed ? colors.subtle : "transparent",
                  opacity: busy !== null ? 0.5 : 1,
                })}
              >
                <Trash2 size={15} color="#FF3B30" />
                <Text className="text-sm text-red-500">{t("resetTitle")}</Text>
              </Pressable>
            </View>
            {busy !== null && (
              <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
                {busy === "instruction" ? t("applying") : t("compiling")}
              </Text>
            )}
            {actionError && (
              <Text className="text-xs text-red-500">{actionError}</Text>
            )}
          </View>
        </GroupSection>
      </ScrollView>
    </SafeAreaView>
  );
}

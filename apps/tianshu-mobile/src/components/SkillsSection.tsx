import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Switch,
  Text,
  View,
} from "react-native";
import { Trash2, Upload, Zap } from "lucide-react-native";
import { SKILL_SCENARIOS, type SkillScenario } from "@tianshu/protocol";

import { DialogShell } from "@/components/DialogShell";
import { FormFooter } from "@/components/FormFooter";
import { formatRelative } from "@/logic/time";
import { pickSkillZip } from "@/logic/skill-import";
import { relativeTimeLabel } from "@/lib/relative-time-label";
import { toast } from "@/lib/toast-bus";
import { useSkillsStore, type SkillManageRow } from "@/store/skills.store";
import { useThemeColors } from "@/store/theme";

const SCENARIO_KEYS: Record<SkillScenario, string> = {
  daily: "skills:scenario.daily",
  coding: "skills:scenario.coding",
  design: "skills:scenario.design",
};

/**
 * 技能启停段（A3 批升级）：skills/query 扩展概要（场景徽章/内置标记）+
 * Switch 启停（乐观切换失败回滚）；行点击进入详情弹层——场景打标
 * （daily/coding/design 三值多选 → skills/setScenarios）、正文预览
 * （skills/read）、统计行（skills/stats——调用 N 次 · 最近使用相对时间，
 * 空统计不显）、卸载确认（skills/uninstall——builtin 隐藏入口并标注，
 * 服务端 SKILL_BUILTIN 双保险）。A3 尾：底部「导入技能（zip）」入口
 * （document-picker → base64 → skills/installUpload，冲突弹覆盖确认）。
 * 无连接/端点失败整段隐藏（旧被控端零迁移）；空清单仍显导入入口。
 * 跟随活动连接重拉。
 */
export function SkillsSection({
  refreshKey,
}: {
  /** 重拉信号（活动连接 id 变化即重拉——切端技能面随之刷新） */
  refreshKey: string | number | null;
}) {
  const { t } = useTranslation(["settings", "skills", "common"]);
  const colors = useThemeColors();
  const rows = useSkillsStore((s) => s.rows);
  const initialized = useSkillsStore((s) => s.initialized);
  const uploadingZip = useSkillsStore((s) => s.uploadingZip);
  const [detailTarget, setDetailTarget] = useState<SkillManageRow | null>(null);

  useEffect(() => {
    void useSkillsStore.getState().load();
  }, [refreshKey]);

  if (!initialized) {
    return null; // 加载中/端点不可用——隐藏（旧被控端零迁移）
  }

  const toggle = async (name: string, next: boolean) => {
    const store = useSkillsStore.getState();
    store.patchEnabled(name, next);
    const ok = await store.setEnabled(name, next);
    if (!ok) store.patchEnabled(name, !next);
  };

  const toastUploadError = (code: string | null) => {
    toast.error(
      t([`skills:error.${code ?? ""}`, "skills:error.fallback"], {
        message: code ?? "",
      }),
    );
  };

  async function runInstallUpload(
    picked: { name: string; base64: string },
    overwrite = false,
  ) {
    const result = await useSkillsStore
      .getState()
      .installUpload(picked.name, picked.base64, overwrite);
    if (result === null) {
      toastUploadError(useSkillsStore.getState().error);
      return;
    }
    if (result.status === "conflict") {
      Alert.alert(
        t("skills:conflictTitle"),
        t("skills:conflictMessage", { name: result.name }),
        [
          { text: t("common:cancel"), style: "cancel" },
          {
            text: t("skills:overwrite"),
            onPress: () => void runInstallUpload(picked, true),
          },
        ],
      );
      return;
    }
    toast.info(t("skills:installSuccess", { name: result.record.name }));
  }

  async function handleImportZip() {
    let picked;
    try {
      picked = await pickSkillZip();
    } catch {
      toast.error(t("skills:importFailed"));
      return;
    }
    if (picked === null) return;
    if (picked === "invalid") {
      toast.error(t("skills:importInvalid"));
      return;
    }
    if (picked === "tooLarge") {
      toast.error(t("skills:importTooLarge"));
      return;
    }
    await runInstallUpload(picked);
  }

  return (
    <View className="gap-2">
      <Text className="px-1 text-xs font-medium text-label3 dark:text-[#EBEBF54D]">
        {t("settings:skillsTitle")}
      </Text>
      <View className="gap-1 rounded-lg border border-sep px-3 py-2 dark:border-[#545458A6]">
        {rows.map((row) => (
          <Pressable
            key={row.name}
            onPress={() => setDetailTarget(row)}
            className="flex-row items-center gap-2 border-b border-black/5 py-2 dark:border-white/10"
          >
            <Zap size={13} color={row.enabled ? colors.primary : "#8E8E93"} />
            <View className="min-w-0 flex-1">
              <View className="flex-row items-center gap-1.5">
                <Text
                  numberOfLines={1}
                  className="min-w-0 flex-1 text-sm text-black dark:text-white"
                >
                  {row.name}
                </Text>
                {row.builtin && (
                  <Text className="text-[10px] text-label3 dark:text-[#EBEBF54D]">
                    {t("skills:builtinBadge")}
                  </Text>
                )}
              </View>
              {row.scenarios.length > 0 && (
                <View className="mt-0.5 flex-row gap-1">
                  {row.scenarios.map((scenario) => (
                    <View
                      key={scenario}
                      className="rounded bg-primary-subtle px-1.5 py-px"
                    >
                      <Text className="text-[10px] text-black dark:text-white">
                        {t(SCENARIO_KEYS[scenario])}
                      </Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
            <Switch
              value={row.enabled}
              trackColor={{ true: colors.primary }}
              onValueChange={(next) => void toggle(row.name, next)}
            />
          </Pressable>
        ))}
        <Pressable
          onPress={() => void handleImportZip()}
          disabled={uploadingZip}
          className="flex-row items-center gap-2 py-2"
          hitSlop={8}
          style={{ opacity: uploadingZip ? 0.6 : 1 }}
        >
          {uploadingZip ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Upload size={13} color={colors.primary} />
          )}
          <Text className="text-sm" style={{ color: colors.primary }}>
            {uploadingZip ? t("skills:importing") : t("skills:importZip")}
          </Text>
        </Pressable>
      </View>
      {detailTarget && (
        <SkillDetailDialog
          target={detailTarget}
          onClose={() => setDetailTarget(null)}
        />
      )}
    </View>
  );
}

/** 技能详情弹层：场景打标 + 正文预览 + 统计行 + 卸载 */
function SkillDetailDialog({
  target,
  onClose,
}: {
  target: SkillManageRow;
  onClose: () => void;
}) {
  const { t } = useTranslation(["skills", "common"]);
  const colors = useThemeColors();
  const saving = useSkillsStore((s) => s.saving);
  const stat = useSkillsStore((s) => s.stats[target.name]);
  const [scenarios, setScenarios] = useState<SkillScenario[]>(target.scenarios);
  const [content, setContent] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);

  const toastError = (code: string | null) => {
    toast.error(
      t([`skills:error.${code ?? ""}`, "skills:error.fallback"], {
        message: code ?? "",
      }),
    );
  };

  async function handleSaveScenarios() {
    const ok = await useSkillsStore
      .getState()
      .setScenarios(target.name, scenarios);
    if (ok) {
      onClose();
    } else {
      toastError(useSkillsStore.getState().error);
    }
  }

  async function handlePreview() {
    setContentLoading(true);
    try {
      const text = await useSkillsStore.getState().readContent(target.name);
      setContent(text);
    } catch {
      toast.error(t("skills:previewFailed"));
    } finally {
      setContentLoading(false);
    }
  }

  function confirmUninstall() {
    Alert.alert(
      t("skills:uninstall"),
      t("skills:confirmUninstall", { name: target.name }),
      [
        { text: t("common:cancel"), style: "cancel" },
        {
          text: t("skills:uninstall"),
          style: "destructive",
          onPress: () => void performUninstall(),
        },
      ],
    );
  }

  async function performUninstall() {
    const ok = await useSkillsStore.getState().uninstall(target.name);
    if (ok) {
      onClose();
    } else {
      toastError(useSkillsStore.getState().error);
    }
  }

  return (
    <DialogShell
      title={target.name}
      busy={saving || contentLoading}
      onClose={onClose}
      footer={
        <FormFooter
          busy={saving || contentLoading}
          confirmDisabled={
            scenarios.slice().sort().join() ===
            target.scenarios.slice().sort().join()
          }
          onConfirm={() => void handleSaveScenarios()}
          onCancel={onClose}
          deleteLabel={target.builtin ? undefined : t("skills:uninstall")}
          onDelete={target.builtin ? undefined : confirmUninstall}
        />
      }
    >
      <View className="gap-1.5">
        <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
          {t("skills:scenarios")}
        </Text>
        <View className="flex-row gap-2">
          {SKILL_SCENARIOS.map((scenario) => {
            const active = scenarios.includes(scenario);
            return (
              <Pressable
                key={scenario}
                onPress={() =>
                  setScenarios((prev) =>
                    active
                      ? prev.filter((item) => item !== scenario)
                      : [...prev, scenario],
                  )
                }
                className="rounded-full px-3 py-1.5"
                style={{
                  backgroundColor: active ? colors.primary : colors.subtle,
                }}
              >
                <Text
                  className="text-xs font-medium"
                  style={{ color: active ? "#FFFFFF" : colors.primary }}
                >
                  {t(SCENARIO_KEYS[scenario])}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
      {target.builtin && (
        <Text className="text-xs leading-4 text-label2 dark:text-[#EBEBF599]">
          {t("skills:builtinNoUninstall")}
        </Text>
      )}
      {stat && (stat.usedCount > 0 || stat.lastUsedAt !== null) && (
        <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
          {t("skills:statUsed", { count: stat.usedCount })}
          {stat.lastUsedAt !== null &&
            ` · ${t("skills:lastUsed", {
              time: relativeTimeLabel(
                formatRelative(new Date(stat.lastUsedAt).toISOString()),
                t,
              ),
            })}`}
        </Text>
      )}
      {content == null ? (
        <Pressable
          onPress={() => void handlePreview()}
          disabled={contentLoading}
          className="flex-row items-center gap-2 rounded-lg border border-sep px-3 py-2.5 dark:border-[#545458A6]"
        >
          {contentLoading ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : null}
          <Text className="text-sm" style={{ color: colors.primary }}>
            {t("skills:preview")}
          </Text>
        </Pressable>
      ) : (
        <ScrollView className="max-h-56 rounded-lg border border-sep bg-field px-3 py-2 dark:border-[#545458A6] dark:bg-[#2C2C2E]">
          <Text className="text-xs leading-4 text-black dark:text-white">
            {content}
          </Text>
        </ScrollView>
      )}
      {!target.builtin && (
        <Pressable
          onPress={confirmUninstall}
          disabled={saving}
          className="flex-row items-center gap-2"
          hitSlop={8}
        >
          <Trash2 size={14} color="#FF3B30" />
          <Text className="text-sm text-[#FF3B30]">
            {t("skills:uninstall")}
          </Text>
        </Pressable>
      )}
    </DialogShell>
  );
}

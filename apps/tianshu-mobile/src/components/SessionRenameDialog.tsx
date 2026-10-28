import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal, Pressable, Text, TextInput, View } from "react-native";

import type { SessionBrief } from "@/store/sessions.store";
import { useThemeColors } from "@/store/theme";

/**
 * 会话重命名对话框（能力对齐 B1，桥 session/update 的 title 面——两端
 * 早已支持零协议改动）：双键提交（trim 空或原文禁定），取消/遮罩点关；
 * 提交后由 sessions.store 乐观反映，失败 toast 在调用方。
 */
export function SessionRenameDialog({
  session,
  onSubmit,
  onClose,
}: {
  session: SessionBrief | null;
  onSubmit: (title: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const colors = useThemeColors();
  const [value, setValue] = useState("");

  // 每次打开重置为当前标题（同一组件复用于不同会话）
  useEffect(() => {
    setValue(session?.title ?? "");
  }, [session]);

  if (!session) return null;
  const trimmed = value.trim();
  const unchanged = trimmed === (session.title ?? "").trim();
  const submitDisabled = trimmed === "" || unchanged;

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable
        className="flex-1 items-center justify-center bg-black/60 px-10"
        onPress={onClose}
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          className="w-full rounded-2xl border border-black/10 bg-white p-4 dark:border-white/15 dark:bg-neutral-900"
        >
          <Text className="mb-3 text-[15px] font-semibold text-black dark:text-white">
            {t("chat:rename")}
          </Text>
          <TextInput
            value={value}
            onChangeText={setValue}
            placeholder={t("chat:renamePlaceholder")}
            placeholderTextColor="#8E8E93"
            autoFocus
            selectTextOnFocus
            returnKeyType="done"
            maxLength={255}
            onSubmitEditing={() => {
              if (!submitDisabled) onSubmit(trimmed);
            }}
            className="rounded-lg bg-field px-3 py-2.5 text-[15px] text-black dark:bg-[#2C2C2E] dark:text-white"
          />
          <View className="mt-4 flex-row justify-end gap-8">
            <Pressable onPress={onClose} hitSlop={8}>
              <Text className="text-[15px] text-label2 dark:text-[#EBEBF599]">
                {t("common:cancel")}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => onSubmit(trimmed)}
              disabled={submitDisabled}
              hitSlop={8}
              style={{ opacity: submitDisabled ? 0.4 : 1 }}
            >
              <Text
                className="text-[15px] font-medium"
                style={{ color: colors.primary }}
              >
                {t("common:confirm")}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

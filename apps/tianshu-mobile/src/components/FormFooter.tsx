import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";

import { ACTION_DANGER } from "@/components/AppActionSheet";
import { useThemeColors } from "@/store/theme";

/** 弹层底部操作条（A5 批自 providers 抽取共享）：左侧槽（辅助动作 +
 *  删除，可选）+ 取消 + 确定 */
export function FormFooter({
  busy,
  confirmDisabled,
  onConfirm,
  onCancel,
  auxLabel,
  onAux,
  deleteLabel,
  onDelete,
}: {
  busy: boolean;
  confirmDisabled: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** 左槽辅助动作（A2 尾专家导出等非破坏性操作，主色） */
  auxLabel?: string;
  onAux?: () => void;
  deleteLabel?: string;
  onDelete?: () => void;
}) {
  const { t } = useTranslation("common");
  const colors = useThemeColors();
  const disabled = busy || confirmDisabled;
  return (
    <View className="mt-5 flex-row items-center justify-end gap-6 border-t border-sep px-5 py-4 dark:border-[#545458A6]">
      {(auxLabel || deleteLabel) && (
        <View className="mr-auto flex-row items-center gap-4">
          {auxLabel && onAux && (
            <Pressable disabled={busy} onPress={onAux} hitSlop={8}>
              <Text className="text-[15px]" style={{ color: colors.primary }}>
                {auxLabel}
              </Text>
            </Pressable>
          )}
          {deleteLabel && onDelete && (
            <Pressable disabled={busy} onPress={onDelete} hitSlop={8}>
              <Text className="text-[15px]" style={{ color: ACTION_DANGER }}>
                {deleteLabel}
              </Text>
            </Pressable>
          )}
        </View>
      )}
      <Pressable disabled={busy} onPress={onCancel} hitSlop={8}>
        <Text className="text-[15px] text-label2 dark:text-[#EBEBF599]">
          {t("cancel")}
        </Text>
      </Pressable>
      <Pressable
        disabled={disabled}
        onPress={onConfirm}
        hitSlop={8}
        style={{ opacity: disabled ? 0.4 : 1 }}
      >
        <Text
          className="text-[15px] font-medium"
          style={{ color: colors.primary }}
        >
          {t("confirm")}
        </Text>
      </Pressable>
    </View>
  );
}

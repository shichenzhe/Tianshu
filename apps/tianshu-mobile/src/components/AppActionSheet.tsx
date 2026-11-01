import type { ComponentType } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";

import { sheetBottomPadding } from "@/lib/sheet-layout";
import { ACTION_DANGER } from "@/theme/colors";
import { useThemeColors } from "@/store/theme";

export interface ActionSheetItem {
  key: string;
  label: string;
  Icon: ComponentType<{ size?: number; color?: string }>;
  danger?: boolean;
  /** 置灰禁用（如上传中防重复进入），点击不触发 */
  disabled?: boolean;
  onPress: () => void;
}

/** 删除等破坏性操作的标准红——单源在 theme/colors（本批上移），此处保留
 *  出口供既有引用方（FormFooter/PlanItemDialog/[id].tsx）零改动 */
export { ACTION_DANGER };

/** 微信式底部操作面板（微信范式批抽取）：圆角组卡 + 把手 + 遮罩点关；
 *  SessionActionsSheet/MessageActionsSheet 共用 */
export function AppActionSheet({
  visible,
  title,
  items,
  onClose,
}: {
  visible: boolean;
  title?: string;
  items: ActionSheetItem[];
  onClose: () => void;
}) {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation("common");
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable className="flex-1 justify-end bg-black/40" onPress={onClose}>
        <Pressable
          onPress={(e) => e.stopPropagation()}
          accessibilityViewIsModal
          className="rounded-t-2xl bg-white px-4 pt-3 shadow-lg shadow-black/25 dark:bg-neutral-900"
          style={{ paddingBottom: sheetBottomPadding(insets.bottom) }}
        >
          <View className="mb-2 h-[5px] w-9 self-center rounded-full bg-black/20 dark:bg-white/25" />
          {title != null && (
            <Text
              numberOfLines={1}
              className="mb-1 px-1 text-center text-xs text-label3 dark:text-[#EBEBF54D]"
            >
              {title}
            </Text>
          )}
          {items.map(({ key, label, Icon, danger, disabled, onPress }) => (
            <Pressable
              key={key}
              disabled={disabled === true}
              accessibilityRole="button"
              accessibilityState={{ disabled: disabled === true }}
              onPress={() => {
                onClose();
                onPress();
              }}
              className="min-h-12 flex-row items-center gap-3 rounded-lg px-3"
              style={({ pressed }) => ({
                backgroundColor: pressed ? colors.subtle : "transparent",
                opacity: disabled === true ? 0.4 : 1,
              })}
            >
              <View
                className="h-8 w-8 items-center justify-center rounded-lg"
                style={{ backgroundColor: colors.subtle }}
              >
                <Icon
                  size={15}
                  color={danger ? ACTION_DANGER : colors.primary}
                />
              </View>
              <Text
                className={`flex-1 text-sm ${danger ? "" : "text-black dark:text-white"}`}
                style={danger ? { color: ACTION_DANGER } : undefined}
              >
                {label}
              </Text>
            </Pressable>
          ))}
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={t("cancel")}
            className="mt-1 min-h-12 items-center justify-center rounded-lg border-t border-sep dark:border-[#545458A6]"
            style={({ pressed }) => ({
              backgroundColor: pressed ? colors.subtle : "transparent",
            })}
          >
            <Text className="text-[16px] font-medium text-black dark:text-white">
              {t("cancel")}
            </Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

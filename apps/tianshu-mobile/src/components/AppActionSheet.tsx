import type { ComponentType } from "react";
import { Modal, Pressable, Text, View } from "react-native";

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

/** 删除等破坏性操作的标准红（跨组件同语义色） */
export const ACTION_DANGER = "#FF3B30";

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
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable className="flex-1 justify-end bg-black/60" onPress={onClose}>
        <Pressable
          onPress={(e) => e.stopPropagation()}
          className="rounded-t-2xl bg-white px-4 pb-8 pt-3 shadow-lg shadow-black/25 dark:bg-neutral-900"
        >
          <View className="mb-2 h-[5px] w-9 self-center rounded-full bg-black/20 dark:bg-white/25" />
          {title != null && (
            <Text
              numberOfLines={1}
              className="mb-1 px-1 text-xs text-label3 dark:text-[#EBEBF54D]"
            >
              {title}
            </Text>
          )}
          {items.map(({ key, label, Icon, danger, disabled, onPress }) => (
            <Pressable
              key={key}
              disabled={disabled === true}
              onPress={() => {
                onClose();
                onPress();
              }}
              className="flex-row items-center gap-3 rounded-lg px-3 py-3"
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
        </Pressable>
      </Pressable>
    </Modal>
  );
}

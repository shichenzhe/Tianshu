import type { ReactNode } from "react";
import { Modal, Pressable, Text, View } from "react-native";

/**
 * 底部详情面板（Alert 替换批，呈现层现代化）：系统 Alert 弹纯文本当
 * 详情页是「老旧感」来源之一——替换为与 PlusSheet 同视觉骨架的底部
 * 面板（把手/圆角/半透明遮罩），标题 + children 自由内容。既有各专用
 * sheet 不回迁，新详情面板统一走此组件。
 */
export function DetailSheet({
  visible,
  title,
  onClose,
  children,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
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
          className="rounded-t-2xl bg-white shadow-lg shadow-black/25 px-4 pb-8 pt-3 dark:bg-neutral-900"
        >
          <View className="mb-2 self-center h-[5px] w-9 rounded-full bg-black/20 dark:bg-white/25" />
          <Text className="mb-2 px-1 text-sm font-medium text-black dark:text-white">
            {title}
          </Text>
          {children}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

import type { ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
} from "react-native";

/** 底部弹层壳（A5 批自 providers 抽取共享）：微信式圆角底卡 + 遮罩点关 +
 *  busy 期间禁关；children 为表单体，footer 为底部操作条 */
export function DialogShell({
  title,
  children,
  footer,
  busy,
  onClose,
}: {
  title: string;
  children: ReactNode;
  footer: ReactNode;
  busy: boolean;
  onClose: () => void;
}) {
  return (
    <Modal
      visible
      transparent
      animationType="slide"
      onRequestClose={() => {
        if (!busy) onClose();
      }}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        className="flex-1"
      >
        <Pressable
          className="flex-1 justify-end bg-black/60"
          onPress={() => {
            if (!busy) onClose();
          }}
        >
          <Pressable
            onPress={(event) => event.stopPropagation()}
            className="max-h-[88%] w-full overflow-hidden rounded-t-3xl border border-sep bg-grouped dark:border-[#545458A6] dark:bg-black"
          >
            <Text className="px-5 pb-3 pt-5 text-lg font-semibold text-black dark:text-white">
              {title}
            </Text>
            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ paddingHorizontal: 20, gap: 16 }}
            >
              {children}
            </ScrollView>
            {footer}
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

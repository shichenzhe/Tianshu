// 本地产物预览弹层（AR 批）：artifact/read 判别联合消费——text 全文只读
//（超长截断守卫同 FilePreviewModal 口径）+ image（dataUrl base64 原生
// Image）；PREVIEW_UNSUPPORTED 等业务错文案居中（被控端中文文案直用）。
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { X } from "lucide-react-native";
import { useArtifactStore } from "@/store/artifact.store";
import { useThemeColors } from "@/store/theme";

/** 渲染上限（字符）：read 上限 512KB，全量塞渲染树会卡（FilePreviewModal 同口径） */
const PREVIEW_MAX_CHARS = 50000;

export function ArtifactPreviewModal() {
  const { t } = useTranslation(["library", "common"]);
  const colors = useThemeColors();
  const preview = useArtifactStore((s) => s.preview);
  const previewLoading = useArtifactStore((s) => s.previewLoading);
  const previewError = useArtifactStore((s) => s.previewError);

  const open = preview !== null || previewLoading || previewError !== null;
  if (!open) return null;

  return (
    <Modal
      transparent
      visible
      animationType="fade"
      onRequestClose={() => useArtifactStore.getState().closePreview()}
    >
      <View className="flex-1 justify-center bg-black/60 px-4">
        <View className="max-h-[85%] rounded-2xl bg-white p-4 shadow-lg shadow-black/25 dark:bg-neutral-900">
          <View className="mb-2 flex-row items-center justify-between gap-2">
            <Text
              className="flex-1 text-sm font-medium text-black dark:text-white"
              numberOfLines={1}
            >
              {preview?.name ?? ""}
            </Text>
            <Pressable
              hitSlop={10}
              onPress={() => useArtifactStore.getState().closePreview()}
              accessibilityLabel={t("common:close")}
            >
              <X size={20} color="#8E8E93" />
            </Pressable>
          </View>
          {previewLoading ? (
            <View className="h-40 items-center justify-center">
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : previewError ? (
            <Text className="py-8 text-center text-sm text-amber-600 dark:text-amber-400">
              {previewError}
            </Text>
          ) : preview?.content.kind === "image" ? (
            <Image
              source={{
                uri: `data:${preview.content.mime};base64,${preview.content.dataBase64}`,
              }}
              style={{ width: 320, height: 320, resizeMode: "contain" }}
            />
          ) : (
            <ScrollView className="max-h-[70%]">
              <Text className="text-sm text-black dark:text-white">
                {preview?.content.kind === "text"
                  ? preview.content.content.slice(0, PREVIEW_MAX_CHARS)
                  : ""}
              </Text>
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

import { useTranslation } from "react-i18next";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { FileText, FolderOutput } from "lucide-react-native";

import type { SessionFile } from "@/logic/session-files";
import { fileRefBasename } from "@/logic/file-refs";
import { useThemeColors } from "@/store/theme";

function FileRow({
  file,
  onPress,
}: {
  file: SessionFile;
  onPress: () => void;
}) {
  const { t } = useTranslation("chat");
  const colors = useThemeColors();
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center gap-3 rounded-lg px-2 py-2.5"
      style={({ pressed }) => ({
        backgroundColor: pressed ? colors.subtle : "transparent",
      })}
    >
      <View
        className="h-8 w-8 items-center justify-center rounded-lg"
        style={{ backgroundColor: colors.subtle }}
      >
        <FileText size={15} color={colors.primary} />
      </View>
      <View className="min-w-0 flex-1">
        <Text
          numberOfLines={1}
          className="text-sm text-black dark:text-white"
        >
          {fileRefBasename(file.path)}
        </Text>
        <Text
          numberOfLines={1}
          className="text-xs text-label3 dark:text-[#EBEBF54D]"
        >
          {file.path}
        </Text>
      </View>
      {file.status === "writing" && (
        <Text className="text-[10px] text-amber-600 dark:text-amber-400">
          {t("filesWriting")}
        </Text>
      )}
    </Pressable>
  );
}

/**
 * 会话文件 sheet（MR-T6，桌面 DetailPanel 产物 tab 的移动端形态）：
 * 产物文件（write_file done/writing）+ 工作空间文件（引用）两组列表；
 * 点行上抛 onOpenFile 由宿主页开 FilePreviewModal。
 */
export function SessionFilesSheet({
  files,
  visible,
  onClose,
  onOpenFile,
}: {
  files: SessionFile[];
  visible: boolean;
  onClose: () => void;
  onOpenFile: (file: SessionFile) => void;
}) {
  const { t } = useTranslation("chat");
  const colors = useThemeColors();
  const artifacts = files.filter((f) => f.group === "artifact");
  const workspace = files.filter((f) => f.group === "workspace");

  const section = (title: string, list: SessionFile[]) => (
    <View className="mb-3">
      <Text className="mb-1 px-2 text-xs font-medium text-label3 dark:text-[#EBEBF54D]">
        {title}
      </Text>
      {list.map((file) => (
        <FileRow
          key={`${file.group}-${file.path}`}
          file={file}
          onPress={() => onOpenFile(file)}
        />
      ))}
    </View>
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable className="flex-1 justify-end bg-black/60" onPress={onClose}>
        <Pressable
          onPress={(e) => e.stopPropagation()}
          className="max-h-[70%] rounded-t-2xl bg-white shadow-lg shadow-black/25 px-4 pb-8 pt-3 dark:bg-neutral-900"
        >
          <View className="mb-2 self-center h-[5px] w-9 rounded-full bg-black/20 dark:bg-white/25" />
          <View className="mb-2 flex-row items-center gap-2 px-1">
            <FolderOutput size={15} color={colors.primary} />
            <Text className="text-sm font-medium text-black dark:text-white">
              {t("filesSheetTitle")}
            </Text>
          </View>
          {files.length === 0 ? (
            <Text className="px-2 py-6 text-center text-sm text-label3 dark:text-[#EBEBF54D]">
              {t("filesEmpty")}
            </Text>
          ) : (
            <ScrollView nestedScrollEnabled>
              {artifacts.length > 0 && section(t("filesGroupArtifact"), artifacts)}
              {workspace.length > 0 && section(t("filesGroupWorkspace"), workspace)}
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

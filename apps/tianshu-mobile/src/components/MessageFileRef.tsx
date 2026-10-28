import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { FileText } from "lucide-react-native";

import { fileRefBasename } from "@/logic/file-refs";
import { FilePreviewModal } from "@/components/FilePreviewModal";
import { useThemeColors } from "@/store/theme";

/**
 * user 消息引用文件卡片（引用前缀段拆出渲染，替代气泡内生硬的路径行
 * 文本）：点击经 files/read 拉全文弹层预览（MarkdownLite 渲染 + 超长
 * 截断保护 + 复制全文；文件在被控主机上，遥控语义下「打开」即查看）。
 * 读取失败 toast 提示；无工作空间（未绑定/旧消息）纯展示不可点。
 */
export function MessageFileRef({
  path,
  workspaceId,
}: {
  path: string;
  workspaceId?: number | null;
}) {
  const { t } = useTranslation("chat");
  const colors = useThemeColors();
  const [previewOpen, setPreviewOpen] = useState(false);
  const clickable = workspaceId != null;

  return (
    <>
      <Pressable
        disabled={!clickable}
        onPress={() => setPreviewOpen(true)}
        accessibilityLabel={t("fileRefView", { name: fileRefBasename(path) })}
        className="mb-1.5 max-w-[85%] flex-row items-center gap-2 self-end rounded-lg border border-sep bg-white px-3 py-2 dark:border-[#545458A6] dark:bg-neutral-800"
        style={({ pressed }) => ({
          backgroundColor: pressed ? colors.subtle : undefined,
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
            className="text-sm font-medium text-black dark:text-white"
          >
            {fileRefBasename(path)}
          </Text>
          <Text
            numberOfLines={1}
            className="text-xs text-label3 dark:text-[#EBEBF54D]"
          >
            {path}
          </Text>
        </View>
      </Pressable>
      <FilePreviewModal
        path={path}
        workspaceId={workspaceId ?? null}
        visible={previewOpen}
        onClose={() => setPreviewOpen(false)}
      />
    </>
  );
}

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { ENDPOINTS } from "@tianshu/protocol";
import { Pressable, Text, View } from "react-native";
import { Sparkles } from "lucide-react-native";

import { FilePreviewModal } from "@/components/FilePreviewModal";
import { useThemeColors } from "@/store/theme";
import { wireRequest } from "@/transport/wire";

/**
 * user 消息引用技能卡片（[引用技能 name] 前缀段拆出渲染，技能全文不进
 * 气泡）：视觉对齐 MessageFileRef 卡片形态；点击经 skills/read 拉全文弹
 * 层预览（FilePreviewModal loadContent 自定义拉取，与发送注入链同端点
 * 同口径；读取失败走既有 toast+关闭）。技能按名存于被控端技能目录，
 * 读取不依赖工作空间绑定。
 */
export function SkillRefCard({ name }: { name: string }) {
  const { t } = useTranslation("chat");
  const colors = useThemeColors();
  const [previewOpen, setPreviewOpen] = useState(false);
  const loadContent = useCallback(async () => {
    const r = await wireRequest("POST", ENDPOINTS.skills.read, { name });
    const content = r.ok
      ? (r.data as { content?: unknown } | null)?.content
      : undefined;
    return typeof content === "string" ? content : null;
  }, [name]);

  return (
    <>
      <Pressable
        onPress={() => setPreviewOpen(true)}
        accessibilityLabel={t("fileRefView", { name })}
        className="mb-1.5 max-w-[85%] flex-row items-center gap-2 self-end rounded-lg border border-sep bg-white px-3 py-2 dark:border-[#545458A6] dark:bg-neutral-800"
        style={({ pressed }) => ({
          backgroundColor: pressed ? colors.subtle : undefined,
        })}
      >
        <View
          className="h-8 w-8 items-center justify-center rounded-lg"
          style={{ backgroundColor: colors.subtle }}
        >
          <Sparkles size={15} color={colors.primary} />
        </View>
        <View className="min-w-0 flex-1 flex-row items-center gap-2">
          <Text
            numberOfLines={1}
            className="text-sm font-medium text-black dark:text-white"
          >
            {name}
          </Text>
          <View
            className="rounded px-1.5 py-0.5"
            style={{ backgroundColor: colors.subtle }}
          >
            <Text className="text-[10px]" style={{ color: colors.primary }}>
              {t("skillRefBadge")}
            </Text>
          </View>
        </View>
      </Pressable>
      <FilePreviewModal
        path={name}
        workspaceId={null}
        loadContent={loadContent}
        visible={previewOpen}
        onClose={() => setPreviewOpen(false)}
      />
    </>
  );
}

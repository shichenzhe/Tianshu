import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { X } from "lucide-react-native";

import { hasUsableModels } from "@/logic/model-bundle";
import { useProvidersStore } from "@/store/providers.store";
import { useThemeColors } from "@/store/theme";

/**
 * 无模型配置引导条（B5）：会话页输入区上方——活动连接拉取过 providers
 * bundle 且无任何可对话模型（llm + enabled，与 ModelPicker 同口径）时露出。
 * capability 含 provider：点击跳 /providers 配置；无 provider 能力：纯提示
 * 「请到桌面端配置模型」。显隐判据是纯函数（hasUsableModels），bundle 未
 * 拉取/拉取失败时不展示（未知不引导——避免误报）。
 */

interface Props {
  /** 本会话内已关闭（调用方按会话记住） */
  dismissed: boolean;
  /** capability 含 provider：展示「去配置」可点击跳配置页 */
  canConfigure: boolean;
  onDismiss: () => void;
}

export function ModelGuideBar({
  dismissed,
  canConfigure,
  onDismiss,
}: Props) {
  const { t } = useTranslation("chat");
  const colors = useThemeColors();
  const router = useRouter();
  const bundle = useProvidersStore((s) => s.bundle);

  // 未拉取（null）/拉取失败：未知态不引导
  if (dismissed || bundle === null || hasUsableModels(bundle)) return null;

  return (
    <View
      className="mx-3 mb-2 flex-row items-center gap-2 rounded-xl border px-3 py-2"
      style={{
        borderColor: `${colors.primary}33`,
        backgroundColor: colors.subtle,
      }}
    >
      <Text
        numberOfLines={1}
        className="min-w-0 flex-1 text-xs text-label2 dark:text-[#EBEBF599]"
      >
        {t("modelGuideTitle")}
      </Text>
      {canConfigure ? (
        // 嵌套 Pressable 内层夺权——行内其余区域不可点
        <Pressable
          onPress={() => router.push("/providers")}
          hitSlop={6}
          accessibilityLabel={t("modelGuideAction")}
        >
          <Text
            className="text-xs font-medium"
            style={{ color: colors.primary }}
          >
            {t("modelGuideAction")}
          </Text>
        </Pressable>
      ) : (
        <Text className="shrink text-xs text-label3 dark:text-[#EBEBF54D]">
          {t("modelGuideDesktop")}
        </Text>
      )}
      <Pressable
        onPress={onDismiss}
        hitSlop={8}
        accessibilityLabel={t("modelGuideDismiss")}
      >
        <X size={14} color="#8E8E93" />
      </Pressable>
    </View>
  );
}

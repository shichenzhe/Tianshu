import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ENDPOINTS, type SessionUsageBreakdown } from "@tianshu/protocol";
import { Pressable, Text, View } from "react-native";
import { Gauge } from "lucide-react-native";

import { DetailSheet } from "@/components/DetailSheet";
import { useThemeColors } from "@/store/theme";
import { usageShort } from "@/logic/usage-short";
import { wireRequest } from "@/transport/wire";

/**
 * 上下文用量胶囊（MT-T1，对齐桌面 ContextUsageButton）：挂载 + 流收尾
 * 后拉 session/usage（未配模型 null 不渲染）；点击 Alert 展示五类拆解。
 */
export function UsageChip({
  sessionId,
  /** 流收尾信号（变化即重拉——finish/error 后由父级 bump） */
  refreshKey,
}: {
  sessionId: number;
  refreshKey: number;
}) {
  const { t } = useTranslation("chat");
  const colors = useThemeColors();
  const [usage, setUsage] = useState<SessionUsageBreakdown | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await wireRequest("POST", ENDPOINTS.session.usage, { sessionId });
      if (cancelled || !r.ok) return;
      const data = r.data as SessionUsageBreakdown | null;
      if (!cancelled && data != null && typeof data.total === "number") {
        setUsage(data);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshKey]);

  const [open, setOpen] = useState(false);

  if (usage == null) {
    return null; // 未配模型/端点不可用——不占位
  }

  // 五类拆解行（Alert 纯文本拼接已替换为底部面板结构化行）
  const rows: Array<[string, number]> = [
    [t("usageSystem"), usage.system],
    [t("usageTools"), usage.tools],
    [t("usageMessages"), usage.messages],
    [t("usageMcp"), usage.mcp],
    [t("usageSkills"), usage.skills],
  ];

  const ratio =
    usage.contextWindow != null && usage.contextWindow > 0
      ? usage.total / usage.contextWindow
      : null;
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        hitSlop={6}
        className="flex-row items-center gap-1 rounded-md px-1.5 py-1"
        accessibilityLabel={t("usageTitle")}
      >
        <Gauge size={13} color={colors.primary} />
        <Text className="text-[10px]" style={{ color: colors.primary }}>
          {ratio != null ? `${usageShort(usage.total)}/${usageShort(usage.contextWindow!)}` : usageShort(usage.total)}
        </Text>
      </Pressable>
      <DetailSheet
        visible={open}
        title={t("usageTitle")}
        onClose={() => setOpen(false)}
      >
        {rows.map(([label, value]) => (
          <View
            key={label}
            className="flex-row items-center justify-between px-1 py-1.5"
          >
            <Text className="text-sm text-black/70 dark:text-white/70">
              {label}
            </Text>
            <Text className="text-sm text-black dark:text-white">
              {usageShort(value)}
            </Text>
          </View>
        ))}
        <View className="mt-1 border-t border-sep px-1 pt-2 dark:border-[#545458A6]">
          <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
            {usage.contextWindow != null
              ? t("usageWindow", {
                  total: usageShort(usage.total),
                  window: usageShort(usage.contextWindow),
                })
              : t("usageTotal", { total: usageShort(usage.total) })}
          </Text>
        </View>
      </DetailSheet>
    </>
  );
}

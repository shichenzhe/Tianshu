import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ENDPOINTS } from "@tianshu/protocol";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { ShieldAlert } from "lucide-react-native";
import Animated, { SlideInDown } from "react-native-reanimated";

import { tapLight, tapSuccess } from "@/lib/haptics";
import { useThemeColors } from "@/store/theme";
import { wireRequest } from "@/transport/wire";

/** 业务错 code：审批不存在/已应答（双端竞速后到方，或超时已自动拒绝） */
const CODE_NOT_FOUND = "4040";
/** argSummary 硬截上限（防超长摘要撑爆 Banner） */
const SUMMARY_MAX = 200;
/** 审批警示琥珀（语义状态色非主题色，对齐 ToolCallCard 状态色先例） */
const WARN_AMBER = "#f59e0b";

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

interface Props {
  sessionId: number;
  /** 当前待应答项（store live.approvals 队首经父层派发） */
  item: { toolCallId: string; toolName: string; argSummary: string };
  /** 其后仍在排队的审批项数（仅计数展示） */
  queueCount?: number;
  /** 允许并记住可用（审批记住批）：会话绑定工作空间才透出——记忆是
   * 工作空间级 toolPermission 持久行（对齐桌面 workspaceId===null 隐藏） */
  canRemember?: boolean;
  /** 应答成功回调（父层本地标记已应答——队列下一项即刻顶上，不等
   * tool-update chunk 往返） */
  onResponded: () => void;
}

/**
 * 审批 Banner（T15）：manual 模式下 write 类工具挂起流的远程决议入口。
 * 批准/拒绝 → POST session/approve；4040（已被处理——他端先应/超时已拒，
 * 或被控端版本过旧不支持审批应答）内联提示并锁定按键，待 tool-update
 * chunk 出队收口（remote-stream approvals）。
 */
export function ApprovalBanner({
  sessionId,
  item,
  queueCount,
  canRemember = false,
  onResponded,
}: Props) {
  const { t } = useTranslation("chat");
  const colors = useThemeColors();
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);

  async function respond(approved: boolean, remember = false) {
    if (busy || stale) return;
    setBusy(true);
    const r = await wireRequest("POST", ENDPOINTS.session.approve, {
      sessionId,
      toolCallId: item.toolCallId,
      approved,
      // 审批记住批：批准并记忆时上送工具名（被控端归属校验后写
      // toolPermission 持久行）
      ...(remember ? { remember: true, toolName: item.toolName } : {}),
    });
    setBusy(false);
    if (r.ok) {
      onResponded();
      return;
    }
    if (r.code === CODE_NOT_FOUND) {
      // 审批已不在服务端 pending（他端应答/超时拒绝）：提示 + 锁按键，
      // 出队交由随后到达的 tool-update chunk（denied/running）
      setStale(true);
    }
    // 其余业务错/网络层失败：不锁按键（可重试），静默即可——流侧错误
    // 文案已有展示位，Banner 不叠加噪音
  }

  return (
    // 审批到达从下滑入（动效批）——key 按 toolCallId 重建，队列推进自然
    // 重播；className 留内层 View（reanimated 组件不依赖 nativewind 类名）
    <Animated.View
      entering={SlideInDown.duration(200)}
      style={{ marginHorizontal: 12, marginBottom: 8 }}
    >
      <View className="rounded-2xl bg-card px-3 py-2 dark:bg-[#1C1C1E]">
        <View className="flex-row items-center gap-1.5">
          <ShieldAlert size={14} color={WARN_AMBER} />
          <Text className="flex-1 text-xs font-medium text-label2 dark:text-[#EBEBF599]">
            {t("approvalTitle")}
          </Text>
          {queueCount != null && queueCount > 0 && (
            <Text className="text-[10px] text-label3 dark:text-[#EBEBF54D]">
              {t("pendingApprovals", { n: queueCount })}
            </Text>
          )}
        </View>

        <Text className="mt-1 text-xs font-medium text-black/85 dark:text-white/85">
          {item.toolName}
        </Text>
        <Text
          numberOfLines={4}
          className="mt-0.5 text-xs text-black/55 dark:text-white/55"
        >
          {truncate(item.argSummary, SUMMARY_MAX)}
        </Text>

        {stale ? (
          <Text className="mt-1.5 text-xs" style={{ color: WARN_AMBER }}>
            {t("approveUnsupported")}
          </Text>
        ) : busy ? (
          <View className="mt-2 items-center py-1.5">
            <ActivityIndicator size="small" color={colors.primary} />
          </View>
        ) : (
          <View className="mt-2 flex-row gap-2">
            <Pressable
              onPress={() => {
                tapSuccess();
                void respond(true);
              }}
              className="h-9 flex-1 items-center justify-center rounded-lg"
              style={{ backgroundColor: colors.primary }}
            >
              <Text className="text-sm text-white">{t("approve")}</Text>
            </Pressable>
            {canRemember && (
              <Pressable
                onPress={() => {
                  tapSuccess();
                  void respond(true, true);
                }}
                className="h-9 flex-1 items-center justify-center rounded-lg border"
                style={{ borderColor: colors.primary }}
              >
                <Text className="text-sm" style={{ color: colors.primary }}>
                  {t("approveRemember")}
                </Text>
              </Pressable>
            )}
            <Pressable
              onPress={() => {
                tapLight();
                void respond(false);
              }}
              className="h-9 flex-1 items-center justify-center rounded-lg border border-black/15 dark:border-[#545458A6]"
            >
              <Text className="text-sm text-black/70 dark:text-white/70">
                {t("reject")}
              </Text>
            </Pressable>
          </View>
        )}
      </View>
    </Animated.View>
  );
}

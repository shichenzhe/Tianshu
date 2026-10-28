import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { useColorScheme } from "nativewind";
import { Archive, Pin, Trash2 } from "lucide-react-native";
import ReanimatedSwipeable from "react-native-gesture-handler/ReanimatedSwipeable";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";

import { Avatar } from "@/components/Avatar";
import { tapLight } from "@/lib/haptics";
import { lastMessageSummary } from "@/lib/last-message-summary";
import { relativeTimeLabel } from "@/lib/relative-time-label";
import { formatRelative } from "@/logic/time";
import type { SessionBrief } from "@/store/sessions.store";
import { useThemeColors } from "@/store/theme";

interface Props {
  session: SessionBrief;
  /** 搜索态降级摘要（workspace 组名）；缺省时第二行显示相对时间 */
  summary?: string | null;
  /**
   * 组态拍平渲染（性能批）时的圆角/边线定位：first/middle/last/single
   * 由调用方按组内序位传入（拍平后行非 DOM 兄弟，last: 伪类失效）；
   * 缺省 card = 旧行为（卡片容器内兄弟行，靠 last:border-b-0 收尾）
   */
  edge?: "card" | "first" | "middle" | "last" | "single";
  onPress: () => void;
  /** 长按开操作面板（置顶/归档/删除——LA 交互批；Alert 确认已收敛进面板） */
  onLongPress: () => void;
  /** 左滑快捷操作（动效批）：置顶直切；删除/归档经调用方 Alert 确认后
   *  执行（用户裁定——破坏性/隐藏性操作事前确认；长按面板仍是具名入口） */
  onTogglePin: () => void;
  onToggleArchive: () => void;
  onDelete: () => void;
}

/** 快捷钮（gesture-handler RectButton——显式 style，不走 nativewind；
 *  iOS 式纯图标无文字标签，56pt 触控宽） */
import { RectButton } from "react-native-gesture-handler";

function ActionButton({
  Icon,
  color,
  onPress,
}: {
  Icon: typeof Pin;
  color: string;
  onPress: () => void;
}) {
  return (
    <RectButton
      onPress={onPress}
      style={{
        width: 56,
        justifyContent: "center",
        alignItems: "center",
        borderRadius: 8,
        alignSelf: "stretch",
      }}
    >
      <Icon size={19} color={color} />
    </RectButton>
  );
}

/**
 * 会话行（T13）：标题（null 兜底未命名）+ 未读角标（P1）+ 置顶标记 +
 * 相对时间 + 归档徽标 + 末条消息摘要（P1）；左滑露快捷钮（动效批），
 * 原 mb-2 上移外层容器保行距
 */
export function SessionRow({
  session,
  summary,
  edge = "card",
  onPress,
  onLongPress,
  onTogglePin,
  onToggleArchive,
  onDelete,
}: Props) {
  const { t } = useTranslation("chat");
  const colors = useThemeColors();
  const { colorScheme } = useColorScheme();
  const swipeableRef = useRef<SwipeableMethods>(null);
  const closeAnd = (action: () => void) => {
    swipeableRef.current?.close();
    action();
  };
  const pinnedBg = (pressed: boolean) => {
    if (pressed) return colors.subtle;
    if (session.pinnedAt == null) return undefined;
    return colorScheme === "dark" ? "#2C2C2E" : "#F2F2F7";
  };
  // 拍平定位：组首圆顶、组末圆底无细分线、单行独卡；卡片模式维持旧类
  const wrapperClass =
    edge === "card"
      ? "border-b border-sep last:border-b-0 dark:border-[#545458A6]"
      : edge === "first"
        ? "overflow-hidden rounded-t-2xl border-b border-sep dark:border-[#545458A6]"
        : edge === "middle"
          ? "border-b border-sep dark:border-[#545458A6]"
          : edge === "last"
            ? "overflow-hidden rounded-b-2xl"
            : "overflow-hidden rounded-2xl";

  return (
    // GL-P5 左滑修复：hairline 挂行 wrapper（Swipeable 平移内容时边线不
    // 随行扫过操作钮区——真机反馈动画不连贯主因）；ReanimatedSwipeable +
    // spring animationOptions 替旧 Swipeable 线性动画
    <View className={wrapperClass}>
      <ReanimatedSwipeable
        ref={swipeableRef}
        friction={2}
        overshootLeft={false}
        animationOptions={{
          damping: 34,
          stiffness: 300,
          mass: 0.9,
          overshootClamping: false,
        }}
        renderRightActions={() => (
          <View style={{ flexDirection: "row", gap: 4 }}>
            <ActionButton
              Icon={Pin}
              color={colors.primary}
              onPress={() => {
                tapLight();
                closeAnd(onTogglePin);
              }}
            />
            <ActionButton
              Icon={Archive}
              color="#8E8E93"
              onPress={() => {
                tapLight();
                closeAnd(onToggleArchive);
              }}
            />
            <ActionButton
              Icon={Trash2}
              color="#FF3B30"
              onPress={() => {
                tapLight();
                closeAnd(onDelete);
              }}
            />
          </View>
        )}
      >
        {/* GL-P4 卡内行：底/圆角由组卡容器提供；行自身 hairline 在外层
            wrapper（不随滑动平移） */}
        <Pressable
          onPress={onPress}
          onLongPress={onLongPress}
          className="flex-row items-center gap-3 bg-card px-4 py-3 dark:bg-[#1C1C1E]"
          style={({ pressed }) => ({
            backgroundColor: pinnedBg(pressed),
          })}
        >
          <Avatar
            seed={String(session.workspaceId ?? session.id)}
            title={session.title}
          />
          {/* B5 撤销批：归档窗口内行暂存（pendingArchive）——置灰呈现
              「待落定」临时还原态，撤销即恢复，到点行消失 */}
          <View
            className="min-w-0 flex-1"
            style={
              session.pendingArchive === true ? { opacity: 0.45 } : undefined
            }
          >
            <View className="flex-row items-center gap-2">
              <Text
                numberOfLines={1}
                className="flex-1 text-[17px] font-semibold text-black dark:text-white"
              >
                {session.title ?? t("untitled")}
              </Text>
              {/* P1 未读角标批：未读计数点（主色调，≥100 显 99+） */}
              {session.unreadCount > 0 && (
                <View
                  className="rounded-full px-1.5 py-px"
                  style={{ backgroundColor: colors.primary }}
                >
                  <Text className="text-[11px] font-semibold text-white">
                    {session.unreadCount >= 100 ? "99+" : session.unreadCount}
                  </Text>
                </View>
              )}
              <Text className="text-xs text-label3 dark:text-[#EBEBF54D]">
                {relativeTimeLabel(formatRelative(session.updatedAt), t)}
              </Text>
            </View>
            <View className="mt-0.5 flex-row items-center gap-2">
              {session.pinnedAt != null && (
                <Pin size={12} color={colors.primary} />
              )}
              {session.archivedAt != null && (
                <View
                  className="rounded px-1.5 py-0.5"
                  style={{ backgroundColor: colors.subtle }}
                >
                  <Text
                    className="text-xs"
                    style={{ color: colors.primaryActive }}
                  >
                    {t("archived")}
                  </Text>
                </View>
              )}
              <Text
                numberOfLines={1}
                className="flex-1 text-[13px] text-label2 dark:text-[#EBEBF599]"
              >
                {/* P1 未读角标批：有末条摘要时优先展示（kind 映射本地化前缀，
                    截断一行）；否则搜索态组名兜底，缺省相对时间 */}
                {session.lastMessage != null
                  ? lastMessageSummary(session.lastMessage, t)
                  : (summary ??
                    relativeTimeLabel(formatRelative(session.updatedAt), t))}
              </Text>
            </View>
          </View>
        </Pressable>
      </ReanimatedSwipeable>
    </View>
  );
}

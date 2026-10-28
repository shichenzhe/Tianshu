import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ENDPOINTS } from "@tianshu/protocol";
import { Pressable, Text } from "react-native";
import { Bot, MessageCircle, ListChecks } from "lucide-react-native";

import { useThemeColors } from "@/store/theme";
import { wireRequest } from "@/transport/wire";

type SessionMode = "agent" | "ask" | "plan";

const MODE_CYCLE: SessionMode[] = ["agent", "ask", "plan"];

/** 模式图标与 i18n key（对齐桌面 MODES 语义：agent 默认/ask 仅问答/plan 计划） */
const MODE_META: Record<SessionMode, { key: string; Icon: typeof Bot }> = {
  agent: { key: "modeAgent", Icon: Bot },
  ask: { key: "modeAsk", Icon: MessageCircle },
  plan: { key: "modePlan", Icon: ListChecks },
};

/**
 * 会话模式胶囊（MT-T3）：三态轮切（agent→ask→plan→agent）——点击切下一
 * 态并 session/update {mode} 持久（乐观切换，失败回滚静默）。初始态由
 * 调用方从 getById 详情行透传（mode 三值收窄，缺省 agent）。
 */
export function ModeChip({
  sessionId,
  initialMode,
  onModeChange,
}: {
  sessionId: number;
  initialMode: SessionMode;
  onModeChange?: (mode: SessionMode) => void;
}) {
  const { t } = useTranslation("chat");
  const colors = useThemeColors();
  const [mode, setMode] = useState<SessionMode>(initialMode);

  // 挂载竞态修正：胶囊 mount 早于 getById 返回（initialMode 先是缺省
  // agent）——initialMode 后续变化（详情到达/重连重拉对齐真值）时同步；
  // 乐观切换期间父层 entry.sessionMode 不动（update 成功不回写 store），
  // 不会覆盖本地切换
  useEffect(() => {
    setMode(initialMode);
  }, [initialMode]);

  const cycle = useCallback(async () => {
    const next = MODE_CYCLE[(MODE_CYCLE.indexOf(mode) + 1) % MODE_CYCLE.length];
    const prev = mode;
    setMode(next);
    onModeChange?.(next);
    const r = await wireRequest("POST", ENDPOINTS.session.update, {
      sessionId,
      mode: next,
    });
    if (!r.ok) {
      setMode(prev); // 失败回滚（静默——下次进入以服务端真值为准）
      onModeChange?.(prev);
    }
  }, [mode, sessionId, onModeChange]);

  const { key, Icon } = MODE_META[mode];
  return (
    <Pressable
      onPress={() => void cycle()}
      hitSlop={6}
      className="flex-row items-center gap-1 rounded-md px-1.5 py-1"
      style={{ backgroundColor: colors.subtle }}
      accessibilityLabel={t(key)}
    >
      <Icon size={13} color={colors.primary} />
      <Text className="text-[10px]" style={{ color: colors.primary }}>
        {t(key)}
      </Text>
    </Pressable>
  );
}

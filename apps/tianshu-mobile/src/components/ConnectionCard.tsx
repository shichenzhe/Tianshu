import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Text, View } from "react-native";
import { Pencil, Trash, UserRound } from "lucide-react-native";
import { ENDPOINTS } from "@tianshu/protocol";

import { PressableButton } from "@/components/PressableButton";
import { toast } from "@/lib/toast-bus";
import { kebabToPascal } from "@/lib/str";
import {
  testConnection,
  useConnectionsStore,
  type ConnectionConfig,
} from "@/store/connections.store";
import { useThemeColors } from "@/store/theme";
import { ACTION_DANGER } from "@/theme/colors";
import type { TransportState } from "@/transport/types";
import { wireRequest } from "@/transport/wire";

/** 六态 → 色点（语义状态色：绿/黄/红/灰，非主题色，主题切换不变） */
const STATE_DOT: Record<TransportState, string> = {
  connected: "#22c55e",
  reconnecting: "#eab308",
  "invalid-token": "#FF3B30",
  idle: "#8E8E93",
  connecting: "#8E8E93",
  closed: "#8E8E93",
};

interface Props {
  config: ConnectionConfig;
  onEdit: () => void;
  isLast?: boolean;
}

/** 连接卡片（T12）：名称 + mode 标签 + 六态色点/文案 + 使用（激活切换）/测试/编辑/删除 */
export function ConnectionCard({ config, onEdit, isLast = false }: Props) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const active = useConnectionsStore((s) => s.activeConnId) === config.id;
  const state = useConnectionsStore((s) => s.states[config.id]);
  const activate = useConnectionsStore((s) => s.activate);
  const remove = useConnectionsStore((s) => s.remove);
  const [testing, setTesting] = useState(false);
  // 身份面：被控数据归属用户名（token 实例级非用户级——连接管理显示
  // 「控制的是谁」）。活动连接挂载静默 GET info（wireRequest 走活动
  // transport）；非活动连接经测试结果带回
  const [username, setUsername] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void (async () => {
      const r = await wireRequest("GET", ENDPOINTS.info);
      if (cancelled || !r.ok) return;
      const name = (r.data as { username?: unknown } | null)?.username;
      if (!cancelled && typeof name === "string") setUsername(name);
    })();
    return () => {
      cancelled = true;
    };
  }, [active]);

  // 从未激活过的连接无状态记录，按 idle 展示
  const shown: TransportState = state ?? "idle";
  const endpoint =
    (config.mode === "direct" ? config.baseUrl : config.relayUrl) ?? "";

  async function handleTest() {
    if (testing) return;
    setTesting(true);
    const r = await testConnection(config);
    setTesting(false);
    if (r.ok) {
      setUsername(r.info.username ?? null);
      toast.info(t("connections:testOk", { instance: r.info.instanceId }));
    } else {
      toast.error(t(`connections:reason${kebabToPascal(r.reason)}`));
    }
  }

  /** 删除为破坏性操作（含激活实例 teardown），Alert 二次确认 */
  function handleDelete() {
    Alert.alert(
      t("connections:delete"),
      t("connections:deleteConfirm", { name: config.name }),
      [
        { text: t("connections:cancel"), style: "cancel" },
        {
          text: t("connections:delete"),
          style: "destructive",
          onPress: () => remove(config.id),
        },
      ],
      { cancelable: true },
    );
  }

  return (
    <View
      className={`bg-card p-4 dark:bg-[#1C1C1E] ${
        isLast ? "" : "border-b border-sep dark:border-[#545458A6]"
      }`}
    >
      <View className="flex-row items-center">
        <View
          className="mr-2 h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: STATE_DOT[shown] }}
        />
        <Text
          numberOfLines={1}
          className="flex-1 text-base font-medium text-black dark:text-white"
        >
          {config.name}
        </Text>
        <View
          className="rounded px-2 py-0.5"
          style={{ backgroundColor: colors.subtle }}
        >
          <Text className="text-xs" style={{ color: colors.primaryActive }}>
            {config.mode === "direct"
              ? t("connections:modeDirect")
              : t("connections:modeRelay")}
          </Text>
        </View>
      </View>

      <Text
        numberOfLines={1}
        ellipsizeMode="middle"
        className="mt-1 pl-4 text-[13px] text-label2 dark:text-[#EBEBF599]"
      >
        {`${endpoint} · ${t(`connections:state${kebabToPascal(shown)}`)}`}
      </Text>

      {username != null && (
        <View className="mt-1 flex-row items-center gap-1 pl-4">
          <UserRound size={11} color={colors.primary} />
          <Text className="text-[13px]" style={{ color: colors.primary }}>
            {t("connections:controlledUser", { name: username })}
          </Text>
        </View>
      )}

      <View className="mt-3 flex-row flex-wrap items-center gap-2">
        <PressableButton
          label={active ? t("connections:inUse") : t("connections:use")}
          onPress={() => activate(config.id)}
          variant={active ? "tinted" : "filled"}
          size="sm"
          disabled={active}
          selected={active}
        />
        <PressableButton
          label={testing ? t("connections:testing") : t("connections:test")}
          onPress={handleTest}
          variant="outlined"
          size="sm"
          busy={testing}
        />
        <PressableButton
          label={t("connections:edit")}
          onPress={onEdit}
          variant="plain"
          size="sm"
          icon={<Pencil size={12} color="#8E8E93" />}
        />
        <PressableButton
          label={t("connections:delete")}
          onPress={handleDelete}
          variant="danger"
          size="sm"
          icon={<Trash size={12} color={ACTION_DANGER} />}
        />
      </View>
    </View>
  );
}

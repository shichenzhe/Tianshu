import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Pressable, Text, View } from "react-native";
import { Pencil, Trash, UserRound } from "lucide-react-native";
import { ENDPOINTS } from "@tianshu/protocol";

import { toast } from "@/lib/toast-bus";
import { kebabToPascal } from "@/lib/str";
import {
  testConnection,
  useConnectionsStore,
  type ConnectionConfig,
} from "@/store/connections.store";
import { useThemeColors } from "@/store/theme";
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

/** 删除等破坏性操作的标准红 */
const DANGER = "#FF3B30";

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
        <Text className="flex-1 text-base font-medium text-black dark:text-white">
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

      <Text className="mt-1 pl-4 text-xs text-label2 dark:text-[#EBEBF599]">
        {`${endpoint} · ${t(`connections:state${kebabToPascal(shown)}`)}`}
      </Text>

      {username != null && (
        <View className="mt-1 flex-row items-center gap-1 pl-4">
          <UserRound size={11} color={colors.primary} />
          <Text className="text-xs" style={{ color: colors.primary }}>
            {t("connections:controlledUser", { name: username })}
          </Text>
        </View>
      )}

      <View className="mt-3 flex-row items-center gap-2">
        <Pressable
          onPress={() => activate(config.id)}
          disabled={active}
          className="rounded-lg px-3 py-1.5"
          style={{ backgroundColor: active ? colors.subtle : colors.primary }}
        >
          <Text
            className={active ? "text-xs" : "text-xs text-white"}
            style={active ? { color: colors.primaryActive } : undefined}
          >
            {active ? t("connections:inUse") : t("connections:use")}
          </Text>
        </Pressable>
        <Pressable
          onPress={handleTest}
          disabled={testing}
          className="rounded-lg border px-3 py-1.5"
          style={{ borderColor: colors.primary, opacity: testing ? 0.5 : 1 }}
        >
          <Text className="text-xs" style={{ color: colors.primary }}>
            {testing ? t("connections:testing") : t("connections:test")}
          </Text>
        </Pressable>
        <Pressable
          onPress={onEdit}
          className="flex-row items-center gap-1 rounded-lg border border-black/15 px-3 py-1.5 dark:border-[#545458A6]"
        >
          <Pencil size={12} color="#8E8E93" />
          <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
            {t("connections:edit")}
          </Text>
        </Pressable>
        <Pressable
          onPress={handleDelete}
          className="flex-row items-center gap-1 rounded-lg px-3 py-1.5"
          style={{ backgroundColor: `${DANGER}1a` }}
        >
          <Trash size={12} color={DANGER} />
          <Text className="text-xs" style={{ color: DANGER }}>
            {t("connections:delete")}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

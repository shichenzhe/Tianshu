import { useEffect, type ReactNode } from "react";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ShieldCheck } from "lucide-react-native";

import { PageHeader } from "@/components/PageHeader";
import { relativeTimeLabel } from "@/lib/relative-time-label";
import { toast } from "@/lib/toast-bus";
import { formatRelative } from "@/logic/time";
import { useConnectionsStore } from "@/store/connections.store";
import {
  usePermissionStore,
  type PermissionFullGrantRow,
  type PermissionRememberedRow,
} from "@/store/permission.store";
import { useThemeColors } from "@/store/theme";

/** 分组卡（monitor SectionCard 同款骨架）：13px 小组头 + 内容槽 */
function SectionCard({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View className="gap-3 rounded-2xl border border-sep bg-card px-4 py-3 dark:border-[#545458A6] dark:bg-[#1C1C1E]">
      <View className="flex-row items-center">
        <Text className="min-w-0 flex-1 text-[13px] font-medium text-label2 dark:text-[#EBEBF599]">
          {title}
        </Text>
        {action}
      </View>
      {children}
    </View>
  );
}

/** 文本型小操作钮（撤销/全部撤销），primary 着色 */
function TextAction({
  label,
  danger,
  onPress,
}: {
  label: string;
  danger?: boolean;
  onPress: () => void;
}) {
  const colors = useThemeColors();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} hitSlop={8}>
      <Text
        className="text-[13px] font-medium"
        style={{ color: danger ? "#FF3B30" : colors.primary }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** 空态文案（段内居中） */
function EmptyHint({ text }: { text: string }) {
  return (
    <Text className="py-4 text-center text-xs text-label2 dark:text-[#EBEBF599]">
      {text}
    </Text>
  );
}

function RememberedRow({
  row,
  onRevoke,
}: {
  row: PermissionRememberedRow;
  onRevoke: (id: number) => void;
}) {
  const { t } = useTranslation(["permission", "chat"]);
  return (
    <View className="flex-row items-center gap-3 py-2">
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="text-sm text-black dark:text-white">
          {row.workspaceName}
          <Text className="text-label2 dark:text-[#EBEBF599]">
            {" · "}
            {row.toolName}
          </Text>
        </Text>
        <Text className="mt-0.5 text-[11px] text-label3 dark:text-[#EBEBF54D]">
          {relativeTimeLabel(formatRelative(row.createdAt), t)}
        </Text>
      </View>
      <TextAction
        label={t("permission:revoke")}
        onPress={() => onRevoke(row.id)}
      />
    </View>
  );
}

function FullGrantRow({ row }: { row: PermissionFullGrantRow }) {
  const { t } = useTranslation("permission");
  return (
    <View className="flex-row items-center gap-3 py-2">
      <ShieldCheck size={16} color="#30B0C7" />
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="text-sm text-black dark:text-white">
          {row.title}
        </Text>
        <Text className="mt-0.5 text-[11px] text-label3 dark:text-[#EBEBF54D]">
          {t("permission:sessionLabel", { id: row.sessionId })}
        </Text>
      </View>
    </View>
  );
}

/** 审批记忆子页（A10）：已记住的工具（toolPermission 表，行撤销 +
 *  全部撤销）+ 完全授权运行态（全部清空）双段；撤销后本地移除/清空，
 *  不整页重拉。 */
export default function PermissionsScreen() {
  const { t } = useTranslation(["permission", "chat", "common"]);
  const router = useRouter();
  const colors = useThemeColors();
  const activeConnId = useConnectionsStore((s) => s.activeConnId);
  const remembered = usePermissionStore((s) => s.remembered);
  const fullGrants = usePermissionStore((s) => s.fullGrants);
  const loading = usePermissionStore((s) => s.loading);
  const error = usePermissionStore((s) => s.error);
  const load = usePermissionStore((s) => s.load);

  useEffect(() => {
    if (activeConnId) void load();
  }, [activeConnId, load]);

  /** 单条撤销：服务端幂等 no-op 语义，失败仅提示 */
  async function performRevoke(id: number) {
    const ok = await usePermissionStore.getState().revokeRemembered(id);
    if (!ok) toast.warning(t("permission:actionFailed"));
  }

  function confirmRevokeAllRemembered() {
    Alert.alert(
      t("permission:revokeAllConfirmTitle"),
      t("permission:revokeAllConfirmMessage", { count: remembered.length }),
      [
        { text: t("common:cancel"), style: "cancel" },
        {
          text: t("permission:revokeAll"),
          style: "destructive",
          onPress: () => void performRevokeAllRemembered(),
        },
      ],
    );
  }

  async function performRevokeAllRemembered() {
    const revoked = await usePermissionStore.getState().revokeAllRemembered();
    if (revoked === null) toast.warning(t("permission:actionFailed"));
  }

  function confirmClearAllFull() {
    Alert.alert(
      t("permission:clearAllConfirmTitle"),
      t("permission:clearAllConfirmMessage", { count: fullGrants.length }),
      [
        { text: t("common:cancel"), style: "cancel" },
        {
          text: t("permission:clearAll"),
          style: "destructive",
          onPress: () => void performClearAllFull(),
        },
      ],
    );
  }

  async function performClearAllFull() {
    const revoked = await usePermissionStore.getState().revokeAllFull();
    if (revoked === null) toast.warning(t("permission:actionFailed"));
  }

  return (
    <SafeAreaView
      className="flex-1 bg-grouped dark:bg-black"
      edges={["top", "bottom"]}
    >
      <PageHeader
        title={t("permission:title")}
        backLabel={t("permission:back")}
      />
      {!activeConnId ? (
        <View className="flex-1 items-center justify-center gap-3 px-6">
          <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
            {t("chat:noConnection")}
          </Text>
          <Pressable
            onPress={() => router.push("/connections")}
            className="rounded-lg px-4 py-2"
            style={{ backgroundColor: colors.primary }}
          >
            <Text className="text-sm text-white">
              {t("common:nav.toConnections")}
            </Text>
          </Pressable>
        </View>
      ) : loading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      ) : error ? (
        <View className="flex-1 items-center justify-center gap-3 px-6">
          <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
            {t("permission:loadFailed")}
          </Text>
          <Pressable
            onPress={() => void load()}
            className="rounded-lg px-4 py-2"
            style={{ backgroundColor: colors.primary }}
          >
            <Text className="text-sm text-white">{t("chat:retry")}</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView
          className="flex-1"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 16 }}
        >
          <SectionCard
            title={t("permission:rememberedTitle")}
            action={
              remembered.length > 0 ? (
                <TextAction
                  label={t("permission:revokeAll")}
                  danger
                  onPress={confirmRevokeAllRemembered}
                />
              ) : undefined
            }
          >
            {remembered.length === 0 ? (
              <EmptyHint text={t("permission:rememberedEmpty")} />
            ) : (
              <View>
                {remembered.map((row, index) => (
                  <View
                    key={row.id}
                    className={
                      index > 0
                        ? "border-t border-sep dark:border-[#545458A6]"
                        : ""
                    }
                  >
                    <RememberedRow
                      row={row}
                      onRevoke={(id) => void performRevoke(id)}
                    />
                  </View>
                ))}
              </View>
            )}
          </SectionCard>

          <SectionCard
            title={t("permission:fullTitle")}
            action={
              fullGrants.length > 0 ? (
                <TextAction
                  label={t("permission:clearAll")}
                  danger
                  onPress={confirmClearAllFull}
                />
              ) : undefined
            }
          >
            {fullGrants.length === 0 ? (
              <EmptyHint text={t("permission:fullEmpty")} />
            ) : (
              <View>
                {fullGrants.map((row, index) => (
                  <View
                    key={row.sessionId}
                    className={
                      index > 0
                        ? "border-t border-sep dark:border-[#545458A6]"
                        : ""
                    }
                  >
                    <FullGrantRow row={row} />
                  </View>
                ))}
              </View>
            )}
          </SectionCard>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

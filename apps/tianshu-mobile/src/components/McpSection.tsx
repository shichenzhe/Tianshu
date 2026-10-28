import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Pressable, Switch, Text, TextInput, View } from "react-native";
import { PlugZap, Plus, RefreshCw, Trash2 } from "lucide-react-native";
import { REDACTED_SECRET, type McpDetailResult } from "@tianshu/protocol";

import { DialogShell } from "@/components/DialogShell";
import { FormField, PLACEHOLDER } from "@/components/FormField";
import { FormFooter } from "@/components/FormFooter";
import { toast } from "@/lib/toast-bus";
import {
  useConnectionCapabilities,
  useConnectionsStore,
} from "@/store/connections.store";
import {
  pollMcpStatusesTick,
  useMcpConfigStore,
  type McpConfigRow,
} from "@/store/mcp-config.store";
import { useThemeColors } from "@/store/theme";

/** 运行态状态点轮询周期：MCP 进程外部掉线一次性拉取不反映，挂载期轮询补拉 */
const STATUS_POLL_INTERVAL_MS = 15000;

/** 运行态 → 状态点颜色（无运行态旧被控端 → 灰） */
function stateColor(state: string | undefined, enabled: boolean): string {
  if (!enabled) return "#8E8E93";
  switch (state) {
    case "connected":
      return "#34C759";
    case "connecting":
      return "#FFCC00";
    case "error":
      return "#FF3B30";
    default:
      return "#8E8E93";
  }
}

function stateLabelKey(state: string | undefined, enabled: boolean): string {
  if (!enabled) return "mcp:stateDisabled";
  switch (state) {
    case "connected":
      return "mcp:stateConnected";
    case "connecting":
      return "mcp:stateConnecting";
    case "error":
      return "mcp:stateError";
    default:
      return "mcp:stateDisabled";
  }
}

/** 请求头编辑行：masked=详情掩码占位（未动该行按 undefined 保留——
 *  fail-closed 语义），掩码行不允许删除（无法单独清除某个掩码键） */
interface HeaderRow {
  key: string;
  value: string;
  /** 值来自掩码占位（展示「已配置」，保存时省略该行） */
  masked: boolean;
}

function headerRowsFromDetail(detail: McpDetailResult): HeaderRow[] {
  return Object.entries(detail.headers).map(([key, value]) => ({
    key,
    value: value === REDACTED_SECRET ? "" : value,
    masked: value === REDACTED_SECRET,
  }));
}

/**
 * 连接器管理段（A4 批升级）：mcp/query + mcp/statuses 运行态状态点 +
 * toolCount；HTTP 连接器新建/编辑（url + headers 键值编辑，掩码三态——
 * 详情含 REDACTED 占位行显示「已配置」，未动省略/清除全部发 null）；
 * 重连/删除（Alert 二键确认）；stdio 行只读标注「桌面端编辑」（不可创建/
 * 编辑参数——宿主机进程执行面）；启停开关保留（走 store 串行写面，
 * 乐观切换失败回滚）；挂载期 15s 轮询 statuses 刷新运行态状态点（MCP
 * 进程外部掉线一次性拉取不反映）。能力门禁——仅活动连接 capability 含 mcp 时渲染。
 */
export function McpSection() {
  const { t } = useTranslation(["settings", "mcp", "common"]);
  const colors = useThemeColors();
  const activeConnId = useConnectionsStore((s) => s.activeConnId);
  const capabilities = useConnectionCapabilities(activeConnId);
  const mcpCap = capabilities?.includes("mcp") ?? false;
  const rows = useMcpConfigStore((s) => s.rows);
  const initialized = useMcpConfigStore((s) => s.initialized);
  const saving = useMcpConfigStore((s) => s.saving);
  const storeError = useMcpConfigStore((s) => s.error);

  /** 弹层目标：null 关；undefined 新建 HTTP；否则该行详情编辑 */
  const [dialogTarget, setDialogTarget] = useState<
    McpConfigRow | null | undefined
  >(null);

  useEffect(() => {
    if (!mcpCap) return;
    void useMcpConfigStore.getState().load();
  }, [mcpCap, activeConnId]);

  // 运行态状态点轮询（A4 债务清理）：仅可见且已连接（mcpCap 门禁）时装，
  // 卸载清理；App 后台时 RN 的 setInterval 自然节流，不做生命周期处理；
  // 慢响应由 store 的 statusesInFlight 守卫兜底不叠加并发
  useEffect(() => {
    if (!mcpCap || !activeConnId) return;
    const timer = setInterval(pollMcpStatusesTick, STATUS_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [mcpCap, activeConnId]);

  const toastError = useCallback(
    (code: string | null) => {
      const value = code ?? storeError ?? "";
      if (!value) return;
      toast.error(
        t([`mcp:error.${value}`, "mcp:error.fallback"], {
          message: value,
        }),
      );
    },
    [t, storeError],
  );

  // 能力门禁/端点不可用/空清单——整段隐藏（同旧口径）
  if (!mcpCap || !initialized || rows.length === 0) {
    return null;
  }

  const toggle = async (id: number, next: boolean) => {
    const store = useMcpConfigStore.getState();
    store.patchEnabled(id, next);
    const ok = await store.setEnabled(id, next);
    if (!ok) {
      store.patchEnabled(id, !next);
      toastError(null);
    }
  };

  return (
    <View className="gap-2">
      <View className="flex-row items-center px-1">
        <Text className="flex-1 text-xs font-medium text-label3 dark:text-[#EBEBF54D]">
          {t("settings:mcpTitle")}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("mcp:addHttp")}
          onPress={() => setDialogTarget(undefined)}
          hitSlop={8}
        >
          <Plus size={16} color={colors.primary} />
        </Pressable>
      </View>
      <View className="gap-1 rounded-lg border border-sep px-3 py-2 dark:border-[#545458A6]">
        {rows.map((row) => (
          <Pressable
            key={row.id}
            onPress={() => setDialogTarget(row)}
            className="flex-row items-center gap-2 border-b border-black/5 py-2 dark:border-white/10"
          >
            <View
              className="h-2 w-2 rounded-full"
              style={{
                backgroundColor: stateColor(row.status?.state, row.enabled),
              }}
            />
            <PlugZap
              size={13}
              color={row.enabled ? colors.primary : "#8E8E93"}
            />
            <View className="min-w-0 flex-1">
              <Text
                numberOfLines={1}
                className="text-sm text-black dark:text-white"
              >
                {row.name}
              </Text>
              <Text
                numberOfLines={1}
                className="text-xs text-label3 dark:text-[#EBEBF54D]"
              >
                {row.status
                  ? `${t(stateLabelKey(row.status.state, row.enabled))}${
                      row.status.toolCount > 0
                        ? ` · ${t("mcp:toolsCount", { count: row.status.toolCount })}`
                        : ""
                    }${row.status.error ? ` · ${row.status.error}` : ""}`
                  : (row.url ?? row.command ?? row.transport)}
              </Text>
            </View>
            <Switch
              value={row.enabled}
              trackColor={{ true: colors.primary }}
              onValueChange={(next) => void toggle(row.id, next)}
            />
          </Pressable>
        ))}
        <Text className="pt-1 text-xs text-label3 dark:text-[#EBEBF54D]">
          {t("mcp:manageHint")}
        </Text>
      </View>
      {dialogTarget !== null && (
        <McpEditDialog
          target={dialogTarget}
          busy={saving}
          onClose={() => setDialogTarget(null)}
          onError={toastError}
        />
      )}
    </View>
  );
}

/** HTTP 新建/编辑 + stdio 只读摘要弹层 */
function McpEditDialog({
  target,
  busy,
  onClose,
  onError,
}: {
  target: McpConfigRow | null | undefined;
  busy: boolean;
  onClose: () => void;
  onError: (code: string | null) => void;
}) {
  const { t } = useTranslation(["mcp", "common"]);
  const colors = useThemeColors();
  const isNew = target === undefined;
  const isStdio = target?.transport === "stdio";
  const [name, setName] = useState(target?.name ?? "");
  const [url, setUrl] = useState(target?.url ?? "");
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>([]);
  const [clearHeaders, setClearHeaders] = useState(false);
  const [detailReady, setDetailReady] = useState(isNew || isStdio);

  // 编辑态先拉详情（headers 掩码形状经 mcp/detail）
  useEffect(() => {
    if (isNew || !target) return;
    let cancelled = false;
    void useMcpConfigStore
      .getState()
      .loadDetail(target.id)
      .then((detail) => {
        if (cancelled) return;
        if (!detail) {
          onError(null);
          onClose();
          return;
        }
        setName(detail.name);
        setUrl(detail.url ?? "");
        setHeaderRows(headerRowsFromDetail(detail));
        setDetailReady(true);
      });
    return () => {
      cancelled = true;
    };
    // 仅挂载时执行一次（target 行在弹层打开期间不变）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const urlValid = url.trim() === "" || /^https?:\/\//i.test(url.trim());
  const confirmDisabled =
    name.trim() === "" || url.trim() === "" || !urlValid || !detailReady;

  async function handleSave() {
    const headers = (() => {
      if (clearHeaders) return null;
      const editable = headerRows.filter(
        (row) => row.key.trim() !== "" && !row.masked,
      );
      // 仅剩掩码行（或全空）= 未触碰 → undefined 保留
      if (editable.length === 0) return undefined;
      return Object.fromEntries(
        editable.map((row) => [row.key.trim(), row.value]),
      );
    })();
    const ok = await useMcpConfigStore.getState().saveHttp({
      ...(isNew || !target ? {} : { id: target.id }),
      name: name.trim(),
      url: url.trim(),
      headers,
    });
    if (ok) onClose();
    else onError(null);
  }

  function confirmDelete() {
    if (!target) return;
    Alert.alert(
      t("mcp:delete"),
      t("mcp:confirmDelete", { name: target.name }),
      [
        { text: t("common:cancel"), style: "cancel" },
        {
          text: t("mcp:delete"),
          style: "destructive",
          onPress: () => void performDelete(),
        },
      ],
    );
  }

  async function performDelete() {
    if (!target) return;
    const ok = await useMcpConfigStore.getState().remove(target.id);
    if (ok) onClose();
    else onError(null);
  }

  async function handleReconnect() {
    if (!target) return;
    const ok = await useMcpConfigStore.getState().reconnect(target.id);
    if (!ok) onError(null);
  }

  const updateHeaderRow = (index: number, patch: Partial<HeaderRow>) => {
    setHeaderRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  };

  return (
    <DialogShell
      title={t(isNew ? "mcp:addHttp" : isStdio ? "mcp:title" : "mcp:editHttp")}
      busy={busy}
      onClose={onClose}
      footer={
        <FormFooter
          busy={busy}
          confirmDisabled={isStdio ? true : confirmDisabled}
          onConfirm={() => void handleSave()}
          onCancel={onClose}
          deleteLabel={t("mcp:delete")}
          onDelete={confirmDelete}
        />
      }
    >
      {isStdio ? (
        <>
          <FormField
            label={t("mcp:name")}
            value={name}
            onChangeText={setName}
            editable={false}
          />
          <FormField
            label={t("mcp:url")}
            value={target?.command ?? ""}
            onChangeText={() => {}}
            editable={false}
          />
          <Text className="text-xs leading-4 text-label2 dark:text-[#EBEBF599]">
            {t("mcp:stdioReadonly")}
          </Text>
          <Pressable
            onPress={() => void handleReconnect()}
            disabled={busy}
            className="flex-row items-center gap-2 rounded-lg border border-sep px-3 py-2.5 dark:border-[#545458A6]"
          >
            <RefreshCw size={14} color={colors.primary} />
            <Text className="text-sm" style={{ color: colors.primary }}>
              {t("mcp:reconnect")}
            </Text>
          </Pressable>
        </>
      ) : (
        <>
          <FormField
            label={t("mcp:name")}
            value={name}
            onChangeText={setName}
            placeholder={t("mcp:nameRequired")}
          />
          <FormField
            label={t("mcp:url")}
            value={url}
            onChangeText={setUrl}
            placeholder={t("mcp:urlRequired")}
          />
          {!urlValid && (
            <Text className="text-xs text-[#FF3B30]">
              {t("mcp:urlInvalid")}
            </Text>
          )}
          <View className="gap-1.5">
            <View className="flex-row items-center justify-between">
              <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
                {t("mcp:headers")}
              </Text>
              <View className="flex-row items-center gap-1.5">
                <Switch
                  value={clearHeaders}
                  onValueChange={setClearHeaders}
                  trackColor={{ true: colors.primary }}
                />
                <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
                  {t("mcp:headersClear")}
                </Text>
              </View>
            </View>
            {!clearHeaders && (
              <>
                {headerRows.map((row, index) => (
                  <View key={index} className="flex-row items-center gap-2">
                    <View className="min-w-0 flex-1">
                      <TextInput
                        value={row.key}
                        onChangeText={(value: string) =>
                          updateHeaderRow(index, { key: value })
                        }
                        placeholder={t("mcp:headerKey")}
                        placeholderTextColor={PLACEHOLDER}
                        autoCapitalize="none"
                        autoCorrect={false}
                        editable={!row.masked}
                        className="rounded-lg border border-sep bg-field px-3 py-2 text-sm text-black dark:border-[#545458A6] dark:bg-[#2C2C2E] dark:text-white"
                      />
                    </View>
                    <View className="min-w-0 flex-1">
                      <TextInput
                        value={row.value}
                        onChangeText={(value: string) =>
                          updateHeaderRow(index, { value, masked: false })
                        }
                        placeholder={
                          row.masked
                            ? t("mcp:headerConfigured")
                            : t("mcp:headerValue")
                        }
                        placeholderTextColor={PLACEHOLDER}
                        autoCapitalize="none"
                        autoCorrect={false}
                        className="rounded-lg border border-sep bg-field px-3 py-2 text-sm text-black dark:border-[#545458A6] dark:bg-[#2C2C2E] dark:text-white"
                      />
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      disabled={row.masked}
                      onPress={() =>
                        setHeaderRows((prev) =>
                          prev.filter((_, i) => i !== index),
                        )
                      }
                      hitSlop={8}
                      style={{ opacity: row.masked ? 0.3 : 1 }}
                    >
                      <Trash2 size={16} color="#FF3B30" />
                    </Pressable>
                  </View>
                ))}
                <Pressable
                  onPress={() =>
                    setHeaderRows((prev) => [
                      ...prev,
                      { key: "", value: "", masked: false },
                    ])
                  }
                  hitSlop={8}
                  className="flex-row items-center gap-1.5"
                >
                  <Plus size={14} color={colors.primary} />
                  <Text className="text-xs" style={{ color: colors.primary }}>
                    {t("mcp:headerAdd")}
                  </Text>
                </Pressable>
              </>
            )}
          </View>
          {!isNew && target && (
            <Pressable
              onPress={() => void handleReconnect()}
              disabled={busy}
              className="flex-row items-center gap-2 rounded-lg border border-sep px-3 py-2.5 dark:border-[#545458A6]"
            >
              <RefreshCw size={14} color={colors.primary} />
              <Text className="text-sm" style={{ color: colors.primary }}>
                {t("mcp:reconnect")}
              </Text>
            </Pressable>
          )}
        </>
      )}
    </DialogShell>
  );
}

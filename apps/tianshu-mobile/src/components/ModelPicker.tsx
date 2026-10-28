import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { Check, ChevronDown } from "lucide-react-native";

import {
  modelLabel,
  parseProviderBundle,
  type ProviderBundle,
} from "@/logic/model-bundle";
import { useConnectionCapabilities, useConnectionsStore } from "@/store/connections.store";
import { useProvidersStore } from "@/store/providers.store";
import { useThemeColors } from "@/store/theme";

interface Props {
  /** 当前选中模型 id（会话页 state；null = 未选） */
  modelId: number | null;
  onPick: (modelId: number) => void;
}

/** 模型选择胶囊（T15，M2b 改造）：会话页头部——capability 门禁自吃
 * connections 层缓存（server.connected 写入，activeConnId null/未知均视为
 * 无能力灰胶囊，页面不再自管 GET info 直查+事件刷新）；点击弹层按服务商
 * 分组选模型，选中回调会话页 state（startSend 带 modelId）。
 * B5：bundle 缓存收编 providers.store（无模型引导条/消息模型名反查共用
 * 同一拉取——单次 provider/query 多端复用，不再组件内自管 wire 请求） */
export function ModelPicker({ modelId, onPick }: Props) {
  const { t } = useTranslation("chat");
  const colors = useThemeColors();
  const activeConnId = useConnectionsStore((s) => s.activeConnId);
  const capabilities = useConnectionCapabilities(activeConnId);
  /** capabilities 含 provider 才可点（无则 noModel 灰胶囊） */
  const enabled = capabilities?.includes("provider") ?? false;
  const [open, setOpen] = useState(false);
  const storeBundle = useProvidersStore((s) => s.bundle);
  const storeLoading = useProvidersStore((s) => s.loading);
  const storeError = useProvidersStore((s) => s.error);
  const load = useProvidersStore((s) => s.load);

  // store 行是 wire 判别后的超集——parseProviderBundle 直接消费（分组 +
  // llm/enabled 过滤同口径）；null = 未拉取（加载中/失败/未触发）
  const bundle: ProviderBundle | null = useMemo(
    () => (storeBundle !== null ? parseProviderBundle(storeBundle) : null),
    [storeBundle],
  );
  /** 失败仅判「无缓存且有错」（写操作错不冤杀已缓存弹层） */
  const failed = storeError !== null && bundle === null;
  const loading = storeLoading && bundle === null;

  // 首开拉取 + 已选预拉：open 且未缓存时触发一次；已选模型（modelId 非
  // null）enabled 即挂载静默预拉——否则胶囊 label 退化显示「选择模型」；
  // 会话页无模型探测通常已先行（store 缓存命中即零请求）
  useEffect(() => {
    if (storeBundle !== null) return;
    if (open || (enabled && modelId != null)) void load();
  }, [open, storeBundle, enabled, modelId, load]);

  const selected =
    modelId !== null ? (bundle?.models.find((m) => m.id === modelId) ?? null) : null;
  const label = !enabled
    ? t("noModel")
    : selected !== null
      ? modelLabel(selected)
      : t("selectModel");

  return (
    <>
      <Pressable
        disabled={!enabled}
        onPress={() => setOpen(true)}
        className="flex-row items-center gap-1 rounded-full border px-2.5 py-1"
        style={{
          borderColor: enabled ? colors.primary : "rgba(120,120,128,0.3)",
          backgroundColor: enabled ? colors.subtle : "transparent",
          opacity: enabled ? 1 : 0.55,
        }}
      >
        <Text
          numberOfLines={1}
          className="max-w-32 text-xs"
          style={{ color: enabled ? colors.primary : "#8E8E93" }}
        >
          {label}
        </Text>
        <ChevronDown size={12} color={enabled ? colors.primary : "#8E8E93"} />
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable
          className="flex-1 justify-center bg-black/60 px-6"
          onPress={() => setOpen(false)}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            className="max-h-[70%] rounded-xl bg-white p-4 dark:bg-neutral-900"
          >
            <Text className="mb-2 text-sm font-medium text-black dark:text-white">
              {t("selectModel")}
            </Text>

            {loading ? (
              <View className="items-center py-8">
                <ActivityIndicator size="small" color={colors.primary} />
              </View>
            ) : failed ? (
              <View className="items-center gap-3 py-6">
                <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
                  {t("modelLoadFailed")}
                </Text>
                <Pressable
                  onPress={() => void load()}
                  className="rounded-lg px-4 py-1.5"
                  style={{ backgroundColor: colors.primary }}
                >
                  <Text className="text-xs text-white">{t("retry")}</Text>
                </Pressable>
              </View>
            ) : bundle !== null && bundle.groups.length === 0 ? (
              <Text className="py-6 text-center text-xs text-label2 dark:text-[#EBEBF599]">
                {t("noModels")}
              </Text>
            ) : (
              <ScrollView className="grow-0">
                {bundle?.groups.map((group) => (
                  <View key={group.provider.id} className="mb-2">
                    <Text className="px-1 py-1 text-[10px] uppercase text-label3 dark:text-[#EBEBF54D]">
                      {group.provider.name}
                    </Text>
                    {group.models.map((model) => {
                      const active = model.id === modelId;
                      return (
                        <Pressable
                          key={model.id}
                          onPress={() => {
                            onPick(model.id);
                            setOpen(false);
                          }}
                          className="flex-row items-center justify-between rounded-lg px-3 py-2.5"
                          style={active ? { backgroundColor: colors.subtle } : undefined}
                        >
                          <Text
                            numberOfLines={1}
                            className="flex-1 text-sm text-black dark:text-white"
                            style={active ? { color: colors.primary } : undefined}
                          >
                            {modelLabel(model)}
                          </Text>
                          {active && <Check size={16} color={colors.primary} />}
                        </Pressable>
                      );
                    })}
                  </View>
                ))}
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

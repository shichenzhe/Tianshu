import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ENDPOINTS } from "@tianshu/protocol";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  Text,
  View,
} from "react-native";
import { Check, X, Zap } from "lucide-react-native";

import { useThemeColors } from "@/store/theme";
import { wireRequest } from "@/transport/wire";

/** skills/query 行子集（移动端只消费引用面——enabled 语义过滤） */
interface SkillRefRow {
  name: string;
  description: string | null;
  enabled: boolean;
}

/**
 * 技能引用选择器（功能对齐批，对齐 PC @技能 token 语义）：skills/query
 * 清单多选（仅 enabled 可选——禁用对模型=不存在）→ 选中技能名回传调用
 * 方（发送时 skills/read 读全文以 [引用技能] 前缀并入消息文本）。端点
 * 失败显示错误态可重试；被控端无技能面时入口由调用方隐藏（拉取空）。
 */
export function SkillRefPicker({
  visible,
  selected,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  selected: string[];
  onClose: () => void;
  onConfirm: (names: string[]) => void;
}) {
  const { t } = useTranslation("chat");
  const colors = useThemeColors();
  const [rows, setRows] = useState<SkillRefRow[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [checked, setChecked] = useState<string[]>(selected);

  useEffect(() => {
    if (!visible) return;
    setChecked(selected);
    let cancelled = false;
    void (async () => {
      setRows(null);
      setLoadError(false);
      const r = await wireRequest("POST", ENDPOINTS.skills.query, {});
      if (cancelled) return;
      if (r.ok && Array.isArray(r.data)) {
        setRows(
          r.data
            .map((s: { name?: unknown; description?: unknown; enabled?: unknown }) =>
              typeof s?.name === "string"
                ? {
                    name: s.name,
                    description: typeof s.description === "string" ? s.description : null,
                    enabled: s?.enabled !== false,
                  }
                : null,
            )
            .filter((s: SkillRefRow | null): s is SkillRefRow => s !== null),
        );
      } else {
        setLoadError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // selected 不进 deps：打开时快照即可（关闭即弃），编辑中变化无意义
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const toggle = (name: string) => {
    setChecked((prev) =>
      prev.includes(name) ? prev.filter((p) => p !== name) : [...prev, name],
    );
  };

  const retry = () => {
    setRows(null);
    setLoadError(false);
    void wireRequest("POST", ENDPOINTS.skills.query, {})
      .then((r) => {
        if (r.ok && Array.isArray(r.data)) {
          setRows(
            r.data
              .map((s: { name?: unknown; description?: unknown; enabled?: unknown }) =>
                typeof s?.name === "string"
                  ? {
                      name: s.name,
                      description: typeof s.description === "string" ? s.description : null,
                      enabled: s?.enabled !== false,
                    }
                  : null,
              )
              .filter((s: SkillRefRow | null): s is SkillRefRow => s !== null),
          );
        } else {
          setLoadError(true);
        }
      });
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View className="flex-1 bg-white pt-12 dark:bg-black">
        <View className="flex-row items-center justify-between px-4 pb-2">
          <Text className="text-base font-semibold text-black dark:text-white">
            {t("pickSkillRef")}
          </Text>
          <Pressable onPress={onClose} hitSlop={8}>
            <X size={20} color="#8E8E93" />
          </Pressable>
        </View>
        {rows == null && !loadError && (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator size="small" color="#8E8E93" />
          </View>
        )}
        {loadError && (
          <View className="flex-1 items-center justify-center gap-3 px-4">
            <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
              {t("skillRefLoadFailed")}
            </Text>
            <Pressable
              onPress={retry}
              className="rounded-lg px-4 py-2"
              style={{ backgroundColor: colors.primary }}
            >
              <Text className="text-sm text-white">{t("retry")}</Text>
            </Pressable>
          </View>
        )}
        <FlatList
          data={rows ?? []}
          keyExtractor={(item) => item.name}
          contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 16 }}
          ListEmptyComponent={
            rows != null ? (
              <View className="flex-1 items-center justify-center px-4">
                <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
                  {t("skillRefEmpty")}
                </Text>
              </View>
            ) : null
          }
          renderItem={({ item }) => {
            const on = checked.includes(item.name);
            return (
              <Pressable
                onPress={() => item.enabled && toggle(item.name)}
                className="border-b border-black/5 py-3 dark:border-white/10"
                style={!item.enabled ? { opacity: 0.4 } : undefined}
              >
                <View className="flex-row items-center gap-2">
                  <Zap
                    size={15}
                    color={item.enabled ? colors.primary : "#8E8E93"}
                  />
                  <Text
                    numberOfLines={1}
                    className="flex-1 text-sm text-black dark:text-white"
                  >
                    {item.name}
                  </Text>
                  {on && <Check size={16} color={colors.primary} />}
                </View>
                {item.description != null && (
                  <Text
                    numberOfLines={2}
                    className="mt-0.5 pl-5 text-xs text-label2 dark:text-[#EBEBF599]"
                  >
                    {item.description}
                  </Text>
                )}
              </Pressable>
            );
          }}
        />
        <View className="border-t border-sep px-4 py-3 dark:border-[#545458A6]">
          <Pressable
            onPress={() => onConfirm(checked)}
            className="items-center rounded-lg py-2.5"
            style={{ backgroundColor: colors.primary }}
          >
            <Text className="text-sm text-white">
              {t("skillRefConfirm", { count: checked.length })}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";
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
import { Bot, Check, X } from "lucide-react-native";

import { useConnectionsStore } from "@/store/connections.store";
import { useThemeColors } from "@/store/theme";
import { wireRequest } from "@/transport/wire";

/** assistant/query 行子集（远端专家概要——bot 头像列不消费；quickPrompts
 *  功能对齐批起消费：选中专家的快捷提示经 onPromptsChange 透出） */
export interface AssistantBriefRow {
  id: number;
  name: string;
  quickPrompts: string[];
}

/**
 * 专家选择胶囊（MT-T2，对齐桌面＋菜单 ExpertSubMenu 语义）：点击弹
 * assistant/query 清单单选；选中 assistantId 回传（请求级覆盖随
 * startSend 携带——sessionSend 写回会话当前值）。端点失败/清空时胶囊
 * 隐藏；「不选专家」项清空选择。
 */
export function ExpertChip({
  selectedId,
  onPick,
  onPromptsChange,
}: {
  selectedId: number | null;
  onPick: (assistantId: number | null) => void;
  /** 选中专家快捷提示透出（对齐 PC quickPrompts 填入草稿）：选中变化/
   *  清单到达时回调；未选中或无提示为空表 */
  onPromptsChange?: (prompts: string[]) => void;
}) {
  const { t } = useTranslation("chat");
  const colors = useThemeColors();
  const activeConnId = useConnectionsStore((s) => s.activeConnId);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<AssistantBriefRow[] | null>(null);

  // 拉专家概要：挂载/切连接各一次（选中变化不重拉——选中名自本地 rows
  // 派生，修复点：旧实现 effect 依赖 selectedId，每次选中/取消都全量重发
  // assistant/query）
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await wireRequest("POST", ENDPOINTS.assistant.query, {});
      if (cancelled) return;
      if (r.ok && Array.isArray(r.data)) {
        setRows(
          r.data
            .map((a: { id?: unknown; name?: unknown; quickPrompts?: unknown }) =>
              typeof a?.id === "number" && typeof a?.name === "string"
                ? {
                    id: a.id,
                    name: a.name,
                    quickPrompts: Array.isArray(a.quickPrompts)
                      ? a.quickPrompts.filter(
                          (p: unknown): p is string => typeof p === "string",
                        )
                      : [],
                  }
                : null,
            )
            .filter(
              (a: AssistantBriefRow | null): a is AssistantBriefRow => a !== null,
            ),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeConnId]);

  /** 选中态胶囊文案（rows 就绪前仅图标） */
  const selectedName = useMemo(
    () =>
      rows != null && selectedId != null
        ? (rows.find((a) => a.id === selectedId)?.name ?? null)
        : null,
    [rows, selectedId],
  );

  /** 选中专家快捷提示透出（功能对齐批）：rows/选中变化即回调 */
  const prompts = useMemo(
    () =>
      rows != null && selectedId != null
        ? (rows.find((a) => a.id === selectedId)?.quickPrompts ?? [])
        : [],
    [rows, selectedId],
  );
  useEffect(() => {
    onPromptsChange?.(prompts);
  }, [prompts, onPromptsChange]);

  const pick = useCallback(
    (id: number | null) => {
      onPick(id);
      setOpen(false);
    },
    [onPick],
  );

  if (rows != null && rows.length === 0) {
    return null; // 被控端无专家——不占位
  }

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        hitSlop={6}
        className="flex-row items-center gap-1 rounded-md px-1.5 py-1"
        style={{ backgroundColor: selectedId != null ? colors.subtle : "transparent" }}
        accessibilityLabel={t("expertPick")}
      >
        <Bot size={13} color={selectedId != null ? colors.primary : "#8E8E93"} />
        {selectedName != null && (
          <Text
            numberOfLines={1}
            className="max-w-24 text-[10px]"
            style={{ color: selectedId != null ? colors.primary : "#8E8E93" }}
          >
            {selectedName}
          </Text>
        )}
      </Pressable>

      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <View className="flex-1 bg-white pt-12 dark:bg-black">
          <View className="flex-row items-center justify-between px-4 pb-2">
            <Text className="text-base font-semibold text-black dark:text-white">
              {t("expertPick")}
            </Text>
            <Pressable onPress={() => setOpen(false)} hitSlop={8}>
              <X size={20} color="#8E8E93" />
            </Pressable>
          </View>
          {rows == null ? (
            <View className="flex-1 items-center justify-center">
              <ActivityIndicator size="small" color="#8E8E93" />
            </View>
          ) : (
            <FlatList
              data={rows}
              keyExtractor={(item) => String(item.id)}
              contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 16 }}
              ListHeaderComponent={
                <Pressable
                  onPress={() => pick(null)}
                  className="flex-row items-center justify-between border-b border-black/5 py-3 dark:border-white/10"
                >
                  <Text className="text-sm text-black dark:text-white">
                    {t("expertNone")}
                  </Text>
                  {selectedId == null && <Check size={16} color={colors.primary} />}
                </Pressable>
              }
              renderItem={({ item }) => (
                <Pressable
                  onPress={() => pick(item.id)}
                  className="flex-row items-center justify-between border-b border-black/5 py-3 dark:border-white/10"
                >
                  <Text className="flex-1 text-sm text-black dark:text-white">
                    {item.name}
                  </Text>
                  {selectedId === item.id && (
                    <Check size={16} color={colors.primary} />
                  )}
                </Pressable>
              )}
            />
          )}
        </View>
      </Modal>
    </>
  );
}

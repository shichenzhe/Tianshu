import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ENDPOINTS } from "@tianshu/protocol";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { Check, FileText, Search, X } from "lucide-react-native";

import { useThemeColors } from "@/store/theme";
import { wireRequest } from "@/transport/wire";

/**
 * 文件引用选择器（LT-T4）：files/list 清单（本地过滤搜索）多选 → 选中
 * 路径回传调用方（发送时 filesRead 读内容拼前缀注入——对齐桌面注入
 * 语义）。files 能力门禁由调用方（Composer 按钮）把守；端点失败显示
 * 错误态可重试。
 */
export function FileRefPicker({
  visible,
  workspaceId,
  selected,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  /** 当前会话工作空间（files/list 入参）；缺省不可拉 */
  workspaceId: number | null;
  selected: string[];
  onClose: () => void;
  onConfirm: (paths: string[]) => void;
}) {
  const { t } = useTranslation("chat");
  const colors = useThemeColors();
  const [files, setFiles] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [checked, setChecked] = useState<string[]>(selected);

  useEffect(() => {
    if (!visible) return;
    setChecked(selected);
    let cancelled = false;
    void (async () => {
      setFiles(null);
      setLoadError(false);
      // 无工作空间：终态提示（非加载失败——重试必败，不给重试按钮）
      if (workspaceId == null) return;
      const r = await wireRequest("POST", ENDPOINTS.files.list, { workspaceId });
      if (cancelled) return;
      if (r.ok && Array.isArray(r.data)) {
        setFiles(r.data.filter((f): f is string => typeof f === "string"));
      } else {
        setLoadError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, workspaceId]);

  const filtered = useMemo(() => {
    if (files == null) return [];
    const kw = keyword.trim().toLowerCase();
    return kw ? files.filter((f) => f.toLowerCase().includes(kw)) : files;
  }, [files, keyword]);

  const toggle = (path: string) => {
    setChecked((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path],
    );
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View className="flex-1 bg-white pt-12 dark:bg-black">
        <View className="flex-row items-center justify-between px-4 pb-2">
          <Text className="text-base font-semibold text-black dark:text-white">
            {t("pickFileRef")}
          </Text>
          <Pressable onPress={onClose} hitSlop={8}>
            <X size={20} color="#8E8E93" />
          </Pressable>
        </View>
        <View className="mx-4 mb-2 flex-row items-center gap-2 rounded-lg border border-sep px-3 py-2 dark:border-[#545458A6]">
          <Search size={14} color="#8E8E93" />
          <TextInput
            value={keyword}
            onChangeText={setKeyword}
            placeholder={t("searchPlaceholder")}
            placeholderTextColor="#8E8E93"
            autoCorrect={false}
            className="flex-1 text-sm text-black dark:text-white"
          />
        </View>
        {workspaceId == null && (
          <View className="flex-1 items-center justify-center px-4">
            <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
              {t("fileRefNoWorkspace")}
            </Text>
          </View>
        )}
        {workspaceId != null && files == null && !loadError && (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator size="small" color="#8E8E93" />
          </View>
        )}
        {loadError && (
          <View className="flex-1 items-center justify-center gap-3 px-4">
            <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
              {t("fileRefLoadFailed")}
            </Text>
            <Pressable
              onPress={() => {
                setFiles(null);
                setLoadError(false);
                void wireRequest("POST", ENDPOINTS.files.list, {
                  workspaceId,
                }).then((r) => {
                  if (r.ok && Array.isArray(r.data)) {
                    setFiles(
                      r.data.filter((f): f is string => typeof f === "string"),
                    );
                  } else {
                    setLoadError(true);
                  }
                });
              }}
              className="rounded-lg px-4 py-2"
              style={{ backgroundColor: colors.primary }}
            >
              <Text className="text-sm text-white">{t("retry")}</Text>
            </Pressable>
          </View>
        )}
        <FlatList
          data={filtered}
          keyExtractor={(item) => item}
          contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 16 }}
          ListEmptyComponent={
            files != null ? (
              <View className="flex-1 items-center justify-center px-4">
                <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
                  {t("fileRefEmpty")}
                </Text>
              </View>
            ) : null
          }
          renderItem={({ item }) => {
            const on = checked.includes(item);
            return (
              <Pressable
                onPress={() => toggle(item)}
                className="flex-row items-center gap-2 border-b border-black/5 py-3 dark:border-white/10"
              >
                <FileText size={15} color="#8E8E93" />
                <Text
                  numberOfLines={1}
                  className="flex-1 text-sm text-black dark:text-white"
                >
                  {item}
                </Text>
                {on && <Check size={16} color={colors.primary} />}
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
              {t("fileRefConfirm", { count: checked.length })}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

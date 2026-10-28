// 本地产物视图（AR 批）：library 页「本地产物」段——workspace 分组列表 +
// 收藏星（乐观翻转）+ 行点击预览（text 全屏只读 / image dataUrl，弹层由
// library 页统一挂载）。unsupported（无头端被控端，HTTP 404 判端点缺失）
// 时视图层不渲染本段入口。列表拍平渲染（组头行 + 条目行同数组——RN
// 折叠组拍平虚拟化铁律；行级 memo）。
import { memo, useEffect, useMemo } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { Star } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { ArtifactWireItem } from "@tianshu/protocol";
import { useArtifactStore } from "@/store/artifact.store";
import { useThemeColors } from "@/store/theme";
import { formatRelative } from "@/logic/time";
import { relativeTimeLabel } from "@/lib/relative-time-label";
import { formatSize } from "@/lib/format-size";

/** 拍平条目：组头或产物行 */
type Entry =
  | { type: "group"; key: string; name: string }
  | { type: "item"; key: string; item: ArtifactWireItem };

export function ArtifactSection({
  onOpenPreview,
}: {
  onOpenPreview: (item: ArtifactWireItem) => void;
}) {
  const { t } = useTranslation(["library", "common"]);
  const colors = useThemeColors();
  const rows = useArtifactStore((s) => s.rows);
  const loading = useArtifactStore((s) => s.loading);
  const error = useArtifactStore((s) => s.error);
  const initialized = useArtifactStore((s) => s.initialized);
  const toggleFavorite = useArtifactStore((s) => s.toggleFavorite);

  useEffect(() => {
    if (!initialized) void useArtifactStore.getState().load();
  }, [initialized]);

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    let currentGroup = "";
    for (const item of rows) {
      if (item.workspaceName !== currentGroup) {
        currentGroup = item.workspaceName;
        out.push({
          type: "group",
          key: `g-${item.workspaceId}`,
          name: item.workspaceName,
        });
      }
      out.push({
        type: "item",
        key: `${item.workspaceId}:${item.relPath}`,
        item,
      });
    }
    return out;
  }, [rows]);

  if (loading && !initialized) {
    return (
      <View className="flex-1 items-center justify-center gap-2 py-10">
        <ActivityIndicator color={colors.primary} />
        <Text className="text-sm text-label3">{t("common:loading")}</Text>
      </View>
    );
  }
  if (error) {
    return (
      <View className="flex-1 items-center gap-2 py-10">
        <Text className="text-sm text-red-500">
          {t("library:artifactLoadFailed")}
        </Text>
        <Pressable
          onPress={() => void useArtifactStore.getState().load(true)}
          className="rounded-md border border-sep px-3 py-1.5"
        >
          <Text className="text-sm text-label2">{t("common:retry")}</Text>
        </Pressable>
      </View>
    );
  }
  if (entries.length === 0) {
    return (
      <View className="flex-1 items-center justify-center py-10">
        <Text className="text-sm text-label3">
          {t("library:artifactEmpty")}
        </Text>
      </View>
    );
  }
  return (
    <ScrollView
      className="flex-1"
      contentContainerStyle={{
        paddingHorizontal: 12,
        paddingBottom: 24,
        gap: 4,
      }}
    >
      {entries.map((entry) =>
        entry.type === "group" ? (
          <Text
            key={entry.key}
            className="mt-3 px-1 text-xs font-medium text-label3"
          >
            {entry.name}
          </Text>
        ) : (
          <ArtifactRow
            key={entry.key}
            item={entry.item}
            onOpen={onOpenPreview}
            onToggle={() => void toggleFavorite(entry.item)}
          />
        ),
      )}
    </ScrollView>
  );
}

const ArtifactRow = memo(function ArtifactRow({
  item,
  onOpen,
  onToggle,
}: {
  item: ArtifactWireItem;
  onOpen: (item: ArtifactWireItem) => void;
  onToggle: () => void;
}) {
  const { t } = useTranslation(["library", "chat"]);
  const colors = useThemeColors();
  return (
    <Pressable
      className="flex-row items-center gap-2 rounded-lg bg-white px-3 py-2.5 dark:bg-neutral-900"
      android_ripple={{ color: colors.subtle }}
      onPress={() => onOpen(item)}
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-sm text-black dark:text-white" numberOfLines={1}>
          {item.name}
        </Text>
        <Text className="text-xs text-label3" numberOfLines={1}>
          {item.sessionTitle || t("library:artifactNoSession")} ·{" "}
          {relativeTimeLabel(formatRelative(item.writtenAt), t)} ·{" "}
          {formatSize(item.size)}
        </Text>
      </View>
      <Pressable
        hitSlop={10}
        onPress={onToggle}
        accessibilityLabel={t("library:artifactToggleFavorite")}
      >
        <Star
          size={18}
          color={item.favorite ? colors.primary : "#8E8E93"}
          fill={item.favorite ? colors.primary : "none"}
        />
      </Pressable>
    </Pressable>
  );
});

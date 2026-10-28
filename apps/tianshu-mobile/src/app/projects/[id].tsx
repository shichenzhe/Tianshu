// 项目工作台页（A7 批，/projects/[id]）：PageHeader（项目名,back）+ 分段
// [计划|资产|关于]。计划：激活视图 chips（parseViewConfig 条件+排序经 core
// 引擎过滤排序）→ groupBy 固定 status 分组 → 拍平为 FlatList 条目（组头行/
// 事项行/组尾「+」快速新建行——照会话组拍平虚拟化铁律：行级 memo、行上禁
// flex-1）；事项行=标题/优先级色点（P0 语义红/P1 主题色/P2/P3 中性灰）/
// 处理人昵称/截止 MM-dd；点击行进 PlanItemDialog（全字段+自定义字段+附件）。
// 资产：面包屑+用量条+行列表；图片 readAssetImage 弹层预览，文本走
// FilePreviewModal（files/read + assetWorkspaceId），其余 toast 桌面端。
// 关于：指令只读卡+成员列表+bindings 只读清单（valid=false 置灰标注）。
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocalSearchParams } from "expo-router";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  Bot,
  Boxes,
  ChevronRight,
  File,
  Folder,
  Link2,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react-native";
import {
  PLAN_STATUSES,
  type AssetEntryDto,
  type PlanItemCreatePayload,
  type PlanItemRecordDto,
  type PlanItemUpdatePayload,
  type PlanPriority,
  type PlanStatus,
  type ProjectBindingItemDto,
} from "@tianshu/protocol";
import {
  filterPlanItems,
  groupPlanItems,
  isoToDateKey,
  parsePlanViewConfig,
  sortPlanItems,
} from "@/logic/plan-view";

import { AppActionSheet } from "@/components/AppActionSheet";
import { DialogShell } from "@/components/DialogShell";
import { FilePreviewModal } from "@/components/FilePreviewModal";
import { FormField } from "@/components/FormField";
import { FormFooter } from "@/components/FormFooter";
import { PageHeader } from "@/components/PageHeader";
import { PlanItemDialog } from "@/components/PlanItemDialog";
import { formatSize } from "@/lib/format-size";
import { relativeTimeLabel } from "@/lib/relative-time-label";
import { toast } from "@/lib/toast-bus";
import { formatRelative } from "@/logic/time";
import {
  useConnectionCapabilities,
  useConnectionsStore,
} from "@/store/connections.store";
import { resolveActiveView, useProjectStore } from "@/store/project.store";
import { useThemeColors } from "@/store/theme";

type WsTab = "plan" | "assets" | "about";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
const TEXT_EXTS = new Set([
  "md",
  "markdown",
  "txt",
  "text",
  "csv",
  "json",
  "log",
  "xml",
  "yaml",
  "yml",
  "ts",
  "tsx",
  "js",
  "jsx",
  "py",
  "java",
  "go",
  "rs",
  "sh",
  "sql",
  "html",
  "css",
]);

/** 优先级色点：P0 语义红（共享 ACTION_DANGER 同色）/P1 主题色/P2/P3 中性灰 */
const PRIORITY_DOT_COLORS: Record<PlanPriority, string> = {
  P0: "#FF3B30",
  P1: "primary",
  P2: "#8E8E93",
  P3: "#C7C7CC",
};

/** 分段栏 [计划|资产|关于] */
function WsSegments({
  tab,
  disabled,
  onSelect,
}: {
  tab: WsTab;
  disabled: boolean;
  onSelect: (tab: WsTab) => void;
}) {
  const { t } = useTranslation("project");
  const colors = useThemeColors();
  const options = [
    { key: "plan", label: t("planTab") },
    { key: "assets", label: t("assetsTab") },
    { key: "about", label: t("aboutTab") },
  ] as const;
  return (
    <View className="px-3 pb-2">
      <View className="flex-row rounded-lg border border-sep p-0.5 dark:border-[#545458A6]">
        {options.map((option) => {
          const active = option.key === tab;
          return (
            <Pressable
              key={option.key}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() => onSelect(option.key)}
              className="flex-1 items-center rounded-md px-3 py-2"
              style={{
                backgroundColor: active ? colors.primary : "transparent",
              }}
            >
              <Text
                className={`text-xs ${active ? "font-medium text-white" : "text-label2 dark:text-[#EBEBF599]"}`}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

// —— 计划拍平条目（组头/事项/组尾新建——行级 memo，行上禁 flex-1 铁律） ——

type PlanEntry =
  | { kind: "header"; key: string; status: PlanStatus; count: number }
  | { kind: "item"; key: string; item: PlanItemRecordDto; isLast: boolean }
  | { kind: "add"; key: string; status: PlanStatus };

/** 组头行：状态本地化名 + 计数 */
const PlanGroupHeaderRow = memo(function PlanGroupHeaderRow({
  status,
  count,
}: {
  status: PlanStatus;
  count: number;
}) {
  const { t } = useTranslation("project");
  return (
    <View className="flex-row items-center gap-2 px-4 pb-1 pt-4">
      <Text className="text-[13px] font-medium text-label2 dark:text-[#EBEBF599]">
        {t(`status.${status}`)}
      </Text>
      <Text className="text-xs text-label3 dark:text-[#EBEBF54D]">
        {count}
      </Text>
    </View>
  );
});

/** 组尾「+」快速新建行：预置该组状态 */
const PlanGroupAddRow = memo(function PlanGroupAddRow({
  status,
  onPress,
}: {
  status: PlanStatus;
  onPress: (status: PlanStatus) => void;
}) {
  const { t } = useTranslation("project");
  const colors = useThemeColors();
  return (
    <Pressable
      onPress={() => onPress(status)}
      className="flex-row items-center gap-2 px-4 py-2.5"
      hitSlop={4}
    >
      <Plus size={14} color={colors.primary} />
      <Text className="text-xs" style={{ color: colors.primary }}>
        {t("quickCreate")}
      </Text>
    </Pressable>
  );
});

/** 事项行：标题/优先级色点/处理人昵称/截止 MM-dd（行上禁 flex-1——
 *  仅文本节点收 min-w-0，防 Yoga 0 高塌行） */
const PlanItemRow = memo(function PlanItemRow({
  item,
  assigneeName,
  isLast,
  onOpen,
}: {
  item: PlanItemRecordDto;
  assigneeName: string;
  isLast: boolean;
  onOpen: (item: PlanItemRecordDto) => void;
}) {
  const colors = useThemeColors();
  const dueKey = isoToDateKey(item.dueDate);
  const dotColor =
    PRIORITY_DOT_COLORS[item.priority] === "primary"
      ? colors.primary
      : PRIORITY_DOT_COLORS[item.priority];
  return (
    <Pressable
      onPress={() => onOpen(item)}
      className={`flex-row items-center gap-2 bg-card px-3 py-3 dark:bg-[#1C1C1E] ${
        isLast ? "" : "border-b border-sep dark:border-[#545458A6]"
      }`}
    >
      <View
        className="h-2 w-2 rounded-full"
        style={{ backgroundColor: dotColor }}
      />
      <Text
        numberOfLines={1}
        className="min-w-0 flex-1 text-[15px] text-black dark:text-white"
      >
        {item.title}
      </Text>
      <Text
        numberOfLines={1}
        className="max-w-20 text-xs text-label3 dark:text-[#EBEBF54D]"
      >
        {assigneeName}
      </Text>
      <Text className="w-11 text-right text-xs text-label3 dark:text-[#EBEBF54D]">
        {dueKey === "" ? "" : dueKey.slice(5)}
      </Text>
    </Pressable>
  );
});

/** 图片预览弹层：readAssetImage 拼 data URL；失败占位文案 */
function AssetImageModal({
  projectId,
  path,
  visible,
  onClose,
}: {
  projectId: number;
  path: string[] | null;
  visible: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation("project");
  const [state, setState] = useState<
    { status: "loading" } | { status: "ok"; url: string } | { status: "failed" }
  >({ status: "loading" });

  useEffect(() => {
    if (!visible || !path) return;
    let cancelled = false;
    setState({ status: "loading" });
    useProjectStore
      .getState()
      .readAssetImage(projectId, path)
      .then((result) => {
        if (cancelled) return;
        setState({
          status: "ok",
          url: `data:${result.mime};base64,${result.dataBase64}`,
        });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [visible, path, projectId]);

  const fileName = path?.[path.length - 1] ?? "";
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View className="flex-1 items-center justify-center bg-black/80 px-6">
        <Pressable
          accessibilityLabel={t("back")}
          hitSlop={12}
          className="absolute right-5 top-14 z-10"
          onPress={onClose}
        >
          <X size={24} color="white" />
        </Pressable>
        {state.status === "ok" ? (
          <Image
            source={{ uri: state.url }}
            resizeMode="contain"
            className="h-3/4 w-full"
          />
        ) : (
          <View className="h-48 items-center justify-center">
            {state.status === "loading" ? (
              <ActivityIndicator color="white" size="large" />
            ) : (
              <Text className="text-center text-sm text-white/80">
                {t("imageFailed")}
              </Text>
            )}
          </View>
        )}
        <Text numberOfLines={1} className="mt-3 text-xs text-white/70">
          {fileName}
        </Text>
      </View>
    </Modal>
  );
}

/** 资产行：文件夹/文件图标 + 名称 + size/相对时间 */
function AssetRow({
  entry,
  isLast,
  onOpen,
  onMenu,
}: {
  entry: AssetEntryDto;
  isLast: boolean;
  onOpen: (entry: AssetEntryDto) => void;
  onMenu: (entry: AssetEntryDto) => void;
}) {
  const colors = useThemeColors();
  const { t } = useTranslation("project");
  return (
    <Pressable
      onPress={() => onOpen(entry)}
      onLongPress={() => onMenu(entry)}
      className={`flex-row items-center gap-3 bg-card px-3 py-3 dark:bg-[#1C1C1E] ${
        isLast ? "" : "border-b border-sep dark:border-[#545458A6]"
      }`}
    >
      {entry.type === "folder" ? (
        <Folder size={20} color={colors.primary} />
      ) : (
        <File size={20} color={colors.primary} />
      )}
      <View className="min-w-0 flex-1">
        <Text
          numberOfLines={1}
          className="text-[15px] text-black dark:text-white"
        >
          {entry.name}
        </Text>
        <Text
          numberOfLines={1}
          className="mt-0.5 text-xs text-label3 dark:text-[#EBEBF54D]"
        >
          {entry.type === "folder"
            ? relativeTimeLabel(formatRelative(entry.updatedAt), t)
            : `${formatSize(entry.size)} · ${relativeTimeLabel(formatRelative(entry.updatedAt), t)}`}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        hitSlop={8}
        onPress={() => onMenu(entry)}
      >
        <MoreHorizontal size={18} color="#C7C7CC" />
      </Pressable>
    </Pressable>
  );
}

export default function ProjectWorkspaceScreen() {
  const { t } = useTranslation(["project", "chat", "common"]);
  const params = useLocalSearchParams<{ id: string }>();
  const projectId = Number(params.id);
  const colors = useThemeColors();
  const activeConnId = useConnectionsStore((state) => state.activeConnId);
  const capabilities = useConnectionCapabilities(activeConnId);
  const supported = capabilities?.includes("project") ?? false;
  const detail = useProjectStore((state) => state.detail);
  const members = useProjectStore((state) => state.members);
  const detailFacet = useProjectStore((state) => state.detailFacet);
  const items = useProjectStore((state) => state.items);
  const fields = useProjectStore((state) => state.fields);
  const views = useProjectStore((state) => state.views);
  const activeViewId = useProjectStore((state) => state.activeViewId);
  const plan = useProjectStore((state) => state.plan);
  const entries = useProjectStore((state) => state.entries);
  const folderPath = useProjectStore((state) => state.folderPath);
  const storage = useProjectStore((state) => state.storage);
  const assets = useProjectStore((state) => state.assets);
  const currentUserId = useProjectStore((state) => state.currentUserId);
  const saving = useProjectStore((state) => state.saving);
  const [tab, setTab] = useState<WsTab>("plan");
  const [itemDialog, setItemDialog] = useState<
    | { mode: "create"; status?: PlanStatus }
    | { mode: "edit"; item: PlanItemRecordDto }
    | null
  >(null);
  const [assetSheetTarget, setAssetSheetTarget] = useState<AssetEntryDto | null>(
    null,
  );
  const [folderDialog, setFolderDialog] = useState<"create" | "rename" | null>(
    null,
  );
  const [assetName, setAssetName] = useState("");
  const [imageTarget, setImageTarget] = useState<string[] | null>(null);
  const [textPreview, setTextPreview] = useState<{
    path: string;
    name: string;
  } | null>(null);

  useEffect(() => {
    if (!Number.isFinite(projectId) || !activeConnId || !supported) return;
    const store = useProjectStore.getState();
    void store.loadDetail(projectId);
    void store.loadPlan(projectId);
    void store.loadAssets(projectId);
    void store.loadStorage(projectId);
  }, [projectId, activeConnId, supported]);

  /** 处理人昵称映射（未指派显示 -） */
  const memberNames = useMemo(
    () => new Map(members.map((member) => [member.userId, member.nickname])),
    [members],
  );

  const activeView = useMemo(
    () => resolveActiveView(views, activeViewId),
    [views, activeViewId],
  );

  /** 计划拍平：激活视图条件+排序 → status 分组 → 组头/事项/组尾条目 */
  const planEntries = useMemo<PlanEntry[]>(() => {
    const config = parsePlanViewConfig(
      activeView?.filterJson ?? "",
      activeView?.sortJson ?? "",
    );
    const visible = sortPlanItems(
      filterPlanItems(items, config.conditions, "", currentUserId ?? 0),
      config.sortRules,
    );
    const groups = groupPlanItems(visible, "status", members);
    const entries: PlanEntry[] = [];
    groups.forEach((group) => {
      const status = group.key as PlanStatus;
      if (!PLAN_STATUSES.includes(status)) return;
      entries.push({
        kind: "header",
        key: `h-${group.key}`,
        status,
        count: group.items.length,
      });
      group.items.forEach((item, index) => {
        entries.push({
          kind: "item",
          key: `i-${item.id}`,
          item,
          isLast: index === group.items.length - 1,
        });
      });
      entries.push({ kind: "add", key: `a-${group.key}`, status });
    });
    return entries;
  }, [items, activeView, members, currentUserId]);

  const openPlanItem = useCallback(
    (item: PlanItemRecordDto) => setItemDialog({ mode: "edit", item }),
    [],
  );
  const openQuickCreate = useCallback(
    (status: PlanStatus) => setItemDialog({ mode: "create", status }),
    [],
  );

  function notifyFailure() {
    const message = useProjectStore.getState().hub.error;
    toast.error(message || t("project:loadFailed"));
  }

  async function handleItemSubmit(
    payload: PlanItemCreatePayload | PlanItemUpdatePayload,
  ) {
    const store = useProjectStore.getState();
    const ok =
      itemDialog?.mode === "create"
        ? await store.createItem(payload as PlanItemCreatePayload)
        : await store.updateItem(payload as PlanItemUpdatePayload);
    if (ok) setItemDialog(null);
    else toast.error(store.hub.error || t("project:itemDialog.saveFailed"));
  }

  /** 文件点击：图片弹层 / 文本预览（files/read + assetWorkspaceId）/
   *  其余 toast 桌面端 */
  function openAsset(entry: AssetEntryDto) {
    if (entry.type === "folder") {
      void useProjectStore
        .getState()
        .loadAssets(projectId, [...folderPath, entry.name]);
      return;
    }
    const ext = entry.ext.toLowerCase();
    if (IMAGE_EXTS.has(ext)) {
      setImageTarget([...folderPath, entry.name]);
      return;
    }
    if (TEXT_EXTS.has(ext)) {
      setTextPreview({
        path: folderPath.length
          ? `${folderPath.join("/")}/${entry.name}`
          : entry.name,
        name: entry.name,
      });
      return;
    }
    toast.info(t("project:previewOnDesktop"));
  }

  function confirmDeleteAsset(entry: AssetEntryDto) {
    setAssetSheetTarget(null);
    const message =
      entry.type === "folder"
        ? t("project:deleteFolderConfirm")
        : t("common:confirm");
    Alert.alert(t("project:deleteAsset"), message, [
      { text: t("common:cancel"), style: "cancel" },
      {
        text: t("common:confirm"),
        style: "destructive",
        onPress: () => void performDeleteAsset(entry),
      },
    ]);
  }

  async function performDeleteAsset(entry: AssetEntryDto) {
    const ok = await useProjectStore
      .getState()
      .removeAsset(projectId, [...folderPath, entry.name]);
    if (!ok) notifyFailure();
  }

  async function handleAssetDialogConfirm() {
    const trimmed = assetName.trim();
    if (!trimmed) return;
    const store = useProjectStore.getState();
    const ok =
      folderDialog === "create"
        ? await store.createFolder(projectId, trimmed)
        : assetSheetTarget
          ? await store.renameAsset(
              projectId,
              [...folderPath, assetSheetTarget.name],
              trimmed,
            )
          : false;
    if (ok) {
      setFolderDialog(null);
      setAssetSheetTarget(null);
    } else {
      notifyFailure();
    }
  }

  const usagePercent =
    storage && storage.quotaBytes > 0
      ? Math.min(1, storage.usedBytes / storage.quotaBytes)
      : 0;

  function renderGuide() {
    if (!activeConnId) {
      return (
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
            {t("chat:noConnection")}
          </Text>
        </View>
      );
    }
    return (
      <View className="flex-1 items-center justify-center px-6">
        <Text className="text-center text-sm text-label2 dark:text-[#EBEBF599]">
          {t("project:noProject")}
        </Text>
      </View>
    );
  }

  function renderPlan() {
    if (plan.error && !plan.initialized) {
      return (
        <View className="flex-1 items-center justify-center gap-3 px-6">
          <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
            {t("project:loadFailed")}
          </Text>
          <Pressable
            onPress={() => void useProjectStore.getState().loadPlan(projectId)}
            className="rounded-lg px-4 py-2"
            style={{ backgroundColor: colors.primary }}
          >
            <Text className="text-sm text-white">{t("project:retry")}</Text>
          </Pressable>
        </View>
      );
    }
    if (planEntries.length === 0) {
      return (
        <Text className="py-20 text-center text-sm text-label2 dark:text-[#EBEBF599]">
          {t("project:emptyPlan")}
        </Text>
      );
    }
    return (
      <FlatList
        className="flex-1"
        data={planEntries}
        keyExtractor={(entry) => entry.key}
        renderItem={({ item: entry }) => {
          if (entry.kind === "header") {
            return (
              <PlanGroupHeaderRow status={entry.status} count={entry.count} />
            );
          }
          if (entry.kind === "add") {
            return (
              <PlanGroupAddRow status={entry.status} onPress={openQuickCreate} />
            );
          }
          return (
            <PlanItemRow
              item={entry.item}
              isLast={entry.isLast}
              assigneeName={
                entry.item.assigneeId === null
                  ? "-"
                  : (memberNames.get(entry.item.assigneeId) ?? "-")
              }
              onOpen={openPlanItem}
            />
          );
        }}
      />
    );
  }

  function renderAssets() {
    if (assets.error && !assets.initialized) {
      return (
        <View className="flex-1 items-center justify-center gap-3 px-6">
          <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
            {t("project:loadFailed")}
          </Text>
          <Pressable
            onPress={() =>
              void useProjectStore.getState().loadAssets(projectId, folderPath)
            }
            className="rounded-lg px-4 py-2"
            style={{ backgroundColor: colors.primary }}
          >
            <Text className="text-sm text-white">{t("project:retry")}</Text>
          </Pressable>
        </View>
      );
    }
    return (
      <ScrollView className="flex-1">
        {/* 面包屑：根 = 项目名 */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0, flexShrink: 0 }}
          contentContainerStyle={{
            alignItems: "center",
            gap: 4,
            paddingHorizontal: 12,
            paddingBottom: 8,
          }}
        >
          <Pressable
            onPress={() =>
              void useProjectStore.getState().loadAssets(projectId)
            }
            hitSlop={8}
          >
            <Text className="text-sm" style={{ color: colors.primary }}>
              {detail?.project.name ?? t("project:root")}
            </Text>
          </Pressable>
          {folderPath.map((segment, index) => (
            <View key={`${segment}-${index}`} className="flex-row items-center gap-1">
              <ChevronRight size={12} color="#C7C7CC" />
              <Pressable
                onPress={() =>
                  void useProjectStore
                    .getState()
                    .loadAssets(projectId, folderPath.slice(0, index + 1))
                }
                hitSlop={8}
              >
                <Text className="text-sm" style={{ color: colors.primary }}>
                  {segment}
                </Text>
              </Pressable>
            </View>
          ))}
        </ScrollView>
        {/* 用量条：超 80% 警示色 */}
        {storage && (
          <View className="gap-1 px-4 pb-2">
            <View className="h-1.5 overflow-hidden rounded-full bg-sep dark:bg-[#545458A6]">
              <View
                className="h-full rounded-full"
                style={{
                  width: `${usagePercent * 100}%`,
                  backgroundColor:
                    usagePercent > 0.8 ? "#FF9F0A" : colors.primary,
                }}
              />
            </View>
            <Text className="text-xs text-label3 dark:text-[#EBEBF54D]">
              {usagePercent > 0.8
                ? `${t("usage", {
                    used: formatSize(storage.usedBytes),
                    quota: formatSize(storage.quotaBytes),
                  })} · ${t("quotaWarning")}`
                : t("usage", {
                    used: formatSize(storage.usedBytes),
                    quota: formatSize(storage.quotaBytes),
                  })}
            </Text>
          </View>
        )}
        {entries.length === 0 ? (
          <Text className="py-20 text-center text-sm text-label2 dark:text-[#EBEBF599]">
            {t("project:emptyAssets")}
          </Text>
        ) : (
          <View className="mx-3 overflow-hidden rounded-2xl">
            {entries.map((entry, index) => (
              <AssetRow
                key={entry.name}
                entry={entry}
                isLast={index === entries.length - 1}
                onOpen={openAsset}
                onMenu={setAssetSheetTarget}
              />
            ))}
          </View>
        )}
      </ScrollView>
    );
  }

  function renderAbout() {
    const bindings = detail?.bindings ?? [];
    const bindingIcon = (itemType: ProjectBindingItemDto["itemType"]) =>
      itemType === "assistant" ? (
        <Bot size={18} color={colors.primary} />
      ) : itemType === "skill" ? (
        <Boxes size={18} color={colors.primary} />
      ) : (
        <Link2 size={18} color={colors.primary} />
      );
    return (
      <ScrollView className="flex-1" contentContainerStyle={{ gap: 12 }}>
        <View className="mx-3 gap-2 rounded-2xl bg-card px-4 py-3 dark:bg-[#1C1C1E]">
          <Text className="text-[13px] font-medium text-label2 dark:text-[#EBEBF599]">
            {t("project:instruction")}
          </Text>
          <Text className="text-sm leading-5 text-black dark:text-white">
            {detail?.project.systemPrompt?.trim() || "-"}
          </Text>
        </View>
        <View className="mx-3 gap-2">
          <Text className="px-1 text-[13px] font-medium text-label2 dark:text-[#EBEBF599]">
            {t("project:members")}
          </Text>
          <View className="overflow-hidden rounded-2xl">
            {members.map((member, index) => (
              <View
                key={member.userId}
                className={`flex-row items-center gap-3 bg-card px-3 py-3 dark:bg-[#1C1C1E] ${
                  index === members.length - 1
                    ? ""
                    : "border-b border-sep dark:border-[#545458A6]"
                }`}
              >
                <View className="min-w-0 flex-1">
                  <Text
                    numberOfLines={1}
                    className="text-[15px] text-black dark:text-white"
                  >
                    {member.nickname}
                  </Text>
                  <Text
                    numberOfLines={1}
                    className="mt-0.5 text-xs text-label3 dark:text-[#EBEBF54D]"
                  >
                    {member.username}
                  </Text>
                </View>
                <View
                  className="rounded-full px-2 py-0.5"
                  style={{ backgroundColor: colors.subtle }}
                >
                  <Text className="text-xs" style={{ color: colors.primary }}>
                    {member.role}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </View>
        <View className="mx-3 gap-2">
          <Text className="px-1 text-[13px] font-medium text-label2 dark:text-[#EBEBF599]">
            {t("project:bindings")}
          </Text>
          <View className="overflow-hidden rounded-2xl">
            {bindings.length === 0 ? (
              <View className="bg-card px-3 py-3 dark:bg-[#1C1C1E]">
                <Text className="text-xs text-label3 dark:text-[#EBEBF54D]">
                  -
                </Text>
              </View>
            ) : (
              bindings.map((binding, index) => (
                <View
                  key={binding.id}
                  className={`flex-row items-center gap-3 bg-card px-3 py-3 dark:bg-[#1C1C1E] ${
                    index === bindings.length - 1
                      ? ""
                      : "border-b border-sep dark:border-[#545458A6]"
                  }`}
                  style={{ opacity: binding.valid ? 1 : 0.5 }}
                >
                  {bindingIcon(binding.itemType)}
                  <Text
                    numberOfLines={1}
                    className="min-w-0 flex-1 text-[15px] text-black dark:text-white"
                  >
                    {binding.itemName}
                  </Text>
                  {!binding.valid && (
                    <Text className="text-xs text-label3 dark:text-[#EBEBF54D]">
                      {t("project:bindingInvalid")}
                    </Text>
                  )}
                </View>
              ))
            )}
          </View>
        </View>
      </ScrollView>
    );
  }

  const loadingInitial = detailFacet.loading && !detailFacet.initialized;
  const projectName = detail?.project.name ?? "";

  return (
    <SafeAreaView
      className="flex-1 bg-grouped dark:bg-black"
      edges={["top", "bottom"]}
    >
      <PageHeader title={projectName} backLabel={t("project:back")} />
      {!activeConnId || !supported ? (
        renderGuide()
      ) : (
        <>
          {/* 计划 Tab 的视图 chips：横滚选择，选中高亮 */}
          {tab === "plan" && views.length > 0 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ flexGrow: 0, flexShrink: 0 }}
              contentContainerStyle={{ gap: 8, paddingHorizontal: 12 }}
            >
              {views.map((view) => {
                const active = view.id === activeView?.id;
                return (
                  <Pressable
                    key={view.id}
                    onPress={() => useProjectStore.getState().setActiveView(view.id)}
                    className="rounded-full px-3 py-1.5"
                    style={{
                      backgroundColor: active
                        ? colors.primary
                        : colors.subtle,
                    }}
                  >
                    <Text
                      className="text-xs"
                      style={{ color: active ? "#FFFFFF" : colors.primary }}
                    >
                      {view.name}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          )}
          <WsSegments tab={tab} disabled={saving} onSelect={setTab} />
          {loadingInitial ? (
            <View className="flex-1 items-center justify-center">
              <ActivityIndicator color={colors.primary} size="large" />
            </View>
          ) : tab === "plan" ? (
            renderPlan()
          ) : tab === "assets" ? (
            renderAssets()
          ) : (
            renderAbout()
          )}
        </>
      )}
      <AppActionSheet
        visible={assetSheetTarget !== null}
        title={assetSheetTarget?.name}
        items={
          assetSheetTarget
            ? [
                {
                  key: "rename",
                  label: t("project:renameAsset"),
                  Icon: Pencil,
                  onPress: () => {
                    setAssetName(assetSheetTarget.name);
                    setFolderDialog("rename");
                  },
                },
                {
                  key: "delete",
                  label: t("project:deleteAsset"),
                  Icon: Trash2,
                  danger: true,
                  onPress: () => confirmDeleteAsset(assetSheetTarget),
                },
              ]
            : []
        }
        onClose={() => setAssetSheetTarget(null)}
      />
      {folderDialog !== null && (
        <DialogShell
          title={t(
            folderDialog === "create"
              ? "project:newFolder"
              : "project:renameAsset",
          )}
          busy={saving}
          onClose={() => setFolderDialog(null)}
          footer={
            <FormFooter
              busy={saving}
              confirmDisabled={!assetName.trim()}
              onConfirm={() => void handleAssetDialogConfirm()}
              onCancel={() => setFolderDialog(null)}
            />
          }
        >
          <FormField
            label={t("project:newFolder")}
            value={assetName}
            onChangeText={setAssetName}
          />
        </DialogShell>
      )}
      {itemDialog !== null && (
        <PlanItemDialog
          projectId={projectId}
          item={
            itemDialog.mode === "edit" ? itemDialog.item : undefined
          }
          defaultStatus={
            itemDialog.mode === "create" ? itemDialog.status : undefined
          }
          members={members}
          fields={fields}
          busy={saving}
          onClose={() => setItemDialog(null)}
          onSubmit={(payload) => void handleItemSubmit(payload)}
        />
      )}
      <AssetImageModal
        projectId={projectId}
        path={imageTarget}
        visible={imageTarget !== null}
        onClose={() => setImageTarget(null)}
      />
      <FilePreviewModal
        visible={textPreview !== null}
        path={textPreview?.path ?? ""}
        workspaceId={detail?.assetWorkspaceId ?? null}
        onClose={() => setTextPreview(null)}
      />
    </SafeAreaView>
  );
}

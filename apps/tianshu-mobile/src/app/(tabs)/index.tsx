import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  ChevronDown,
  Inbox,
  MessageSquarePlus,
  Search,
  Unplug,
  X,
} from "lucide-react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { AppIcon } from "@/components/AppIcon";
import { SessionActionsSheet } from "@/components/SessionActionsSheet";
import { SessionRenameDialog } from "@/components/SessionRenameDialog";
import { SessionRow } from "@/components/SessionRow";
import { SkeletonSessionList } from "@/components/SkeletonSessionList";
import {
  archiveWithUndo,
  undoArchive,
  type ArchiveUndoPorts,
} from "@/logic/archive-undo";
import { tapLight } from "@/lib/haptics";
import { toast } from "@/lib/toast-bus";
import { groupSessionsByWorkspace } from "@/logic/workspace-grouping";
import type { SessionTimeFilter } from "@/logic/session-time-filter";
import { useConnectionsStore } from "@/store/connections.store";
import { useSearchUiStore } from "@/store/search-ui";
import {
  useSessionsStore,
  type SessionBrief,
} from "@/store/sessions.store";
import { useThemeColors } from "@/store/theme";

/** 会话列表页（T13）：防抖搜索 + 归档筛选 + 分页 FlatList +
 * 长按操作面板（置顶/归档/删除）；连接管理与新建会话入口在聊天 Tab 顶栏。
 * 列表数据/事件驱动刷新全在 sessions.store（server.connected 全量重拉、
 * session.updated 原地更新+重排） */
/** 时间筛选钮组（A11 批）：与桌面 FilterPopover 同口径同文案
 *  （全部时间/今天/最近 7 天/最近 30 天，滚动窗非自然周月） */
const TIME_FILTER_OPTIONS: Array<{
  value: SessionTimeFilter;
  labelKey: string;
}> = [
  { value: "all", labelKey: "chat:filterTimeAll" },
  { value: "today", labelKey: "chat:filterTimeToday" },
  { value: "week", labelKey: "chat:filterTimeWeek" },
  { value: "month", labelKey: "chat:filterTimeMonth" },
];
/** 组折叠箭头（GL-P5）：随展开态旋转 180°（180ms 平滑） */
function GroupChevron({ open }: { open: boolean }) {
  const rotate = useSharedValue(0);
  useEffect(() => {
    rotate.value = withTiming(open ? 180 : 0, { duration: 180 });
  }, [open, rotate]);
  const style = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotate.value}deg` }],
  }));
  return (
    <Animated.View style={style}>
      <AppIcon
        name="chevron.down"
        fallback={ChevronDown}
        size={14}
        color="#8E8E93"
      />
    </Animated.View>
  );
}

/** 组态拍平后的展开占位（加载中转圈/空组文案）——独立条目，随 FlatList
 *  虚拟化只挂载可视窗口 */
function GroupPendingRow({ state }: { state: "loading" | "empty" }) {
  const { t } = useTranslation("chat");
  return (
    <View className="overflow-hidden rounded-2xl bg-card dark:bg-[#1C1C1E]">
      {state === "loading" ? (
        <View className="items-center py-6">
          <ActivityIndicator size="small" color="#8E8E93" />
        </View>
      ) : (
        <Text className="px-4 py-5 text-center text-[13px] text-label2 dark:text-[#EBEBF599]">
          {t("chat:groupEmpty")}
        </Text>
      )}
    </View>
  );
}

interface GroupHeaderRowProps {
  wsId: number;
  title: string;
  /** null=组会话未拉完（计数暂不显示） */
  count: number | null;
  open: boolean;
  creating: boolean;
  /** 组间空隙由组头承担（首组免顶距） */
  gapTop: boolean;
  onToggle: (wsId: number, isOpen: boolean) => void;
  onCreate: (wsId: number) => void;
}

/** 工作空间组头（性能批 memo）：展开/收缩只重渲染受影响的组头——props
 *  全为原始值 + 稳定回调，其余组头 React.memo 直接跳过 */
const GroupHeaderRow = memo(function GroupHeaderRow({
  wsId,
  title,
  count,
  open,
  creating,
  gapTop,
  onToggle,
  onCreate,
}: GroupHeaderRowProps) {
  const colors = useThemeColors();
  const { t } = useTranslation("chat");
  return (
    <View className={gapTop ? "mt-1" : undefined}>
      {/* 组内新建（用户裁定：入口放目录名右侧、聊天冒泡+号样式）。内层
          Pressable 嵌套取响应优先，不误触组折叠。
          禁 flex-1：内容容器 flexGrow:1 的不定高列里行高须由内容驱动，
          flexBasis:0 的行在展开/搜索高频重渲染时会被 Yoga 算成 0 高（真机
          塌行：目录名/计数 Text 0×0 消失只剩图标按钮）；列方向 cross-axis
          stretch 本就撑满行宽 */}
      <Pressable
        onPress={() => onToggle(wsId, open)}
        className="flex-row items-center gap-2 px-1 py-2.5"
        style={({ pressed }) => ({
          backgroundColor: pressed ? colors.subtle : "transparent",
        })}
      >
        {/* shrink：RN 默认 flexShrink=0，长目录名不收缩会把计数/箭头
            顶出屏；单行截断对齐微信目录样式 */}
        <Text
          className="shrink text-[13px] font-normal text-label2 dark:text-[#EBEBF599]"
          numberOfLines={1}
        >
          {title}
        </Text>
        <Pressable
          onPress={() => onCreate(wsId)}
          disabled={creating}
          hitSlop={6}
          accessibilityLabel={t("chat:newSession")}
          className="rounded-full p-1"
          style={({ pressed }) => ({
            backgroundColor: pressed ? colors.subtle : "transparent",
            opacity: creating ? 0.5 : 1,
          })}
        >
          <MessageSquarePlus size={17} color={colors.primary} />
        </Pressable>
        <View className="flex-1" />
        {count !== null && (
          <Text className="text-[13px] text-label3 dark:text-[#EBEBF54D]">
            {count}
          </Text>
        )}
        <GroupChevron open={open} />
      </Pressable>
    </View>
  );
});

interface SessionEntryRowProps {
  session: SessionBrief;
  summary?: string | null;
  edge: "card" | "first" | "middle" | "last" | "single";
  onOpen: (id: number) => void;
  onLongPress: (s: SessionBrief) => void;
  onTogglePin: (s: SessionBrief) => void;
  onToggleArchive: (s: SessionBrief) => void;
  onDelete: (s: SessionBrief) => void;
}

/** 会话行条目（性能批 memo）：回调全为父级稳定引用 + session 对象身份
 *  随 store 缓存稳定——组展开/收缩重建 listData 时不连带重渲染未变行 */
const SessionEntryRow = memo(function SessionEntryRow({
  session,
  summary = null,
  edge,
  onOpen,
  onLongPress,
  onTogglePin,
  onToggleArchive,
  onDelete,
}: SessionEntryRowProps) {
  return (
    <SessionRow
      session={session}
      summary={summary}
      edge={edge}
      onPress={() => onOpen(session.id)}
      onLongPress={() => onLongPress(session)}
      onTogglePin={() => onTogglePin(session)}
      onToggleArchive={() => onToggleArchive(session)}
      onDelete={() => onDelete(session)}
    />
  );
});

export default function SessionsScreen() {
  const { t } = useTranslation(["chat", "common"]);
  const colors = useThemeColors();
  const router = useRouter();

  const activeConnId = useConnectionsStore((s) => s.activeConnId);
  const searchOpen = useSearchUiStore((s) => s.searchOpen);
  const closeSearch = useSearchUiStore((s) => s.closeSearch);

  const items = useSessionsStore((s) => s.items);
  const workspaces = useSessionsStore((s) => s.workspaces);
  const keyword = useSessionsStore((s) => s.keyword);
  const showArchived = useSessionsStore((s) => s.showArchived);
  const timeFilter = useSessionsStore((s) => s.timeFilter);
  const loading = useSessionsStore((s) => s.loading);
  const refreshing = useSessionsStore((s) => s.refreshing);
  const loadFirst = useSessionsStore((s) => s.loadFirst);
  const loadMore = useSessionsStore((s) => s.loadMore);
  const search = useSessionsStore((s) => s.search);
  const setShowArchived = useSessionsStore((s) => s.setShowArchived);
  const setTimeFilter = useSessionsStore((s) => s.setTimeFilter);
  const update = useSessionsStore((s) => s.update);
  const remove = useSessionsStore((s) => s.remove);
  const create = useSessionsStore((s) => s.create);
  // GL-P5 组懒加载：折叠组缓存与拉取（展开才查）
  const workspaceSessions = useSessionsStore((s) => s.workspaceSessions);
  const loadWorkspaceSessions = useSessionsStore(
    (s) => s.loadWorkspaceSessions,
  );
  const clearWorkspaceSessions = useSessionsStore(
    (s) => s.clearWorkspaceSessions,
  );
  /** 展开组集合（key=workspaceId；默认全收缩——GL-P5；未归属目录已移除，
      组态列表仅真实工作空间） */
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  /** 组头「+」创建防重入（value=正在创建的 workspaceId） */
  const [creatingWs, setCreatingWs] = useState<number | null>(null);
  /** 重命名目标（null=对话框关闭；B1 对齐桌面 renameSession） */
  const [renameTarget, setRenameTarget] = useState<SessionBrief | null>(null);
  /** 长按目标（操作面板数据源；null=面板关闭） */
  const [sheetSession, setSheetSession] = useState<SessionBrief | null>(null);

  useEffect(() => {
    void loadFirst();
  }, [loadFirst]);

  /** 置顶/归档切换：失败提示（成功本地即时反映无需提示） */
  const handleUpdate = useCallback(
    async (id: number, params: { pinned?: boolean; archived?: boolean }) => {
      const ok = await update(id, params);
      if (!ok) toast.error(t("chat:actionFailed"));
    },
    [update, t],
  );

  // 左滑删除/长按面板删除：系统 Alert 二键确认（用户裁定——破坏性操作事前
  // 确认；归档 B5 起改撤销条范式即执行可还原，不走 Alert）
  const confirmDelete = useCallback(
    (item: SessionBrief) => {
      tapLight();
      Alert.alert(
        t("chat:delete"),
        t("chat:deleteConfirm", { title: item.title ?? t("chat:untitled") }),
        [
          { text: t("common:cancel"), style: "cancel" },
          {
            text: t("chat:delete"),
            style: "destructive",
            onPress: () => void remove(item.id),
          },
        ],
        { cancelable: true },
      );
    },
    [remove, t],
  );

  /** B5 归档撤销：写操作/提示经 ports 注入 archive-undo 编排（定时器模块
   *  级存续，页面卸载窗口不丢）；文案 i18n 现解析注入 */
  const archivePorts = useCallback<() => ArchiveUndoPorts>(
    () => ({
      archive: async (id) => update(id, { archived: true }),
      unarchive: async (id) => update(id, { archived: false }),
      settle: (id) => useSessionsStore.getState().settleArchive(id),
      notify: (message, undoLabel, onUndo) =>
        toast.info(message, { label: undoLabel, onAction: onUndo }),
      notifyError: (message) => toast.error(message),
    }),
    [update],
  );

  /** 组头「+」：在指定工作空间下建会话并直入聊天页（创建中防重入） */
  const createIn = useCallback(
    async (workspaceId: number) => {
      if (creatingWs != null) return;
      setCreatingWs(workspaceId);
      tapLight();
      try {
        const created = await create(undefined, workspaceId);
        if (created) {
          router.push(`/session/${created.id}`);
        } else {
          toast.error(t("chat:createFailed"));
        }
      } catch {
        toast.error(t("chat:createFailed"));
      } finally {
        setCreatingWs(null);
      }
    },
    [creatingWs, create, router, t],
  );

  /** 组展开/收缩：稳定回调供 memo 组头调用（isOpen=收缩态展开才拉取） */
  const toggleGroup = useCallback(
    (wsId: number, isOpen: boolean) => {
      tapLight();
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(wsId)) {
          next.delete(wsId);
        } else {
          next.add(wsId);
        }
        return next;
      });
      if (!isOpen) {
        void loadWorkspaceSessions(wsId);
      }
    },
    [loadWorkspaceSessions],
  );

  /** 行回调组（全 stable——memo 会话行 props 稳定的根基） */
  const openSheetFor = useCallback((s: SessionBrief) => {
    tapLight();
    setSheetSession(s);
  }, []);
  const pushSession = useCallback(
    (id: number) => {
      router.push(`/session/${id}`);
    },
    [router],
  );
  const togglePinFor = useCallback(
    (s: SessionBrief) => {
      void handleUpdate(s.id, { pinned: s.pinnedAt == null });
    },
    [handleUpdate],
  );
  /** B5 归档：未归档→撤销条范式立即执行；已归档/暂存行（全部筛选/撤销窗
   *  口内）→ 直还原（恢复非破坏性，不经撤销条） */
  const archiveFor = useCallback(
    (s: SessionBrief) => {
      const labels = {
        archived: t("chat:archived"),
        undo: t("common:undo"),
        failed: t("chat:actionFailed"),
      };
      if (s.archivedAt != null || s.pendingArchive === true) {
        undoArchive(s.id, archivePorts(), labels);
        return;
      }
      archiveWithUndo(s, archivePorts(), labels);
    },
    [archivePorts, t],
  );
  const deleteFor = useCallback(
    (s: SessionBrief) => void confirmDelete(s),
    [confirmDelete],
  );

  /** 归档筛选（微信化：收进搜索面板）：切换即重拉首屏 + 清组缓存并按
      展开组重拉——组态列表同样即时反映筛选 */
  function handleFilter(archived: boolean) {
    setShowArchived(archived);
    clearWorkspaceSessions();
    for (const key of expanded) {
      void loadWorkspaceSessions(key);
    }
  }

  /** A11 时间筛选：同归档切换先例——重拉首屏 + 清组缓存并按展开组重拉；
      与归档筛选独立可叠加 */
  function handleTimeFilter(filter: SessionTimeFilter) {
    setTimeFilter(filter);
    clearWorkspaceSessions();
    for (const key of expanded) {
      void loadWorkspaceSessions(key);
    }
  }

  /** 重命名提交：成功 store 乐观反映（items+组缓存），失败提示 */
  async function handleRename(title: string) {
    const target = renameTarget;
    setRenameTarget(null);
    if (!target) return;
    const ok = await update(target.id, { title });
    if (!ok) toast.error(t("chat:actionFailed"));
  }

  // MB-T2：按 workspace 分组（组随空间 id 升序、未匹配沉底兜底——兜底
  // 仅搜索态呈现；组态目录已按用户裁定去掉未归属组）；GL-P5：keyword 空
  // 走折叠组模式（workspace 清单，展开才查），搜索态用全量 sections
  const sections = useMemo(
    () => groupSessionsByWorkspace(items, workspaces, t("ungrouped")),
    [items, workspaces, t],
  );
  /** 拍平列表条目（性能批）：组态把展开组的会话行提升为独立 FlatList
   *  条目——整列表虚拟化生效（旧结构整组建在一个 item 里，展开 N 条一次
   *  性挂载 N 个 Swipeable 行，无窗口裁剪，展开/收缩全列表重渲染） */
  type ListEntry =
    | {
        kind: "group";
        key: string;
        wsId: number;
        title: string;
        count: number | null;
        open: boolean;
        creating: boolean;
        gapTop: boolean;
      }
    | { kind: "pending"; key: string; state: "loading" | "empty" }
    | {
        kind: "row";
        key: string;
        session: SessionBrief;
        edge: "first" | "middle" | "last" | "single";
      }
    | { kind: "search"; key: string; title: string; data: SessionBrief[] };
  const listData = useMemo<ListEntry[]>(() => {
    if (keyword.trim() !== "") {
      return sections.map((s): ListEntry => ({
        kind: "search",
        // s.key（ws-<id>/ws-ungrouped）全表唯一；同名工作空间标题会撞 key
        key: s.key,
        title: s.title,
        data: s.data,
      }));
    }
    // 组态：仅真实工作空间目录（用户裁定——未归属目录常态为空没必要
    // 存在；两端建会话必挂空间，未匹配会话仅在搜索态兜底分组出现）；
    // 展开组的行/占位紧跟组头成独立条目
    const entries: ListEntry[] = [];
    workspaces.forEach((w, wi) => {
      const gs = workspaceSessions[w.id];
      const open = expanded.has(w.id);
      entries.push({
        kind: "group",
        key: `g${w.id}`,
        wsId: w.id,
        title: w.name,
        count: gs?.loaded ? gs.items.length : null,
        open,
        creating: creatingWs === w.id,
        gapTop: wi > 0,
      });
      if (!open) return;
      const groupItems = gs?.items ?? [];
      if (groupItems.length === 0) {
        entries.push({
          kind: "pending",
          key: `p${w.id}`,
          state: gs?.loading ? "loading" : "empty",
        });
        return;
      }
      groupItems.forEach((session, i) => {
        const edge:
          | "first"
          | "middle"
          | "last"
          | "single" =
          groupItems.length === 1
            ? "single"
            : i === 0
              ? "first"
              : i === groupItems.length - 1
                ? "last"
                : "middle";
        entries.push({ kind: "row", key: `r${session.id}`, session, edge });
      });
    });
    return entries;
  }, [keyword, sections, workspaces, workspaceSessions, expanded, creatingWs]);

  function renderEmpty() {
    if (!activeConnId) {
      return (
        <View className="flex-1 items-center justify-center gap-4 px-4">
          <View className="h-16 w-16 items-center justify-center rounded-full bg-field dark:bg-[#2C2C2E]">
            <Unplug size={26} color="#8E8E93" />
          </View>
          <Text className="text-center text-[15px] text-label2 dark:text-[#EBEBF599]">
            {t("chat:noConnection")}
          </Text>
          <Pressable
            onPress={() => router.push("/connections")}
            className="rounded-full px-5 py-2.5"
            style={{ backgroundColor: colors.primary }}
          >
            <Text className="text-[15px] font-medium text-white">
              {t("common:nav.toConnections")}
            </Text>
          </Pressable>
        </View>
      );
    }
    // 首拉中骨架占位（动效批续）：不闪「暂无会话」空态文案
    if (loading) {
      return <SkeletonSessionList />;
    }
    return (
      <View className="flex-1 items-center justify-center gap-3 px-4">
        <View className="h-16 w-16 items-center justify-center rounded-full bg-field dark:bg-[#2C2C2E]">
          {keyword ? (
            <Search size={26} color="#8E8E93" />
          ) : (
            <Inbox size={26} color="#8E8E93" />
          )}
        </View>
        <Text className="text-center text-[15px] text-label2 dark:text-[#EBEBF599]">
          {keyword ? t("chat:noResults") : t("chat:empty")}
        </Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1 }} edges={["bottom"]}>
      <View className="flex-1 bg-grouped dark:bg-black">
        {/* 搜索框（顶栏放大镜展开；store 内 400ms 防抖）。微信式：归档
            筛选收进搜索面板（细分线 + 居中的「未归档/全部」选项），
            收起搜索即复位「未归档」（search-ui store 内联动） */}
        {(searchOpen || keyword !== "") && (
          <View className="mx-4 mb-2 mt-2 rounded-xl bg-field dark:bg-[#2C2C2E]">
            <View className="flex-row items-center gap-2 px-3 py-2">
              <AppIcon
                name="magnifyingglass"
                fallback={Search}
                size={14}
                color="#8E8E93"
              />
              <TextInput
                value={keyword}
                onChangeText={search}
                placeholder={t("chat:searchPlaceholder")}
                placeholderTextColor="#8E8E93"
                returnKeyType="search"
                autoCorrect={false}
                className="flex-1 text-sm text-black dark:text-white"
              />
              {keyword !== "" && (
                <Pressable onPress={() => search("")} hitSlop={8}>
                  <X size={14} color="#8E8E93" />
                </Pressable>
              )}
              <Pressable
                onPress={() => {
                  search("");
                  closeSearch();
                }}
                hitSlop={8}
                accessibilityLabel={t("common:cancel")}
              >
                <Text className="text-sm" style={{ color: colors.primary }}>
                  {t("common:cancel")}
                </Text>
              </Pressable>
            </View>
            {/* 归档筛选（微信搜索面板式选项行） */}
            <View className="flex-row justify-center gap-10 border-t border-sep px-3 py-2 dark:border-[#3A3A3C]">
              <Pressable
                onPress={() => handleFilter(false)}
                hitSlop={6}
                accessibilityLabel={t("chat:filterActive")}
              >
                <Text
                  className={`text-[13px] ${!showArchived ? "font-medium" : ""}`}
                  style={{
                    color: showArchived ? "#8E8E93" : colors.primary,
                  }}
                >
                  {t("chat:filterActive")}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => handleFilter(true)}
                hitSlop={6}
                accessibilityLabel={t("chat:filterAll")}
              >
                <Text
                  className={`text-[13px] ${showArchived ? "font-medium" : ""}`}
                  style={{
                    color: showArchived ? colors.primary : "#8E8E93",
                  }}
                >
                  {t("chat:filterAll")}
                </Text>
              </Pressable>
            </View>
            {/* 时间筛选（A11 批：归档行下紧邻行，四钮组；选中主色调
                高亮，与归档筛选独立可叠加） */}
            <View className="flex-row justify-center gap-5 border-t border-sep px-3 py-2 dark:border-[#3A3A3C]">
              {TIME_FILTER_OPTIONS.map((opt) => {
                const selected = timeFilter === opt.value;
                return (
                  <Pressable
                    key={opt.value}
                    onPress={() => handleTimeFilter(opt.value)}
                    hitSlop={6}
                    accessibilityLabel={t(opt.labelKey)}
                  >
                    <Text
                      className={`text-[13px] ${selected ? "font-medium" : ""}`}
                      style={{
                        color: selected ? colors.primary : "#8E8E93",
                      }}
                    >
                      {t(opt.labelKey)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        )}

        {/* GL-P4/P5：整组卡 + 折叠懒加载。搜索态平铺组卡（全量 sections）；
            组态拍平为 组头/会话行/占位 异构条目——整列表虚拟化，展开大组
            只挂载可视窗口的行（性能批：旧结构整组建在一个 item 内，一次
            性挂载全部 Swipeable 行，展开/收缩全列表重渲染——会话一多即卡） */}
        <FlatList
          data={listData}
          keyExtractor={(item) => item.key}
          renderItem={({ item }) => {
            if (item.kind === "search") {
              return (
                <View>
                  <Text className="px-1 pb-1.5 pt-3 text-[13px] font-medium text-label2 dark:text-[#EBEBF599]">
                    {item.title}
                  </Text>
                  <View className="overflow-hidden rounded-2xl bg-card dark:bg-[#1C1C1E]">
                    {item.data.map((session) => (
                      <SessionEntryRow
                        key={session.id}
                        session={session}
                        summary={item.title}
                        edge="card"
                        onOpen={pushSession}
                        onLongPress={openSheetFor}
                        onTogglePin={togglePinFor}
                        onToggleArchive={archiveFor}
                        onDelete={deleteFor}
                      />
                    ))}
                  </View>
                </View>
              );
            }
            if (item.kind === "group") {
              return (
                <GroupHeaderRow
                  wsId={item.wsId}
                  title={item.title}
                  count={item.count}
                  open={item.open}
                  creating={item.creating}
                  gapTop={item.gapTop}
                  onToggle={toggleGroup}
                  onCreate={createIn}
                />
              );
            }
            if (item.kind === "pending") {
              return <GroupPendingRow state={item.state} />;
            }
            return (
              <SessionEntryRow
                session={item.session}
                edge={item.edge}
                onOpen={pushSession}
                onLongPress={openSheetFor}
                onTogglePin={togglePinFor}
                onToggleArchive={archiveFor}
                onDelete={deleteFor}
              />
            );
          }}
          onEndReached={() => void loadMore()}
          onEndReachedThreshold={0.3}
          onRefresh={() => {
            // 刷新：清单+搜索态全量（loadFirst 内含 workspace 清单），
            // 组缓存清后按展开组重拉
            void loadFirst();
            clearWorkspaceSessions();
            for (const key of expanded) {
              void loadWorkspaceSessions(key);
            }
          }}
          refreshing={refreshing}
          contentContainerStyle={{ flexGrow: 1, padding: 16 }}
          ListEmptyComponent={renderEmpty}
          // 虚拟化窗口收紧（性能批）：行长固定约 72pt，默认 windowSize=21
          // 屏挂载过剩；裁剪离屏行降低展开/滚动时的挂载与重排成本
          initialNumToRender={12}
          maxToRenderPerBatch={8}
          windowSize={9}
          updateCellsBatchingPeriod={50}
          removeClippedSubviews
          ListFooterComponent={
            <View className="pt-2">
              {loading && items.length > 0 && (
                <View className="py-3">
                  <ActivityIndicator size="small" color="#8E8E93" />
                </View>
              )}
            </View>
          }
        />

        {/* 长按操作面板（置顶/归档/删除/重命名） */}
        <SessionActionsSheet
          session={sheetSession}
          onTogglePin={(pinned) => {
            if (sheetSession) void handleUpdate(sheetSession.id, { pinned });
          }}
          onToggleArchive={(archived) => {
            if (!sheetSession) return;
            // B5：面板归档与左滑同链——撤销条范式；取消归档直还原
            if (archived) archiveFor(sheetSession);
            else void handleUpdate(sheetSession.id, { archived: false });
          }}
          onRename={() => {
            setRenameTarget(sheetSession);
            setSheetSession(null);
          }}
          onDelete={() => {
            if (!sheetSession) return;
            setSheetSession(null);
            confirmDelete(sheetSession);
          }}
          onClose={() => setSheetSession(null)}
        />
        <SessionRenameDialog
          session={renameTarget}
          onSubmit={(title) => void handleRename(title)}
          onClose={() => setRenameTarget(null)}
        />
      </View>
    </SafeAreaView>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Stack, useLocalSearchParams } from "expo-router";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Keyboard,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import {
  FolderOutput,
  Minimize2,
  MoreVertical,
  Search,
} from "lucide-react-native";
import { ENDPOINTS, type ServerEvent } from "@tianshu/protocol";

import { ApprovalBanner } from "@/components/ApprovalBanner";
import { AppActionSheet } from "@/components/AppActionSheet";
import { Composer, type PendingImage } from "@/components/Composer";
import { ExpertChip } from "@/components/ExpertChip";
import { FileRefPicker } from "@/components/FileRefPicker";
import { FilePreviewModal } from "@/components/FilePreviewModal";
import { MessageActionsSheet } from "@/components/MessageActionsSheet";
import { MessageItem, type SearchHighlight } from "@/components/MessageItem";
import { ModeChip } from "@/components/ModeChip";
import { ModelGuideBar } from "@/components/ModelGuideBar";
import { ModelPicker } from "@/components/ModelPicker";
import { PermissionChip } from "@/components/PermissionChip";
import { SkillRefPicker } from "@/components/SkillRefPicker";
import { SessionFilesSheet } from "@/components/SessionFilesSheet";
import { SessionSearchBar } from "@/components/SessionSearchBar";
import { UsageChip } from "@/components/UsageChip";
import { tapLight } from "@/lib/haptics";
import { relativeTimeLabel } from "@/lib/relative-time-label";
import { toast } from "@/lib/toast-bus";
import { deriveAgentProgress } from "@/logic/agent-progress";
import type { MessageBlock } from "@/logic/blocks";
import { takePhoto } from "@/logic/camera-pick";
import { buildInjectedContent } from "@/logic/file-refs";
import { pickLocalFiles, type FileRejectReason } from "@/logic/file-pick";
import { ImageTooLargeError } from "@/logic/image-pick";
import {
  nextHitPosition,
  searchMessagePositions,
} from "@/logic/message-search";
import { modelNameMap } from "@/logic/model-bundle";
import { liveBlocks } from "@/logic/remote-stream";
import Animated, { FadeIn } from "react-native-reanimated";
import { deriveSessionFiles, type SessionFile } from "@/logic/session-files";
import { formatRelative } from "@/logic/time";
import { timeSeparatorKeys } from "@/logic/time-separators";
import { useProvidersStore } from "@/store/providers.store";
import { useCreateExpertPromptStore } from "@/store/create-expert-prompt.store";
import { useSessionToolsStore } from "@/store/session-tools.store";
import {
  subscribeTransportEvents,
  useConnectionCapabilities,
  useConnectionsStore,
} from "@/store/connections.store";
import { useStreamStore } from "@/store/stream.store";
import { useThemeColors } from "@/store/theme";
import type { TransportState } from "@/transport/types";
import { wireRequest } from "@/transport/wire";

/** 流列表行（FlatList inverted：数组首元素渲染于底部——新→旧倒排） */
interface RowItem {
  key: string;
  role: string;
  blocks: MessageBlock[];
  /** 定稿消息 id（live 行缺省——编辑重发定位用） */
  id?: number;
  /** user 轮纯文本（text 块拼接——编辑预填用） */
  text?: string;
  /** 定稿消息创建时间（live 行缺省——时间分隔标记用） */
  createdAt?: string;
  /** 当条 assistant 输出模型行 id（B5 消息元信息反查模型名；缺省不展示） */
  modelId?: number;
  /** 当条 assistant 输出耗时毫秒（durationMs 批消息元信息；缺省不展示） */
  durationMs?: number;
}

/** 流错误红（语义状态色非主题色） */
const ERROR_RED = "#FF3B30";

/** 本地文件拒绝原因 → chat ns 文案 key（pick 链部分拒绝提示用） */
const FILE_REJECT_KEYS: Record<FileRejectReason, string> = {
  tooLarge: "fileTooLargeLocal",
  imageTooLarge: "imageTooLargeMobile",
  binary: "fileBinaryUnsupported",
  read: "fileReadFailed",
};

/**
 * 会话流页（T14）：历史（getById 定稿）+ 流式 live 块（message.chunk 事件
 * 按 sessionId 过滤归并）+ 发送/中止；finish/error 后 store 定稿重拉覆写。
 * T15 收口：审批 Banner（live.approvals 队首，POST approve 决议）、头部
 * 模型胶囊（M2b：capability 门禁提升 connections 层由组件自吃缓存，
 * provider/query 选定随 startSend 携带）。
 */
export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const sessionId = Number(id);
  const { t } = useTranslation("chat");
  const colors = useThemeColors();
  const activeConnId = useConnectionsStore((s) => s.activeConnId);

  const entry = useStreamStore((s) => s.bySession[sessionId]);
  const sending = entry?.sending ?? false;
  const errorText =
    entry?.error != null
      ? entry.error !== ""
        ? entry.error
        : t("sendFailed")
      : null;
  const activeState = useConnectionsStore((s) =>
    activeConnId ? (s.states[activeConnId] ?? "idle") : undefined,
  );

  const [modeOverride, setModeOverride] = useState<
    "agent" | "ask" | "plan" | null
  >(null);
  useEffect(() => {
    setModeOverride(null);
  }, [sessionId]);

  // 选定模型（会话页 state；startSend 携带，且选中即 session/update 写回
  // 会话——重进从 sessionModelId 恢复，不再每次重选）；能力门禁已提升
  // connections 层（M2b）——ModelPicker 自吃 useConnectionCapabilities
  const [modelId, setModelId] = useState<number | null>(null);
  // 恢复：服务端记住的上次选择兜住本地未选态（用户本轮已手选则不覆盖）
  const sessionModelId = entry?.sessionModelId ?? null;
  useEffect(() => {
    if (modelId === null && sessionModelId !== null) {
      setModelId(sessionModelId);
    }
  }, [modelId, sessionModelId]);
  // 选中即写会话（对齐桌面 ModelPicker session:setModel 持久语义；HD 批
  // session/update currentModelId）。失败不回滚本地——本次 send 仍携带
  const handlePickModel = useCallback(
    (next: number) => {
      setModelId(next);
      void wireRequest("POST", ENDPOINTS.session.update, {
        sessionId,
        currentModelId: next,
      }).then((r) => {
        if (!r.ok) toast.error(t("modelSaveFailed"));
      });
    },
    [sessionId, t],
  );
  // 本端已应答的 toolCallId（POST approve 成功即标记——不等 tool-update
  // chunk 往返，队列下一项即刻顶上）
  const [respondedIds, setRespondedIds] = useState<string[]>([]);
  // MB-T1 图片链：files 能力门禁（capability 协商——未知不视为具备）+
  // 选图暂存（发送时 startSend 逐张 uploadImage；弃发即弃图）
  const capabilities = useConnectionCapabilities(activeConnId);
  const filesCap = useMemo(
    () => capabilities?.includes("files") ?? false,
    [capabilities],
  );
  /** B5 无模型引导条：provider 能力决定引导条 CTA（去配置/桌面端提示） */
  const providerCap = useMemo(
    () => capabilities?.includes("provider") ?? false,
    [capabilities],
  );
  // providers bundle 单次探测（会话页挂载触发一次）：模型名反查/无模型
  // 引导条/ModelPicker 三方共用 store 缓存——不为引导单独重拉全量
  const providerBundle = useProvidersStore((s) => s.bundle);
  useEffect(() => {
    if (activeConnId != null && providerBundle === null) {
      void useProvidersStore.getState().load();
    }
  }, [activeConnId, providerBundle]);
  /** 模型行 id → 展示名（消息 wire modelId 反查；bundle 未载/行已删不展示） */
  const modelNames = useMemo(
    () => modelNameMap(providerBundle),
    [providerBundle],
  );
  /** 无模型引导条关闭态：本会话内记住（页面态——重进会话重置露出） */
  const [modelGuideDismissed, setModelGuideDismissed] = useState(false);
  useEffect(() => {
    setModelGuideDismissed(false);
  }, [sessionId]);
  // 暂存图（多张——上传文件分流批：图片文件经 file-pick 分流为多模态
  // 暂存，发送时 startSend 逐张 uploadImage；弃发即弃图）
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  // LT-T4 文件引用：选中路径暂存（发送时 filesRead 读内容拼前缀注入）
  const [fileRefs, setFileRefs] = useState<string[]>([]);
  const [fileRefOpen, setFileRefOpen] = useState(false);
  // 本地文件上传（添加文件对齐批）：内容选择时已读入（512KB/NUL 守卫在
  // pick 链），发送时直接并入注入块——同名后选覆盖
  const [localFiles, setLocalFiles] = useState<
    Array<{ name: string; content: string }>
  >([]);
  const handlePickLocalFile = useCallback(async () => {
    try {
      const result = await pickLocalFiles();
      if (result == null) return;
      if (result.picked.length > 0) {
        setLocalFiles((prev) => [
          ...prev.filter((f) => !result.picked.some((p) => p.name === f.name)),
          ...result.picked,
        ]);
      }
      // 图片分流（融合批）：多模态暂存（同名覆盖——重选同图以新替旧）
      if (result.images.length > 0) {
        setPendingImages((prev) => [
          ...prev.filter((p) => !result.images.some((i) => i.name === p.name)),
          ...result.images,
        ]);
      }
      if (result.rejected.length > 0) {
        // 部分拒绝不阻断已选（一行列出——逐条 toast 太吵）
        toast.warning(
          result.rejected
            .map((r) => `${r.name}：${t(FILE_REJECT_KEYS[r.reason])}`)
            .join(", "),
        );
      }
    } catch (e) {
      const detail =
        e instanceof Error && e.message !== "" ? `：${e.message}` : "";
      toast.error(`${t("fileReadFailed")}${detail}`);
    }
  }, [t]);
  // 拍照输入（输入层现代化批）：相机 → 多模态压缩链 → pendingImages
  // 暂存（与上传文件图片分流同链；超限 toast 图片专用文案）
  const handleTakePhoto = useCallback(async () => {
    try {
      const shot = await takePhoto();
      if (shot == null) return; // 用户取消（present 冲突秒回重试在 takePhoto 内）
      if (shot === "denied") {
        toast.info(t("cameraPermissionDenied"));
        return;
      }
      setPendingImages((prev) => [...prev, shot]);
    } catch (e) {
      if (e instanceof ImageTooLargeError) {
        toast.error(t("imageTooLargeMobile"));
        return;
      }
      // 真机排障：带具体原因（HEIC/读取/压缩环节差异化定位）
      const detail =
        e instanceof Error && e.message !== "" ? `：${e.message}` : "";
      toast.error(`${t("fileReadFailed")}${detail}`);
    }
  }, [t]);
  // 技能引用（功能对齐批）：选中技能名暂存（发送时 skills/read 读全文以
  // [引用技能] 前缀并入——对齐 PC @技能 token 注入语义）
  const [skillRefs, setSkillRefs] = useState<string[]>([]);
  const [skillRefOpen, setSkillRefOpen] = useState(false);
  // 专家快捷提示（功能对齐批）：选中专家的 quickPrompts chips 展示；
  // 点击以 prefill 填入 Composer（nonce 保证同文本重复点击生效）
  const [expertPrompts, setExpertPrompts] = useState<string[]>([]);
  const [prefill, setPrefill] = useState<{
    text: string;
    nonce: number;
  } | null>(null);
  // 键盘避让高度（手动方案，见渲染区注释）
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", (e) => {
      setKeyboardHeight(e.endCoordinates.height);
    });
    const hide = Keyboard.addListener("keyboardDidHide", () => {
      setKeyboardHeight(0);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // MT-T2 专家：选中随 startSend 携带（请求级覆盖）；MT-T1 用量刷新信号
  // （sending 下降沿 bump——finish/error 收尾后重拉）
  const [expertId, setExpertId] = useState<number | null>(null);
  const [usageRefresh, setUsageRefresh] = useState(0);
  useEffect(() => {
    if (!sending) setUsageRefresh((n) => n + 1);
  }, [sending]);

  // MB-T3 重生成（UX 批）：操作面板触发即执行——面板本身即确认层
  // （原 Alert 二次确认打断心流），流中由长按禁用把守
  const handleRegenerate = useCallback(() => {
    if (sending) return;
    void useStreamStore.getState().regenerate(sessionId);
  }, [sending, sessionId]);

  // —— A9 阶段 2 compact：更多面板入口 → Alert 确认 → POST session/compact
  // （异步 202 受理）→ toast；完成后被控端发 session.updated（下方订阅内
  // 重拉 getById 刷新——刷新信号语义，不轮询） ——
  const compacting = useSessionToolsStore((s) => s.compacting);
  const [moreOpen, setMoreOpen] = useState(false);
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  useEffect(() => {
    setSummaryExpanded(false);
  }, [sessionId]);
  const handleCompact = useCallback(() => {
    if (sending || compacting) return;
    Alert.alert(t("compactConfirmTitle"), t("compactConfirmMessage"), [
      { text: t("common:cancel"), style: "cancel" },
      {
        text: t("common:confirm"),
        onPress: () => {
          void useSessionToolsStore
            .getState()
            .compact(sessionId)
            .then((accepted) => {
              if (accepted) {
                toast.info(t("compactAccepted"));
              } else {
                toast.error(t("compactFailed"));
              }
            });
        },
      },
    ]);
  }, [sending, compacting, sessionId, t]);

  // —— A9 阶段 3 polish：Composer 润色键回调——调 session/polish（同步
  // 30s 窗口由被控端把握），成功 toast + 返回润色文本（Composer 替换草稿）；
  // 失败 toast 有用文案（业务 message 透传，空则兜底）+ 返回 null（草稿不动） ——
  const handlePolish = useCallback(
    async (draft: string) => {
      const r = await useSessionToolsStore
        .getState()
        .polish(draft, entry?.sessionWorkspaceId ?? null);
      if (r.ok) {
        toast.info(t("polishDone"));
        return r.text;
      }
      toast.error(r.message !== "" ? r.message : t("polishFailed"));
      return null;
    },
    [entry?.sessionWorkspaceId, t],
  );

  // LT-T2 编辑重发：user 轮长按 → Composer 编辑态（key remount 预填）
  const [editing, setEditing] = useState<{
    messageId: number;
    initialText: string;
  } | null>(null);
  const handleEditResend = useCallback(
    (row: RowItem) => {
      if (sending || row.id == null || row.text == null) return;
      // 编辑重发不带图/引用/本地文件（editAndResend 无附件参）——进编辑态即清，
      // 防Composer remount 后 pill 残留误导「会随编辑消息带上」
      setPendingImages([]);
      setFileRefs([]);
      setSkillRefs([]);
      setLocalFiles([]);
      setEditing({ messageId: row.id, initialText: row.text });
    },
    [sending],
  );

  // 挂载拉历史 + 订阅本会话 chunk/error 事件（server.connected 重连后重拉
  // 定稿对齐服务端真值）；卸载退订并清理 store 条目
  useEffect(() => {
    if (!Number.isFinite(sessionId)) return;
    const { loadHistory, applyChunk, applySessionError, clear } =
      useStreamStore.getState();
    void loadHistory(sessionId);
    const unsub = subscribeTransportEvents((e: ServerEvent) => {
      if (e.type === "message.chunk" && e.payload.sessionId === sessionId) {
        applyChunk(sessionId, e.payload.chunk);
      } else if (
        e.type === "session.error" &&
        e.payload.sessionId === sessionId
      ) {
        applySessionError(sessionId, e.payload.message);
      } else if (
        // A9 compact 批：压缩完成等会话变更信号——重拉 getById 刷新
        // （history 覆写 + summary 提示条；同 automation.changed 刷新信号语义）
        e.type === "session.updated" &&
        e.payload.id === sessionId
      ) {
        void loadHistory(sessionId);
      } else if (e.type === "server.connected") {
        void loadHistory(sessionId);
      }
    });
    return () => {
      unsub();
      clear(sessionId);
    };
  }, [sessionId]);

  // 对话式创建（体验精修批）：专家页「对话式创建」经跨页桥携带来的
  // 访谈式引导语——挂载消费一次并自动发送（store 读后即清，防重发）
  useEffect(() => {
    if (!Number.isFinite(sessionId)) return;
    const pending = useCreateExpertPromptStore
      .getState()
      .consumePendingPrompt();
    if (pending == null) return;
    void useStreamStore.getState().startSend(sessionId, pending);
  }, [sessionId]);

  // 断线解锁（fix1）：sending 中连接掉线（closed/invalid-token 或
  // connected→reconnecting）后 finish/error chunk 无期——置错收口防锁死
  const prevTransportRef = useRef<TransportState | undefined>(undefined);
  useEffect(() => {
    const prev = prevTransportRef.current;
    prevTransportRef.current = activeState;
    if (
      !Number.isFinite(sessionId) ||
      activeState == null ||
      prev === activeState
    ) {
      return;
    }
    const dropped =
      activeState === "closed" ||
      activeState === "invalid-token" ||
      (prev === "connected" && activeState === "reconnecting");
    if (dropped) {
      useStreamStore
        .getState()
        .handleTransportDown(sessionId, t("connectionLost"));
    }
  }, [activeState, sessionId, t]);

  // 倒置列表数据：index 0 = 最新（live 优先于定稿 history 末条）。
  // text 为 text 块拼接（UX 批起不分 role——复制/编辑预填两用）
  const rows = useMemo<RowItem[]>(() => {
    if (!entry) return [];
    const chronological: RowItem[] = entry.history.map((m) => ({
      key: `h-${m.id}`,
      role: m.role,
      blocks: m.blocks,
      id: m.id,
      createdAt: m.createdAt,
      modelId: m.modelId,
      durationMs: m.durationMs,
      text: m.blocks
        .filter((b) => b.type === "text")
        .map((b) => (b as { text?: string }).text ?? "")
        .join("\n"),
    }));
    const live = liveBlocks(entry.live) as MessageBlock[];
    if (live.length > 0) {
      chronological.push({
        key: "live",
        role: "assistant",
        blocks: live,
      });
    }
    return chronological.reverse();
  }, [entry]);

  // 微信范式时间分隔：rows 为倒置列表，先翻回正序计算，再按原 key 标记
  const separatorKeys = useMemo(() => {
    const chronological = [...rows].reverse();
    return timeSeparatorKeys(
      chronological.map((r) => ({ key: r.key, createdAt: r.createdAt })),
    );
  }, [rows]);

  // —— 会话内搜索（位置级批）：本地对 history 匹配（规则见
  // message-search——零协议）；300ms 防抖在 SessionSearchBar 内 ——
  const [searchOpen, setSearchOpen] = useState(false);
  /** 防抖后的搜索关键字（"" = 未在搜） */
  const [searchQuery, setSearchQuery] = useState("");
  /** 当前命中位置（searchHits 内 0 基，逐位导航循环） */
  const [searchActivePos, setSearchActivePos] = useState(0);
  useEffect(() => {
    setSearchOpen(false);
    setSearchQuery("");
    setSearchActivePos(0);
  }, [sessionId]);
  /** 命中位置数组（history 时序序；计数/导航均按位） */
  const searchHits = useMemo(
    () => searchMessagePositions(entry?.history ?? [], searchQuery),
    [entry?.history, searchQuery],
  );
  /** 当前命中位置收敛（关键字变化/消息增减后防越界） */
  const clampedSearchPos =
    searchHits.length === 0
      ? 0
      : Math.min(searchActivePos, searchHits.length - 1);
  const searchActive = searchOpen && searchQuery.trim() !== "";
  /** 当前命中位的消息索引（history 时序序；无命中 null） */
  const searchActiveMessageIdx =
    searchActive && searchHits.length > 0
      ? (searchHits[clampedSearchPos]?.messageIdx ?? null)
      : null;
  /** 命中行 key 集合（消息级——含任一命中即入列；rows 倒置索引翻转） */
  const searchHitKeys = useMemo(() => {
    if (!searchActive || searchHits.length === 0) return null;
    const keys = new Set<string>();
    for (const hit of searchHits) {
      const row = rows[rows.length - 1 - hit.messageIdx];
      if (row) keys.add(row.key);
    }
    return keys;
  }, [searchActive, searchHits, rows]);
  /** 当前命中行 key（rows 倒置——history 索引翻转为行 key） */
  const searchActiveRowKey =
    searchActiveMessageIdx != null
      ? (rows[rows.length - 1 - searchActiveMessageIdx]?.key ?? null)
      : null;
  /** 当前命中行的倒置列表行号（滚动定位用；无命中 null） */
  const searchActiveRowIndex =
    searchActiveRowKey != null
      ? rows.findIndex((r) => r.key === searchActiveRowKey)
      : -1;
  /** 逐词高亮映射：行 key → text 块下标 → 块内命中区间（active=当前位）。
   *  全部命中消息都渲染高亮（非当前位半透明底），桌面 <mark> 同口径 */
  const searchHighlightByKey = useMemo(() => {
    if (!searchActive || searchHits.length === 0) return null;
    const map = new Map<string, SearchHighlight>();
    searchHits.forEach((hit, pos) => {
      const row = rows[rows.length - 1 - hit.messageIdx];
      if (!row) return;
      let byBlock = map.get(row.key);
      if (byBlock == null) {
        byBlock = new Map();
        map.set(row.key, byBlock);
      }
      const blockIdx = hit.blockIdx ?? 0;
      const ranges = byBlock.get(blockIdx) ?? [];
      ranges.push({
        start: hit.start,
        length: hit.length,
        active: pos === clampedSearchPos,
      });
      byBlock.set(blockIdx, ranges);
    });
    return map;
  }, [searchActive, searchHits, rows, clampedSearchPos]);

  // 命中消息滚动定位（输入即定位第一条，上/下逐条切换；scrollToIndex
  // 失败——行高未实测/目标在渲染窗口外——退 scrollToOffset 粗定位后重试）
  const listRef = useRef<FlatList<RowItem>>(null);
  useEffect(() => {
    if (searchActiveRowIndex < 0) return;
    listRef.current?.scrollToIndex({
      index: searchActiveRowIndex,
      viewPosition: 0.5,
      animated: true,
    });
  }, [searchActiveRowIndex]);
  const handleScrollToIndexFailed = useCallback(
    (info: { index: number; averageItemLength: number }) => {
      listRef.current?.scrollToOffset({
        offset: Math.max(0, info.index * info.averageItemLength),
        animated: false,
      });
      setTimeout(() => {
        listRef.current?.scrollToIndex({
          index: info.index,
          viewPosition: 0.5,
          animated: false,
        });
      }, 100);
    },
    [],
  );
  const handleSearchNext = useCallback(() => {
    setSearchActivePos((pos) => nextHitPosition(pos, searchHits.length, 1));
  }, [searchHits.length]);
  const handleSearchPrev = useCallback(() => {
    setSearchActivePos((pos) => nextHitPosition(pos, searchHits.length, -1));
  }, [searchHits.length]);

  // 会话文件派生（MR-T6）：write 产物 + 引用文件；live 合并 writing 态
  const sessionFiles = useMemo(
    () => deriveSessionFiles(entry?.history ?? [], entry?.live ?? null),
    [entry?.history, entry?.live],
  );
  const [filesSheetOpen, setFilesSheetOpen] = useState(false);
  const [previewFile, setPreviewFile] = useState<SessionFile | null>(null);

  // 长按操作面板（UX 批）：user [复制/编辑并重发] · assistant [复制/
  // 重新生成]——操作具名可发现，替代原长按直触 + Alert 二次确认
  const [actionTarget, setActionTarget] = useState<RowItem | null>(null);
  const handleOpenActions = useCallback(
    (item: RowItem) => {
      if (sending) return;
      if (item.role !== "user" && item.role !== "assistant") return;
      if (item.role === "assistant" && item.id == null) return; // live 流未定稿
      setActionTarget(item);
    },
    [sending],
  );
  const handleCopyMessage = useCallback(() => {
    const text = actionTarget?.text ?? "";
    if (text === "") return;
    void Clipboard.setStringAsync(text)
      .then(() => toast.info(t("copied")))
      .catch(() => toast.error(t("copyFailed")));
  }, [actionTarget, t]);

  const renderItem = useCallback(
    ({ item }: { item: RowItem }) => {
      // 搜索逐词高亮（位置级批）：命中消息按块内区间渲染主色底——当前
      // 导航位实底、其余半透明（桌面 mark 同口径）；消息级边框自 v1 降级
      const isHit = searchHitKeys?.has(item.key) ?? false;
      return (
        <View className="rounded-xl">
          {separatorKeys.has(item.key) && item.createdAt != null && (
            <Text className="mb-2 mt-1 text-center text-xs text-label3 dark:text-[#EBEBF54D]">
              {relativeTimeLabel(formatRelative(item.createdAt), t)}
            </Text>
          )}
          <Pressable
            // UX 批：长按弹操作面板（复制/编辑/重生成，流中禁用）
            onLongPress={() => {
              tapLight();
              handleOpenActions(item);
            }}
            delayLongPress={350}
            disabled={false}
          >
            {/* workspaceId：user 消息引用文件卡片点击 files/read 拉全文用；
              live 流式行（无定稿 id）进入淡入（动效批）；modelName/durationMs：
              消息元信息——当条 assistant 输出模型名（wire modelId 反查）与
              耗时（wire durationMs 直透），缺省不展示 */}
            <MessageItem
              role={item.role}
              blocks={item.blocks}
              workspaceId={entry?.sessionWorkspaceId ?? null}
              modelName={
                item.modelId != null
                  ? (modelNames.get(item.modelId) ?? null)
                  : null
              }
              durationMs={item.durationMs}
              animateEnter={item.id == null}
              searchHighlight={
                isHit
                  ? (searchHighlightByKey?.get(item.key) ?? undefined)
                  : undefined
              }
            />
          </Pressable>
        </View>
      );
    },
    [
      handleOpenActions,
      entry?.sessionWorkspaceId,
      modelNames,
      separatorKeys,
      searchHitKeys,
      searchHighlightByKey,
      t,
    ],
  );

  // Agent 进度行派生（MR-T3，桌面 AgentProgress 同口径）
  const progress = useMemo(
    () => deriveAgentProgress(sending ? (entry?.live ?? null) : null),
    [sending, entry?.live],
  );

  // 待应答审批（FIFO 队首渲染；本端已应答即滤除，真出队靠 tool-update chunk）
  const pendingApprovals = useMemo(() => {
    const approvals = entry?.live.approvals ?? [];
    return approvals.filter((a) => !respondedIds.includes(a.toolCallId));
  }, [entry, respondedIds]);
  const approvalHead = pendingApprovals[0];

  function renderEmpty() {
    if (!activeConnId) {
      return (
        <View className="flex-1 items-center justify-center px-4">
          <Text className="text-center text-sm text-label2 dark:text-[#EBEBF599]">
            {t("noConnection")}
          </Text>
        </View>
      );
    }
    if (entry?.loading) {
      return (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="small" color="#8E8E93" />
        </View>
      );
    }
    if (entry?.loadError) {
      return (
        <View className="flex-1 items-center justify-center gap-3 px-4">
          <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
            {t("loadFailed")}
          </Text>
          <Pressable
            onPress={() =>
              void useStreamStore.getState().loadHistory(sessionId)
            }
            className="rounded-lg px-4 py-2"
            style={{ backgroundColor: colors.primary }}
          >
            <Text className="text-sm text-white">{t("retry")}</Text>
          </Pressable>
        </View>
      );
    }
    return (
      <View className="flex-1 items-center justify-center px-4">
        <Text className="text-center text-sm text-label2 dark:text-[#EBEBF599]">
          {t("noMessages")}
        </Text>
      </View>
    );
  }

  if (!Number.isFinite(sessionId)) {
    return (
      <View className="flex-1 items-center justify-center bg-white px-4 dark:bg-black">
        <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
          {t("invalidSession")}
        </Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1 }} edges={["bottom"]}>
      <View className="flex-1 bg-white dark:bg-black">
        <Stack.Screen
          options={{
            title: entry?.sessionTitle ?? t("untitled"),
            headerRight: () => (
              <View className="mr-1 flex-row items-center gap-3">
                <Pressable
                  onPress={() => setMoreOpen(true)}
                  accessibilityLabel={t("moreActions")}
                  hitSlop={8}
                >
                  <MoreVertical size={18} color="#8E8E93" />
                </Pressable>
                <Pressable
                  onPress={() => {
                    setSearchOpen((open) => !open);
                    setSearchQuery("");
                    setSearchActivePos(0);
                  }}
                  accessibilityLabel={t("searchToggle")}
                  hitSlop={8}
                >
                  <Search
                    size={18}
                    color={searchOpen ? colors.primary : "#8E8E93"}
                  />
                </Pressable>
                {sessionFiles.length > 0 && (
                  <Pressable
                    onPress={() => setFilesSheetOpen(true)}
                    accessibilityLabel={t("filesSheetTitle")}
                    hitSlop={8}
                  >
                    <FolderOutput size={18} color={colors.primary} />
                  </Pressable>
                )}
              </View>
            ),
          }}
        />
        {/* 键盘避让（真机二修）：KeyboardAvoidingView 在 Expo Go/Android
            上不可靠（behavior 三值均实测无效）——改手动 Keyboard 事件
            驱动底部 padding（平台无关，直接顶起 Composer） */}
        <View className="flex-1" style={{ paddingBottom: keyboardHeight }}>
          {rows.length > 0 ? (
            <FlatList
              ref={listRef}
              data={rows}
              inverted
              keyExtractor={(item) => item.key}
              renderItem={renderItem}
              onScrollToIndexFailed={handleScrollToIndexFailed}
              contentContainerStyle={{ padding: 12 }}
            />
          ) : (
            // 空态独立渲染（彻底绕开 inverted 对 ListEmptyComponent 的
            // 镜像行为——RN 版本间实现不一致，transform 抵消后真机仍反）
            <View className="flex-1">{renderEmpty()}</View>
          )}

          {/* 专家快捷提示（功能对齐批，对齐 PC quickPrompts）：横滑 chips
              点击填入输入框（替换全文——PC setContent(prompt) 同口径） */}
          {!sending && expertPrompts.length > 0 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              /* RN ScrollView 基样式自带 flexGrow/flexShrink:1——在消息列
                 与输入区之间会吞掉全部剩余纵向空间，chips 又被内容容器
                 交叉轴 stretch 撑成满高圆块；两处都显式关掉 */
              style={{ flexGrow: 0, flexShrink: 0 }}
              contentContainerStyle={{
                paddingHorizontal: 12,
                paddingBottom: 4,
                gap: 6,
                alignItems: "flex-start",
              }}
            >
              {expertPrompts.map((prompt) => (
                <Pressable
                  key={prompt}
                  onPress={() =>
                    setPrefill({ text: prompt, nonce: Date.now() })
                  }
                  className="rounded-full border px-3 py-1"
                  style={{
                    borderColor: `${colors.primary}40`,
                    backgroundColor: colors.subtle,
                  }}
                >
                  <Text
                    className="text-xs"
                    style={{ color: colors.primary }}
                    numberOfLines={1}
                  >
                    {prompt}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          )}

          {sending && (
            <View className="flex-row items-center gap-2 px-4 pb-1">
              <ActivityIndicator size="small" color={colors.primary} />
              <Text
                numberOfLines={1}
                className="text-xs text-label2 dark:text-[#EBEBF599]"
              >
                {progress.preparing
                  ? t("agentPreparing")
                  : progress.activeTool != null
                    ? t("agentStep", {
                        step: progress.stepCount,
                        tool: progress.activeTool,
                      })
                    : t("agentResponding")}
              </Text>
            </View>
          )}
          {errorText != null && (
            <Animated.View entering={FadeIn.duration(180)}>
              <Text
                numberOfLines={2}
                className="px-4 pb-1 text-xs"
                style={{ color: ERROR_RED }}
              >
                {errorText}
              </Text>
            </Animated.View>
          )}

          {approvalHead !== undefined && (
            <ApprovalBanner
              // 队列推进复用实例会串 busy/stale 内部态——按 toolCallId 重建
              key={approvalHead.toolCallId}
              sessionId={sessionId}
              item={approvalHead}
              queueCount={pendingApprovals.length - 1}
              // 审批记住批：会话绑定工作空间才露出「允许并记住」
              canRemember={entry?.sessionWorkspaceId != null}
              onResponded={() =>
                setRespondedIds((ids) => [...ids, approvalHead.toolCallId])
              }
            />
          )}

          {/* B5 无模型配置引导条：bundle 拉取过且零可对话模型时露出
              （输入区上方）；capability 含 provider → 跳 /providers，否则
              提示桌面端配置；可关闭（本会话内记住） */}
          {/* A9 compact 批：压缩提示条（v1 从简）——服务端 summary 非空即
              露出，点按展开/收起摘要全文；无 summary（旧被控端）不渲染 */}
          {entry?.sessionSummary != null && entry.sessionSummary !== "" && (
            <Pressable
              onPress={() => setSummaryExpanded((v) => !v)}
              className="flex-row items-center gap-2 px-4 py-2"
              style={{ backgroundColor: colors.subtle }}
              accessibilityLabel={t("compactSummaryToggle")}
            >
              <Text
                className="shrink-0 text-xs"
                style={{ color: colors.primary }}
              >
                {t("compactBarLabel")}
              </Text>
              <Text
                className={`flex-1 text-xs text-label2 dark:text-[#EBEBF599] ${summaryExpanded ? "" : "shrink"}`}
                numberOfLines={summaryExpanded ? undefined : 1}
              >
                {entry.sessionSummary}
              </Text>
              <Text className="shrink-0 text-xs text-label3 dark:text-[#EBEBF54D]">
                {summaryExpanded
                  ? t("compactSummaryCollapse")
                  : t("compactSummaryExpand")}
              </Text>
            </Pressable>
          )}

          <ModelGuideBar
            dismissed={modelGuideDismissed}
            canConfigure={providerCap}
            onDismiss={() => setModelGuideDismissed(true)}
          />

          {searchOpen && (
            <SessionSearchBar
              hitCount={searchHits.length}
              activePos={clampedSearchPos}
              onQueryChange={(query) => {
                setSearchQuery(query);
                setSearchActivePos(0);
              }}
              onPrev={handleSearchPrev}
              onNext={handleSearchNext}
              onClose={() => {
                setSearchOpen(false);
                setSearchQuery("");
                setSearchActivePos(0);
              }}
            />
          )}

          <Composer
            key={editing != null ? `editing-${editing.messageId}` : "compose"}
            sending={sending}
            editingInitialText={editing?.initialText ?? null}
            onCancelEdit={() => setEditing(null)}
            filesCap={filesCap}
            pendingImages={pendingImages}
            onRemoveImage={(name) =>
              setPendingImages((prev) => prev.filter((p) => p.name !== name))
            }
            onPickFileRef={() => setFileRefOpen(true)}
            fileRefs={fileRefs}
            onRemoveFileRef={(path) =>
              setFileRefs((prev) => prev.filter((p) => p !== path))
            }
            onPickLocalFile={() => void handlePickLocalFile()}
            onTakePhoto={() => void handleTakePhoto()}
            localFiles={localFiles}
            onRemoveLocalFile={(name) =>
              setLocalFiles((prev) => prev.filter((f) => f.name !== name))
            }
            onPickSkillRef={() => setSkillRefOpen(true)}
            skillRefs={skillRefs}
            onRemoveSkillRef={(name) =>
              setSkillRefs((prev) => prev.filter((p) => p !== name))
            }
            prefill={prefill}
            /* 输入区上方 chips 可见行：权限/专家/模式在左，用量/模型在右 */
            bottomLeft={
              <>
                <PermissionChip sessionId={sessionId} />
                <ExpertChip
                  selectedId={expertId}
                  onPick={setExpertId}
                  onPromptsChange={setExpertPrompts}
                />
                <ModeChip
                  sessionId={sessionId}
                  initialMode={modeOverride ?? entry?.sessionMode ?? "agent"}
                  onModeChange={setModeOverride}
                />
              </>
            }
            bottomRight={
              <>
                <UsageChip sessionId={sessionId} refreshKey={usageRefresh} />
                {/* 选中即写会话 + 随 startSend 携带（capability 门禁在
                    组件内吃 connections 层缓存） */}
                <ModelPicker modelId={modelId} onPick={handlePickModel} />
              </>
            }
            onSend={async (content) => {
              // LT-T2 编辑态分流：改写该 user 轮 + 截断重跑（不带图）
              if (editing != null) {
                const accepted2 = await useStreamStore
                  .getState()
                  .editAndResend(sessionId, editing.messageId, content);
                if (accepted2) setEditing(null);
                return accepted2;
              }
              // LT-T4 引用注入（引用式批）：agent/plan 会话工作空间文件
              // 引用式——不拉内容，只注路径 + read 指示（服务端 agent
              // 自读，省双程流量，面板只显示路径行）；ask 会话无工具集
              // （无头端 chat-runner ask → []），回退内容注入（files/read
              // 拉全文——读失败该引用跳过并提示，对齐桌面「读失败不阻断
              // 发送」口径）；技能逐个 skills/read 全文注入（对齐 PC @技能
              // token 注入语义）
              const refs: Array<{
                path: string;
                content: string;
                kind?: "skill" | "fileRef";
              }> = [];
              const askMode = (modeOverride ?? entry?.sessionMode) === "ask";
              const failedRefs: string[] = [];
              for (const path of fileRefs) {
                if (!askMode) {
                  refs.push({ path, content: "", kind: "fileRef" });
                  continue;
                }
                // files.read 要 workspaceId（LT-T4 误发 sessionId——被控端
                // 按会话 id 找工作空间必失败，「注入失败」根因）
                const r = await wireRequest("POST", ENDPOINTS.files.read, {
                  workspaceId: entry?.sessionWorkspaceId ?? 0,
                  path,
                });
                if (r.ok) {
                  const text = (r.data as { content?: unknown } | null)
                    ?.content;
                  if (typeof text === "string") {
                    refs.push({ path, content: text });
                    continue;
                  }
                }
                failedRefs.push(path);
              }
              const failedSkills: string[] = [];
              for (const name of skillRefs) {
                const r = await wireRequest("POST", ENDPOINTS.skills.read, {
                  name,
                });
                if (r.ok) {
                  const text = (r.data as { content?: unknown } | null)
                    ?.content;
                  if (typeof text === "string") {
                    refs.push({ path: name, content: text, kind: "skill" });
                    continue;
                  }
                }
                failedSkills.push(name);
              }
              // 本地文件（添加文件对齐批）：内容已在选择时读入，直接并入
              // 注入块（[引用文件 name] 前缀——对齐桌面 pickAndRead 语义）
              for (const file of localFiles) {
                refs.push({ path: file.name, content: file.content });
              }
              if (failedRefs.length + failedSkills.length > 0) {
                toast.warning(
                  t("refReadFailed", {
                    names: [...failedRefs, ...failedSkills].join(", "),
                  }),
                );
              }
              const injected = buildInjectedContent(content, refs);
              // 注入前缀必须随消息上行（LT-T4 至今死变量 bug：injected
              // 算出却仍传 content——文件内容从未进过模型，「会话识别
              // 不到文件」根因；乐观消息同 PC 口径带前缀）
              const accepted = await useStreamStore
                .getState()
                .startSend(
                  sessionId,
                  injected,
                  modelId ?? undefined,
                  pendingImages.length > 0 ? pendingImages : undefined,
                  expertId ?? undefined,
                );
              if (accepted) {
                setPendingImages([]);
                setFileRefs([]);
                setSkillRefs([]);
                setLocalFiles([]);
              }
              return accepted;
            }}
            onStop={() => useStreamStore.getState().abort(sessionId)}
            onPolish={handlePolish}
          />
        </View>

        <FileRefPicker
          visible={fileRefOpen}
          workspaceId={entry?.sessionWorkspaceId ?? null}
          selected={fileRefs}
          onClose={() => setFileRefOpen(false)}
          onConfirm={(paths) => {
            setFileRefs(paths);
            setFileRefOpen(false);
          }}
        />

        <SkillRefPicker
          visible={skillRefOpen}
          selected={skillRefs}
          onClose={() => setSkillRefOpen(false)}
          onConfirm={(names) => {
            setSkillRefs(names);
            setSkillRefOpen(false);
          }}
        />

        {/* 会话更多面板（A9 compact 批）：压缩上下文（Alert 二次确认——
            压缩会新增摘要消息，破坏性语义事前告知） */}
        <AppActionSheet
          visible={moreOpen}
          items={[
            {
              key: "compact",
              label: t("compactMenu"),
              Icon: Minimize2,
              onPress: handleCompact,
            },
          ]}
          onClose={() => setMoreOpen(false)}
        />

        {/* 消息长按操作面板（UX 批）：操作具名可发现 + 面板即确认层 */}
        <MessageActionsSheet
          target={
            actionTarget != null &&
            (actionTarget.role === "user" || actionTarget.role === "assistant")
              ? {
                  role: actionTarget.role,
                  text: actionTarget.text ?? "",
                  messageId: actionTarget.id,
                }
              : null
          }
          onCopy={() => handleCopyMessage()}
          onEdit={() => {
            if (actionTarget != null) handleEditResend(actionTarget);
          }}
          onRegenerate={() => handleRegenerate()}
          onClose={() => setActionTarget(null)}
        />

        {/* 会话文件 sheet + 全文预览（MR-T6）：头部入口 → 分组列表 → 点行预览 */}
        <SessionFilesSheet
          files={sessionFiles}
          visible={filesSheetOpen}
          onClose={() => setFilesSheetOpen(false)}
          onOpenFile={(file) => {
            setFilesSheetOpen(false);
            setPreviewFile(file);
          }}
        />
        <FilePreviewModal
          path={previewFile?.path ?? ""}
          workspaceId={entry?.sessionWorkspaceId ?? null}
          visible={previewFile != null}
          onClose={() => setPreviewFile(null)}
        />
      </View>
    </SafeAreaView>
  );
}

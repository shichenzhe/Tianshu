/**
 * 单会话面板（从 ChatView 抽出复用，逻辑与抽取前一致）：useChatSend
 * 唯一实例在此，输入框与消息列表共享 sending 状态；key 取会话 id，
 * 切换会话时重建（流监听与节流缓冲随之隔离）。
 * 项目模块复用时可通过可选过滤集限定＋菜单可选能力（未传不过滤）
 * 拆分说明：消息区子树（MessageList）已拆至 ChatMessages，
 * 本组件为组合壳——发送/编辑/权限等状态与回调原位持有，经 props 透传，
 * 底部插槽注入 ChatInput（流式状态行 AgentProgress 已移入消息流尾部）；
 * props 签名与导出名不变
 * （AI 模块 ChatView 等消费方零改动），行为与拆分前一致
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Archive } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { toast } from "sonner";

import type { MessagePage, SessionRecord } from "../../api/session.api";
import ChatApi, {
  type ChatModelParams,
  type ChatSendImage,
} from "../../api/chat.api";
import AssistantApi from "../../api/assistant.api";
import SessionApi from "../../api/session.api";
import type { WorkspaceRecord } from "../../api/workspace.api";
import ChatInput from "./ChatInput";
import ChatMessages from "./ChatMessages";
import { parseBlocks } from "../model/blocks";
import {
  appendOptimisticMessage,
  buildOptimisticUserMessage,
} from "../lib/optimistic-user-message";
import { type PendingFile, splitImageFiles } from "../lib/pending-file";
import { buildInjectedContent } from "../lib/build-injected-content";
import type { AccessMode } from "./PermissionCapsule";
import { useChatSend } from "../hooks/use-chat-send";
import { useChatStore } from "../store/chat.store";
import { mapIpcError } from "../lib/error-message";
import {
  truncateMessagesForEdit,
  truncateMessagesForRegenerate,
} from "../lib/truncate-messages-for-edit";

/** sessionResolver 结果（T26 文件窗占位会话首条发送）：真会话 + 首条
 *  注入前缀（文件引用/全文注入）+ 会话侧图片附件（图片 tab 自身 absPath，
 *  与输入附件合并）——前缀拼装与直发归本组件，会话落地与首条上下文
 *  计算归 resolver 实现方 */
export interface SessionResolverResult {
  session: SessionRecord;
  contentPrefix?: string;
  images?: ChatSendImage[];
}

interface ChatPaneProps {
  session: SessionRecord;
  /** 会话所属工作空间（即当前选中项），@ 文件联想/产物面板/审批均按 id 定位。
   *  P2 起仅需 id：AI 视图传完整记录，项目动态流传资产空间
   *  `{ id: assetWorkspaceId }`——资产空间被 workspace:list 过滤，项目侧
   *  不经全局空间列表解析（spec §3.6） */
  workspace: Pick<WorkspaceRecord, "id"> | null;
  hasModel: boolean;
  onOpenSettings: (target: "providers" | "assistants" | "mcp") => void;
  /** 快捷指令胶囊（T22 文件窗）：原样下发 ChatInput（空会话输入区上方，
   *  点击填草稿不发送）；缺省不传（AI 模块 ChatView 零改动） */
  quickPrompts?: Array<{ id: string; label: string; prompt: string }>;
  /** 拖入图片受控注入（T22 文件窗）：面板 drop 层落盘条目经此并入
   *  ChatInput 附件体系；缺省不传（不启用） */
  pendingImageInjection?: Array<{ name: string; absPath: string }>;
  /** 注入并入完成回调（pendingImageInjection 配对，消费即清空） */
  onPendingImageInjectionConsumed?: () => void;
  /** 占位会话（哨兵 id<0，T26 文件窗）首条发送的会话落地器：返回真会话
   *  与首条注入前缀/图片附件——发送拼装归本组件；失败提示归实现方（本
   *  组件只兜底 chat:send 阶段）；缺省不传（AI 模块 ChatView 零改动） */
  sessionResolver?: () => Promise<SessionResolverResult>;
  /** 占位首条直发成功后上抛真会话（调用方落 tab 绑定/本窗创建标记） */
  onSessionResolved?: (session: SessionRecord) => void;
  /** per-tab 草稿外置（T28 文件窗，spec §16 项 5）：原样下发 ChatInput
   *  （initialDraft 回灌 / onDraftUnmount 卸载上报）；缺省不传零改动 */
  initialDraft?: string;
  onDraftUnmount?: (draft: string) => void;
}

/**
 * 单会话面板：useChatSend 实例之一（另一实例在项目页 ProjectChatBar 快速
 * 发起条，各自随挂载订阅/卸载；跨视图衔接经 chat:status 快照恢复，见
 * use-chat-send.ts），输入框与消息列表共享 sending 状态；key 取会话 id，
 * 切换会话时重建（流监听与节流缓冲随之隔离）
 */
export default function ChatPane({
  session,
  workspace,
  hasModel,
  onOpenSettings,
  quickPrompts,
  pendingImageInjection,
  onPendingImageInjectionConsumed,
  sessionResolver,
  onSessionResolved,
  initialDraft,
  onDraftUnmount,
}: ChatPaneProps) {
  const { t } = useTranslation(["chat", "common"]);
  const queryClient = useQueryClient();
  const { sending, send, regenerate, editResend, stop } = useChatSend(
    session.id,
  );
  const [accessMode, setAccessMode] = useState<AccessMode>("default");
  // 消息编辑态：messageId 定位待编辑 user 消息，text 为其原文回填；经
  // MessageList 透传到对应 MessageItem，气泡原位替换为 EditBar；进入编辑
  // 由 user 消息 hover 操作栏的编辑按钮（MessageList onEdit）触发
  const [editing, setEditing] = useState<{
    messageId: number;
    text: string;
  } | null>(null);

  // 会话权限态：挂载时拉取初始化（key=session.id 保证切换会话重建）；
  // 拉取失败保持默认态，后续 setPermission 失败会 toast 兜底。
  // 哨兵会话（文件窗占位 id<0）：无真会话可查，跳过（默认权限态展示）
  useEffect(() => {
    if (session.id < 0) return;
    let cancelled = false;
    ChatApi.getPermission(session.id)
      .then((mode) => {
        if (!cancelled) {
          setAccessMode(mode);
        }
      })
      .catch(() => {
        /* 静默：胶囊保持默认权限展示 */
      });
    return () => {
      cancelled = true;
    };
  }, [session.id]);

  /** 胶囊决议：先落主进程权限存储，成功后更新本地态（失败保持原状并提示）。
   *  本面板全部回调 useCallback 化（H4）：agent 流式期间工具状态切换频繁
   *  重渲染本组件，裸函数引用逐渲染变化会击穿 memo 的 MessageItem 列表。
   *  哨兵会话（文件窗占位 id<0，修复轮 1 Minor ③）：无真会话可写——
   *  轻 toast 不发 IPC（防报错弹窗），输入与首条发送链不受影响 */
  const handleAccessModeChange = useCallback(
    async (mode: AccessMode) => {
      if (session.id < 0) {
        toast.info(t("chat:input.lockedUntilFirstSend"));
        return;
      }
      try {
        await ChatApi.setPermission(session.id, mode);
        setAccessMode(mode);
      } catch (e) {
        toast.error(mapIpcError(e));
      }
    },
    [session.id, t],
  );

  /** 文件引用注入在渲染层完成（spec §5）：逐文件前缀块 + 原输入，主进程零改动
      （前缀拼装已抽共享纯函数 buildInjectedContent，与新建任务 dispatch 同口径）；
      图片附件不经文本注入，分流为 images 走多模态 image part。
      哨兵会话（T26 文件窗占位 id<0）：先经 sessionResolver 落地真会话（内含
      首条注入前缀/图片 tab 附件计算），拼前缀后直发——useChatSend.send 闭包
      捕获的仍是哨兵 id，直发语义照抄其 send（startStream 先行；失败
      finishStream + invalidate 重取后 rethrow）；resolver 阶段失败的提示
      归实现方（本组件不兜底，防双弹） */
  const handleSend = useCallback(
    async (
      content: string,
      files: PendingFile[],
      overrides?: ChatModelParams,
    ) => {
      if (session.id < 0 && sessionResolver) {
        const { textFiles, images } = splitImageFiles(files);
        const injected = buildInjectedContent(content, textFiles);
        const resolved = await sessionResolver();
        const resolvedId = resolved.session.id;
        const finalContent = resolved.contentPrefix
          ? `${resolved.contentPrefix}\n\n${injected}`
          : injected;
        useChatStore.getState().startStream(resolvedId);
        // 乐观插入（同 useChatSend.send 口径）：哨兵直发不等流末才见用户消息
        appendOptimisticMessage(
          queryClient,
          resolvedId,
          buildOptimisticUserMessage(resolvedId, finalContent),
        );
        try {
          await ChatApi.send({
            sessionId: resolvedId,
            content: finalContent,
            overrides,
            images: [...images, ...(resolved.images ?? [])],
          });
        } catch (e) {
          useChatStore.getState().finishStream(resolvedId);
          void queryClient.invalidateQueries({
            queryKey: ["messages", resolvedId],
          });
          toast.error(mapIpcError(e));
          throw e;
        }
        onSessionResolved?.(resolved.session);
        return;
      }
      const { textFiles, images } = splitImageFiles(files);
      const injected = buildInjectedContent(content, textFiles);
      try {
        await send(injected, undefined, overrides, images);
        // 防呆：成功发出新消息后退出编辑态，避免随后的编辑重发静默截断刚发的消息
        setEditing(null);
      } catch (e) {
        toast.error(mapIpcError(e));
        // rethrow：保持调用链 Promise 拒绝语义（ChatInput 已乐观清空，此处静默防双弹由其 catch 处理）
        throw e;
      }
    },
    [
      session.id,
      sessionResolver,
      onSessionResolved,
      send,
      setEditing,
      queryClient,
    ],
  );

  /** /compact 命令:压缩完成置居中提示条并刷新消息(摘要轮已落库) */
  const handleRunCommand = useCallback(
    (command: string) => {
      if (command !== "compact") {
        toast.info(t("chat:skills.comingSoon"));
        return;
      }
      ChatApi.compact(session.id)
        .then(() => {
          // sessions 携带 compactedUpToId(提示条随消息流定位);messages 拉压缩轮
          void queryClient.invalidateQueries({ queryKey: ["sessions"] });
          void queryClient.invalidateQueries({ queryKey: ["messages"] });
        })
        .catch((e: unknown) => toast.error(mapIpcError(e)));
    },
    [t, queryClient, session.id],
  );

  /**
   * 进入编辑：从消息缓存取该 user 消息的 text 块拼接原文（与消息渲染
   * 同口径）回填 EditBar；缓存缺失时回退空文本（仅禁用态重发按钮）
   */
  const handleEdit = useCallback(
    (messageId: number) => {
      // H6 分页缓存形状：跨页找目标消息
      const messages = (
        queryClient.getQueryData<InfiniteData<MessagePage>>([
          "messages",
          session.id,
        ])?.pages ?? []
      ).flatMap((page) => page.items);
      const target = messages.find((message) => message.id === messageId);
      const text = target
        ? parseBlocks(target.blocks)
            .filter((block) => block.type === "text")
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("\n")
        : "";
      setEditing({ messageId, text });
    },
    [queryClient, session.id, setEditing],
  );

  /**
   * 重新生成：乐观截断缓存——目标 assistant 消息及其后立即消失（与后端
   * truncateAfterAndStream 删尾对齐），底部 AgentProgress 转入「准备中」；
   * 失败 toast 兜底 + invalidate 恢复服务器真值；无 id 兜底调用（最后一条
   * assistant）不截——目标定位由后端完成，invalidate 兜底纠偏
   */
  const handleRegenerate = useCallback(
    async (messageId?: number) => {
      const messagesKey = ["messages", session.id];
      if (messageId !== undefined) {
        // H6 分页缓存形状（InfiniteData）：乐观截断须作用到每一页
        queryClient.setQueryData<InfiniteData<MessagePage>>(
          messagesKey,
          (old) =>
            old
              ? {
                  ...old,
                  pages: old.pages.map((page) => ({
                    ...page,
                    items: truncateMessagesForRegenerate(page.items, messageId),
                  })),
                }
              : old,
        );
      }
      try {
        await regenerate(messageId);
      } catch (e) {
        toast.error(mapIpcError(e));
        void queryClient.invalidateQueries({ queryKey: messagesKey });
      }
    },
    [regenerate, queryClient, session.id],
  );

  /**
   * 编辑重发：乐观退出编辑态并同步消息缓存（目标消息换新文本、其后历史
   * 立即截掉，与后端 editAndResend 删尾对齐；流结束 invalidate 拿回真值）；
   * 失败 toast 兜底 + invalidate 恢复服务器真值；messageId 在清空 editing
   * 前捕获（onSubmit 仅在编辑态触发，必然存在）
   */
  const handleEditSubmit = useCallback(
    async (text: string) => {
      const messageId = editing?.messageId;
      setEditing(null);
      if (messageId === undefined) {
        return;
      }
      const messagesKey = ["messages", session.id];
      // H6 分页缓存形状（InfiniteData）：乐观截断须作用到每一页
      queryClient.setQueryData<InfiniteData<MessagePage>>(messagesKey, (old) =>
        old
          ? {
              ...old,
              pages: old.pages.map((page) => ({
                ...page,
                items: truncateMessagesForEdit(page.items, messageId, text),
              })),
            }
          : old,
      );
      try {
        await editResend(messageId, text);
      } catch (e) {
        toast.error(mapIpcError(e));
        void queryClient.invalidateQueries({ queryKey: messagesKey });
      }
    },
    [editing, setEditing, queryClient, session.id, editResend],
  );

  const handleEditCancel = useCallback(() => setEditing(null), [setEditing]);

  // 会话当前专家 icon（emoji）：assistant 头像列与流式状态行共用（共享
  // ["assistants"] 缓存，与 ChatInput 同源）；无专家/无 icon 走默认 Logo
  const assistantsQuery = useQuery({
    queryKey: ["assistants"],
    queryFn: () => AssistantApi.list(),
    staleTime: 60_000,
  });
  const assistantIcon = assistantsQuery.data?.find(
    (a) => a.id === session.assistantId,
  )?.icon;

  // 空会话判定（T8 专家推荐提示词展示条件）：只读订阅消息分页缓存
  // （MessageList 同 key observer 负责取数，enabled:false 仅随其拉取/
  // 失效/乐观更新同步数据，不发起请求），有 user 消息即隐藏胶囊。
  // 选项与 MessageList 保持同形（含 getNextPageParam——查询已有分页数据
  // 时 InfiniteQueryObserver 计算 hasNextPage 必须调用，且后挂观察者的
  // 选项会整体覆写共享 query 配置，缺省会炸真实取数方）
  const messagesViewQuery = useInfiniteQuery({
    queryKey: ["messages", session.id],
    queryFn: ({ pageParam }) =>
      SessionApi.listMessages(session.id, pageParam as number | undefined),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) =>
      last.hasMore && last.nextBeforeId !== null
        ? last.nextBeforeId
        : undefined,
    enabled: false,
  });
  const hasUserMessage = (messagesViewQuery.data?.pages ?? []).some((page) =>
    page.items.some((message) => message.role === "user"),
  );

  // P1 尾未读角标：消息就绪即推进已读游标——历史首屏就绪、本会话轮次
  // 定稿（流末 invalidate 拉回真值，maxMessageId 随新 assistant 消息增长
  // 再次触发）两时机同盖；发送方自身 assistant 消息同推游标（不回退——
  // repo 单调条件写天然防回退，与移动端 loadHistory 后上报同语义）。
  // 哨兵会话（文件窗占位 id<0）无真会话可写，跳过；成功才记 ref——失败
  // 下次数据就绪自然重试；成功后失效 sessions 查询刷新侧边栏角标
  const lastMarkedRef = useRef(0);
  useEffect(() => {
    if (session.id <= 0) {
      return;
    }
    const maxId = (messagesViewQuery.data?.pages ?? [])
      .flatMap((page) => page.items)
      .reduce((max, message) => Math.max(max, message.id), 0);
    if (maxId === 0 || maxId <= lastMarkedRef.current) {
      return;
    }
    SessionApi.markRead(session.id, maxId)
      .then(() => {
        lastMarkedRef.current = maxId;
        void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      })
      .catch(() => {
        /* 静默：角标推进失败不打扰聊天主链 */
      });
  }, [messagesViewQuery.data, session.id, queryClient]);

  // 归档会话：只读查看（操作入口隐藏；输入区禁用；横幅提示+取消归档）
  const isArchived = Boolean(session.archivedAt);

  /** 取消归档：恢复后 invalidate 会话（侧边栏移出已归档分组、只读解除） */
  const handleUnarchive = useCallback(async () => {
    try {
      await SessionApi.archive(session.id, false);
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  }, [session.id, queryClient]);

  return (
    <ChatMessages
      session={session}
      workspace={workspace}
      editing={editing}
      onRegenerate={isArchived ? undefined : handleRegenerate}
      onEdit={isArchived ? undefined : handleEdit}
      onEditSubmit={handleEditSubmit}
      onEditCancel={handleEditCancel}
      assistantIcon={assistantIcon}
    >
      {/* 归档只读横幅：消息可查看，操作不可用；一键取消归档恢复 */}
      {isArchived && (
        <div className="flex items-center gap-2 border-t border-border/50 bg-primary-subtle/50 px-4 py-1.5 text-xs text-muted-foreground">
          <Archive className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">{t("chat:chat.archivedBanner")}</span>
          <button
            type="button"
            onClick={() => void handleUnarchive()}
            className="shrink-0 font-medium text-primary hover:text-primary-hover"
          >
            {t("chat:task.unarchive")}
          </button>
        </div>
      )}
      {/* 底部输入区常驻（编辑态在消息区原位，与发送态互不干扰） */}
      <div className="p-4">
        <ChatInput
          hasModel={hasModel}
          sending={sending}
          disabled={isArchived}
          sessionId={session.id}
          accessMode={accessMode}
          currentMode={session.mode}
          currentAssistantId={session.assistantId}
          currentModelId={session.currentModelId}
          workspaceId={workspace?.id ?? null}
          onAccessModeChange={(mode) => void handleAccessModeChange(mode)}
          onOpenMcp={() => onOpenSettings("mcp")}
          onRunCommand={handleRunCommand}
          onSend={handleSend}
          onStop={stop}
          expertPromptsVisible={!hasUserMessage && !isArchived}
          quickPrompts={quickPrompts}
          pendingImageInjection={pendingImageInjection}
          onPendingImageInjectionConsumed={onPendingImageInjectionConsumed}
          initialDraft={initialDraft}
          onDraftUnmount={onDraftUnmount}
        />
      </div>
    </ChatMessages>
  );
}

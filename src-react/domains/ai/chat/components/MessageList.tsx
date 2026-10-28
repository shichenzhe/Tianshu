/**
 * 消息列表：历史消息（React Query）+ 流式实时气泡 + 新内容自动滚动到底
 * 流式期间 thinking/工具/text 拼成完整 blocks，与历史消息同走
 * 「深度思考面板 + 正文」管道；审批横幅留在面板外逐条渲染
 */
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown } from "lucide-react";
import { useInfiniteQuery } from "@tanstack/react-query";

import IconTooltip from "@/components/common/icon-tooltip";

import SessionApi, { type MessageRecord } from "../../api/session.api";
import {
  parseBlocks,
  type MessageBlock,
  type ToolCallBlock,
} from "../model/blocks";
import {
  searchMessageBlockHits,
  type BlockHit,
  type SearchableTextBlock,
} from "../lib/hit-positions";
import { hitOffsets } from "../lib/search-highlight";
import { useChatStore } from "../store/chat.store";
import { useSessionSearchStore } from "../../store/session-search.store";
import MessageItem from "./MessageItem";
import ApprovalBanner from "./ApprovalBanner";
import AgentProgress from "./AgentProgress";

interface MessageListProps {
  sessionId: number | null;
  /** 当前工作空间 id；null（未选中/加载中）时不挂审批横幅 */
  workspaceId?: number | null;
  /** /compact 压缩覆盖点:提示条插在该消息之后(随消息流上移) */
  compactedUpToId?: number | null;
  /** 重新生成回调(任意 assistant 消息);未提供则隐藏按钮 */
  onRegenerate?: (messageId: number) => void;
  /** 编辑重发回调(user 消息 hover 操作栏);未提供则隐藏编辑按钮 */
  onEdit?: (messageId: number) => void;
  /** 消息编辑态：messageId 定位被编辑的 user 消息（气泡原位替换为 EditBar），text 为回填原文 */
  editing?: { messageId: number; text: string } | null;
  /** 原位编辑提交（重发）回调，透传给被编辑消息的 EditBar */
  onEditSubmit?: (text: string) => void;
  /** 原位编辑取消回调，透传给被编辑消息的 EditBar */
  onEditCancel?: () => void;
  /** 会话当前专家 icon（emoji）：assistant 头像列与流式状态行共用 */
  assistantIcon?: string;
}

/** ApprovalBanner 接口必需的决议回调；可见性纯 store 态门控，本地无需记标记。
 *  置于模块级保持引用稳定，避免每次渲染创建新回调击穿 ApprovalBanner 的 memo */
const noopOnDecided = () => {};

/** 消息的可搜索 text 块（原始 blockIdx 携带，命中换算回块坐标用） */
function searchableTextBlocks(message: MessageRecord): SearchableTextBlock[] {
  const blocks: SearchableTextBlock[] = [];
  parseBlocks(message.blocks).forEach((block, blockIdx) => {
    if (block.type === "text") {
      blocks.push({ blockIdx, text: block.text });
    }
  });
  return blocks;
}

export default function MessageList({
  sessionId,
  workspaceId = null,
  compactedUpToId = null,
  onRegenerate,
  onEdit,
  editing,
  onEditSubmit,
  onEditCancel,
  assistantIcon,
}: MessageListProps) {
  const { t } = useTranslation(["chat", "common"]);
  const isStreaming = useChatStore((state) =>
    sessionId === null ? false : (state.isStreaming[sessionId] ?? false),
  );
  const stream = useChatStore((state) =>
    sessionId === null ? undefined : state.streams[sessionId],
  );

  // H6 分页：首屏最近一页，滚到顶向上翻页（滚动位置锚定）；invalidate
  // /setQueryData 等既有失效链路对同一 queryKey 天然生效
  const messagesQuery = useInfiniteQuery({
    queryKey: ["messages", sessionId],
    queryFn: ({ pageParam }) =>
      SessionApi.listMessages(
        sessionId as number,
        pageParam as number | undefined,
      ),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) =>
      last.hasMore && last.nextBeforeId !== null
        ? last.nextBeforeId
        : undefined,
    // 哨兵会话（<0，文件窗 T26 占位）不发请求——message:listBySession 对
    // 不存在会话必拒，红色失败文案会常驻占位态；真会话落地后 ChatPane
    // 换 key 重建本组件恢复拉取（use-chat-send 哨兵守卫同口径）
    enabled: sessionId !== null && sessionId > 0,
  });
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = messagesQuery;

  // 会话内搜索：位置级命中统计与导航定位（流式伪消息不参与，仅历史消息）
  const searchQuery = useSessionSearchStore((s) => s.query);
  const activeIndex = useSessionSearchStore((s) => s.activeIndex);
  const setHits = useSessionSearchStore((s) => s.setHits);
  const resetSearch = useSessionSearchStore((s) => s.reset);

  // system 行仅参与模型上下文，不在界面展示
  const messages = useMemo(
    () =>
      (messagesQuery.data?.pages ?? [])
        .flatMap((page) => page.items)
        .filter((m) => m.role !== "system"),
    [messagesQuery.data],
  );

  // 各消息位置级命中（同一份集合驱动计数与着色：围栏代码/链接 URL/
  // 纯标记/伪工具调用条已在纯函数层剔除——totalHits 恒等于可滚动 mark 数）
  const messageHits = useMemo(
    () =>
      messages.map((message) =>
        searchMessageBlockHits(searchableTextBlocks(message), searchQuery),
      ),
    [messages, searchQuery],
  );
  // 各消息首命中的全局序号（前缀和），供 MessageItem 分发块级序号基
  const messageOffsets = useMemo(
    () => hitOffsets(messageHits.map((hits) => hits.length)),
    [messageHits],
  );

  // 命中集合回填（输入框计数与导航取模依赖；同引用不触发订阅刷新）
  useEffect(() => {
    setHits(
      messageHits.flatMap((hits, messageIdx) =>
        hits.map((hit: BlockHit) => ({ messageIdx, ...hit })),
      ),
    );
  }, [messageHits, setHits]);

  // 当前命中词滚动居中（输入即定位第一条，回车逐条下移）
  useEffect(() => {
    if (!searchQuery) {
      return;
    }
    document
      .querySelector(`mark[data-hit-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeIndex, searchQuery]);

  // 切换会话：残留高亮与序号对新消息流无意义，整体复位
  useEffect(() => {
    resetSearch();
  }, [sessionId, resetSearch]);

  // 流式中的实时气泡：thinking + 工具调用 + text 拼成完整 blocks，
  // 经 MessageItem 与历史消息走同一「深度思考面板 + 正文」管道
  const liveMessage = useMemo<{
    blocks: MessageBlock[];
    message: MessageRecord;
  } | null>(() => {
    if (
      !isStreaming ||
      !stream ||
      (!stream.text && !stream.thinking && stream.tools.order.length === 0)
    ) {
      return null;
    }
    const blocks: MessageBlock[] = [];
    if (stream.thinking) {
      blocks.push({ type: "thinking", text: stream.thinking });
    }
    for (const toolCallId of stream.tools.order) {
      const tool = stream.tools.map[toolCallId];
      if (tool) {
        blocks.push({
          type: "tool_call",
          toolCallId,
          toolName: tool.toolName,
          args: (tool.args ?? {}) as Record<string, unknown>,
          state: tool.state as ToolCallBlock["state"],
          output: tool.output,
        });
      }
    }
    if (stream.text) {
      blocks.push({ type: "text", text: stream.text });
    }
    return {
      blocks,
      // M8：blocks 经 parsedBlocks 直传 MessageItem（免 30ms flush 节奏下
      // serialize→parse 的全量 JSON 往返）；blocks 字段仅满足 MessageRecord 形状
      message: {
        id: -1,
        sessionId: sessionId as number,
        role: "assistant",
        blocks: "",
        createdAt: "",
      } as MessageRecord,
    };
  }, [isStreaming, stream, sessionId]);

  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Agent 进度数据（流式状态行，从 ChatPane 移入——状态行随 liveMessage
  // 同处消息流内）：选择器只返回原始值（活跃工具 id/名、步数），流式
  // delta 不触发本列表重渲染，仅轮次切换或活跃工具变化时更新
  const activeToolId = useChatStore((state) => {
    const tools =
      sessionId === null ? undefined : state.streams[sessionId]?.tools;
    if (!tools) {
      return undefined;
    }
    for (let i = tools.order.length - 1; i >= 0; i -= 1) {
      const id = tools.order[i];
      const entry = tools.map[id];
      if (
        entry &&
        (entry.state === "running" || entry.state === "awaiting-approval")
      ) {
        return id;
      }
    }
    return undefined;
  });
  const activeTool = useChatStore((state) => {
    if (!activeToolId || sessionId === null) {
      return undefined;
    }
    return state.streams[sessionId]?.tools.map[activeToolId]?.toolName;
  });
  // 工具执行中：步数 = 该工具在调用序中的位置（从 1 计）；
  // 纯文本生成轮：步数 = 下一轮 = 已有工具条数 + 1
  const stepCount = useChatStore((state) => {
    const tools =
      sessionId === null ? undefined : state.streams[sessionId]?.tools;
    if (!tools) {
      return 1;
    }
    if (activeToolId) {
      const index = tools.order.indexOf(activeToolId);
      return (index === -1 ? tools.order.length : index) + 1;
    }
    return tools.order.length + 1;
  });
  // 准备中（发出后尚无任何流式产出——text/thinking/tools 全空）：状态行
  // 显示渐变扫光「准备中」，否则无工具时「回复中」；覆盖普通发送/
  // 重新生成/编辑重发三类入口的首字等待期
  const preparing = useChatStore((state) => {
    const stream = sessionId === null ? undefined : state.streams[sessionId];
    return (
      !stream ||
      (!stream.text && !stream.thinking && stream.tools.order.length === 0)
    );
  });
  // 用户是否处于底部附近（ref 不触发渲染）；上滑查看历史时暂停自动跟随
  const isNearBottomRef = useRef(true);
  // 回底按钮可见性（仅离底翻转触发渲染；跟随判定仍走 ref 免逐帧重渲）
  const [showJumpBottom, setShowJumpBottom] = useState(false);
  // H6 向上翻页的滚动锚定：加载前记 scrollHeight，prepend 完成后补差值，
  // 防止视口跳到底部（React 重渲染可能破坏浏览器原生 overflow-anchor）
  const prependHeightRef = useRef(0);
  const prependingRef = useRef(false);

  /** rAF 对齐滚底：等本帧布局稳定再滚（流式帧连发时避免瞬跳抖动） */
  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ block: "end" });
    });
  }, []);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) {
      return;
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    isNearBottomRef.current = nearBottom;
    setShowJumpBottom(!nearBottom);
    // 滚到顶且还有更旧页：向上翻页（H6）
    if (
      el.scrollTop < 60 &&
      hasNextPage &&
      !isFetchingNextPage &&
      !prependingRef.current
    ) {
      prependHeightRef.current = el.scrollHeight;
      prependingRef.current = true;
      void fetchNextPage();
    }
  };

  // prepend 完成（isFetchingNextPage 回落）后恢复滚动位置
  useEffect(() => {
    if (prependingRef.current && !isFetchingNextPage) {
      const el = containerRef.current;
      if (el) {
        el.scrollTop += el.scrollHeight - prependHeightRef.current;
      }
      prependingRef.current = false;
    }
  }, [isFetchingNextPage, messages.length]);

  // 会话内搜索需要全量消息做命中统计：有未加载页时逐页拉完（H6 兜底，
  // 搜索态短暂回到全量；effect 随每页到达继续触发直至拉完）
  useEffect(() => {
    if (searchQuery && hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [searchQuery, hasNextPage, isFetchingNextPage, fetchNextPage]);

  // 切换会话：重置为跟随态并立即滚到底（历史随后到达时守卫放行）
  useEffect(() => {
    isNearBottomRef.current = true;
    setShowJumpBottom(false);
    scrollToEnd();
  }, [sessionId, scrollToEnd]);

  // 新内容到达仅在「底部附近」时跟随（spec §1）；工具卡/审批横幅到达同样
  // 跟随（rAF 对齐，见 scrollToEnd）
  useEffect(() => {
    if (isNearBottomRef.current) {
      scrollToEnd();
    }
  }, [
    messages.length,
    isStreaming,
    stream?.text,
    stream?.thinking,
    stream?.tools,
    scrollToEnd,
  ]);

  if (sessionId === null) {
    return (
      <div
        data-testid="message-area"
        className="flex flex-1 items-center justify-center overflow-y-auto"
      >
        <p className="text-sm text-muted-foreground">{t("chat:noSession")}</p>
      </div>
    );
  }

  // 哨兵会话（文件窗占位）：空消息区直接渲染（输入区/快捷指令照常展示），
  // 不发请求不落加载/失败文案——与 enabled 守卫配对（hooks 早于本返回，
  // 单靠 early-return 查询仍会发出）
  if (sessionId < 0) {
    return (
      <div data-testid="message-area" className="flex flex-1 overflow-y-auto" />
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        data-testid="message-area"
        ref={containerRef}
        onScroll={handleScroll}
        className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-4"
      >
        {messagesQuery.isPending ? (
          <p className="text-center text-sm text-muted-foreground">
            {t("common:loading")}
          </p>
        ) : messagesQuery.isError ? (
          <p className="text-center text-sm text-destructive">
            {t("common:failed")}
          </p>
        ) : (
          <>
            {messages.map((message, index) => (
              <Fragment key={message.id}>
                <MessageItem
                  message={message}
                  sessionId={sessionId}
                  workspaceId={workspaceId}
                  onRegenerate={isStreaming ? undefined : onRegenerate}
                  onEdit={isStreaming ? undefined : onEdit}
                  hideActions={isStreaming}
                  isEditing={editing?.messageId === message.id}
                  editInitialText={editing?.text}
                  onEditSubmit={onEditSubmit}
                  onEditCancel={onEditCancel}
                  hitOffset={
                    messageHits[index].length > 0
                      ? messageOffsets[index]
                      : undefined
                  }
                  searchHits={
                    messageHits[index].length > 0
                      ? messageHits[index]
                      : undefined
                  }
                  assistantIcon={assistantIcon}
                />
                {/* 压缩点标记:钉在压缩轮消息之后,新消息自然排其下方 */}
                {message.id === compactedUpToId && (
                  <div className="flex justify-center py-1">
                    <span className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground select-none">
                      {t("chat:panel.compactDone")}
                    </span>
                  </div>
                )}
              </Fragment>
            ))}
            {liveMessage && (
              <MessageItem
                message={liveMessage.message}
                sessionId={sessionId}
                streaming
                parsedBlocks={liveMessage.blocks}
                assistantIcon={assistantIcon}
              />
            )}
            {/* 流式状态行（WorkBuddy streaming-footer 同位：消息流内
                底部，头像 + 准备中/回复中扫光或工具轮文案） */}
            {isStreaming && (
              <AgentProgress
                stepCount={stepCount}
                activeTool={activeTool}
                preparing={preparing}
                assistantIcon={assistantIcon}
              />
            )}
            {/* 审批横幅保持在面板外（关键交互不埋进折叠区）：
              工具卡已在深度思考面板内实时展示，此处仅渲染待决议横幅。
              可见性纯 store 态门控：决议成功后主进程推 running/denied chunk
              自然卸下；invoke 失败 store 态未变，横幅保持可见可重试 */}
            {isStreaming &&
              stream &&
              stream.tools.order.map((toolCallId) => {
                const tool = stream.tools.map[toolCallId];
                const argSummary = tool?.argSummary;
                const showBanner =
                  tool?.state === "awaiting-approval" &&
                  argSummary !== undefined &&
                  argSummary.length > 0;
                // 远程态 workspaceId 恒 null（空间概念不跨主机）——横幅
                // 照常渲染（审批是会话级交互）；「允许并记住」由组件内
                // 判远程态（host store）解锁——approve 载荷 remember 上送
                // 被控端写记忆（审批记住批，本地无空间时仍隐藏）
                return showBanner ? (
                  <ApprovalBanner
                    key={toolCallId}
                    sessionId={sessionId}
                    toolCallId={toolCallId}
                    toolName={tool.toolName}
                    argSummary={argSummary}
                    workspaceId={workspaceId}
                    onDecided={noopOnDecided}
                  />
                ) : null;
              })}
          </>
        )}
        <div ref={bottomRef} />
      </div>
      {/* 回到底部（上滑离底时浮现；点击恢复跟随并滚底） */}
      {showJumpBottom && (
        <IconTooltip label={t("chat:panel.jumpBottom")}>
          <button
            type="button"
            data-testid="jump-bottom"
            aria-label={t("chat:panel.jumpBottom")}
            onClick={() => {
              isNearBottomRef.current = true;
              setShowJumpBottom(false);
              scrollToEnd();
            }}
            className="absolute bottom-3 right-4 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-border/50 bg-background text-muted-foreground shadow-lg transition-base hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
          >
            <ArrowDown className="h-4 w-4" />
          </button>
        </IconTooltip>
      )}
    </div>
  );
}

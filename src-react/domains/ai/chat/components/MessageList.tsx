/**
 * 消息列表：历史消息（React Query）+ 流式实时气泡 + 新内容自动滚动到底
 * 流式期间 thinking/工具/text 拼成完整 blocks，与历史消息同走
 * 「深度思考面板 + 正文」管道；审批横幅留在面板外逐条渲染
 */
import { Fragment, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";

import SessionApi, { type MessageRecord } from "../../api/session.api";
import {
  parseBlocks,
  serializeBlocks,
  type MessageBlock,
  type ToolCallBlock,
} from "../model/blocks";
import { countHits, hitOffsets } from "../lib/search-highlight";
import { useChatStore } from "../store/chat.store";
import { useSessionSearchStore } from "../../store/session-search.store";
import MessageItem from "./MessageItem";
import ApprovalBanner from "./ApprovalBanner";

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
}

/** ApprovalBanner 接口必需的决议回调；可见性纯 store 态门控，本地无需记标记。
 *  置于模块级保持引用稳定，避免每次渲染创建新回调击穿 ApprovalBanner 的 memo */
const noopOnDecided = () => {};

/** 消息的可搜索文本：全部 text 块拼接（与 MessageItem 渲染/计数口径一致，
 *  伪工具调用块计入计数但不渲染高亮） */
function searchableText(message: MessageRecord): string {
  return parseBlocks(message.blocks)
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
}

export default function MessageList({
  sessionId,
  workspaceId = null,
  compactedUpToId = null,
  onRegenerate,
  onEdit,
}: MessageListProps) {
  const { t } = useTranslation(["chat", "common"]);
  const isStreaming = useChatStore((state) =>
    sessionId === null ? false : (state.isStreaming[sessionId] ?? false),
  );
  const stream = useChatStore((state) =>
    sessionId === null ? undefined : state.streams[sessionId],
  );

  const messagesQuery = useQuery({
    queryKey: ["messages", sessionId],
    queryFn: () => SessionApi.listMessages(sessionId as number),
    enabled: sessionId !== null,
  });

  // 会话内搜索：命中统计与导航定位（流式伪消息不参与，仅历史消息）
  const searchQuery = useSessionSearchStore((s) => s.query);
  const activeIndex = useSessionSearchStore((s) => s.activeIndex);
  const syncTotalHits = useSessionSearchStore((s) => s.syncTotalHits);
  const resetSearch = useSessionSearchStore((s) => s.reset);

  // system 行仅参与模型上下文，不在界面展示
  const messages = useMemo(
    () => (messagesQuery.data ?? []).filter((m) => m.role !== "system"),
    [messagesQuery.data],
  );

  // 各消息命中数与首命中全局序号（前缀和），供 MessageItem 分发块级序号
  const hitCounts = useMemo(
    () =>
      messages.map((message) =>
        countHits(searchableText(message), searchQuery),
      ),
    [messages, searchQuery],
  );
  const messageOffsets = useMemo(() => hitOffsets(hitCounts), [hitCounts]);

  // 命中总数回填（输入框计数与导航取模依赖；值不变不触发订阅刷新）
  useEffect(() => {
    syncTotalHits(hitCounts.reduce((sum, count) => sum + count, 0));
  }, [hitCounts, syncTotalHits]);

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
  const liveMessage = useMemo<MessageRecord | null>(() => {
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
      id: -1,
      sessionId: sessionId as number,
      role: "assistant",
      blocks: serializeBlocks(blocks),
      createdAt: "",
    };
  }, [isStreaming, stream, sessionId]);

  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // 用户是否处于底部附近（ref 不触发渲染）；上滑查看历史时暂停自动跟随
  const isNearBottomRef = useRef(true);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) {
      return;
    }
    isNearBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // 切换会话：重置为跟随态并立即滚到底（历史随后到达时守卫放行）
  useEffect(() => {
    isNearBottomRef.current = true;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [sessionId]);

  // 新内容到达仅在「底部附近」时跟随（spec §1）；工具卡/审批横幅到达同样跟随
  useEffect(() => {
    if (isNearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
  }, [
    messages.length,
    isStreaming,
    stream?.text,
    stream?.thinking,
    stream?.tools,
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

  return (
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
                onRegenerate={isStreaming ? undefined : onRegenerate}
                onEdit={isStreaming ? undefined : onEdit}
                hideActions={isStreaming}
                hitOffset={
                  hitCounts[index] > 0 ? messageOffsets[index] : undefined
                }
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
          {liveMessage && <MessageItem message={liveMessage} streaming />}
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
              return showBanner && workspaceId !== null ? (
                <ApprovalBanner
                  key={toolCallId}
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
  );
}

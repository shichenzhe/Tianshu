/**
 * 消息列表：历史消息（React Query）+ 流式中的实时气泡 + 新内容自动滚动到底
 * 流式工具区简化实现：统一追加在 text/thinking 之后（流式期间顺序弱化，
 * 历史回读经 tool_call 块还原真实穿插序）
 */
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";

import SessionApi, { type MessageRecord } from "../../api/session.api";
import { serializeBlocks, type MessageBlock } from "../model/blocks";
import { useChatStore } from "../store/chat.store";
import MessageItem from "./MessageItem";
import ToolCallCard from "./ToolCallCard";
import ApprovalBanner from "./ApprovalBanner";

interface MessageListProps {
  sessionId: number | null;
  /** 当前工作空间 id；null（未选中/加载中）时不挂审批横幅 */
  workspaceId?: number | null;
  /** 重新生成回调（Task 17 由 useChatSend 接线）；未提供则隐藏按钮 */
  onRegenerate?: () => void;
}

/** ApprovalBanner 接口必需的决议回调；可见性纯 store 态门控，本地无需记标记。
 *  置于模块级保持引用稳定，避免每次渲染创建新回调击穿 ApprovalBanner 的 memo */
const noopOnDecided = () => {};

export default function MessageList({
  sessionId,
  workspaceId = null,
  onRegenerate,
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

  // system 行仅参与模型上下文，不在界面展示
  const messages = useMemo(
    () => (messagesQuery.data ?? []).filter((m) => m.role !== "system"),
    [messagesQuery.data],
  );

  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === "assistant") {
        return messages[i].id;
      }
    }
    return null;
  }, [messages]);

  // 流式中的实时气泡：复用 MessageItem 的 blocks 分发逻辑
  const liveMessage = useMemo<MessageRecord | null>(() => {
    if (!isStreaming || !stream || (!stream.text && !stream.thinking)) {
      return null;
    }
    const blocks: MessageBlock[] = [];
    if (stream.thinking) {
      blocks.push({ type: "thinking", text: stream.thinking });
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
          {messages.map((message) => (
            <MessageItem
              key={message.id}
              message={message}
              isLastAssistant={message.id === lastAssistantId && !isStreaming}
              onRegenerate={onRegenerate}
            />
          ))}
          {liveMessage && <MessageItem message={liveMessage} />}
          {/* 流式工具区：按 order 遍历当前流工具；条目 awaiting-approval 且有
              argSummary 时其下挂审批横幅。可见性纯 store 态门控：决议成功后
              主进程推 running/denied chunk 自然卸下；invoke 失败 store 态未变，
              横幅保持可见可重试 */}
          {isStreaming &&
            stream &&
            stream.tools.order.map((toolCallId) => {
              const tool = stream.tools.map[toolCallId];
              if (!tool) {
                return null;
              }
              const argSummary = tool.argSummary;
              const showBanner =
                tool.state === "awaiting-approval" &&
                argSummary !== undefined &&
                argSummary.length > 0;
              return (
                <div key={toolCallId}>
                  <ToolCallCard {...tool} />
                  {showBanner && workspaceId !== null && (
                    <ApprovalBanner
                      toolCallId={toolCallId}
                      argSummary={argSummary}
                      onDecided={noopOnDecided}
                    />
                  )}
                </div>
              );
            })}
        </>
      )}
      <div ref={bottomRef} />
    </div>
  );
}

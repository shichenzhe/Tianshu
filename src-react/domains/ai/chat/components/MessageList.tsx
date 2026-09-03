/**
 * 消息列表：历史消息（React Query）+ 流式中的实时气泡 + 新内容自动滚动到底
 */
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";

import SessionApi, { type MessageRecord } from "../../api/session.api";
import { serializeBlocks, type MessageBlock } from "../model/blocks";
import { useChatStore } from "../store/chat.store";
import MessageItem from "./MessageItem";

interface MessageListProps {
  sessionId: number | null;
  /** 重新生成回调（Task 17 由 useChatSend 接线）；未提供则隐藏按钮 */
  onRegenerate?: () => void;
}

export default function MessageList({
  sessionId,
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

  // 新历史消息或流式增量到达时滚动到底部（即时模式，避免流式期间动画堆积）
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, isStreaming, stream?.text, stream?.thinking]);

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
        </>
      )}
      <div ref={bottomRef} />
    </div>
  );
}

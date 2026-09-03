/**
 * 发送链路：invoke chat:send → 订阅 chat:stream → StreamBuffer 节流写 store
 * → finish/error 后 invalidate messages 并清空缓冲
 */
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import ChatApi, { onChatStream } from "../../api/chat.api";
import { useChatStore } from "../store/chat.store";
import { StreamBuffer } from "../store/stream-buffer";

export function useChatSend(sessionId: number) {
  const queryClient = useQueryClient();
  // 逐个选择器取 action（引用稳定），避免整库订阅导致每次 delta 重渲染
  const startStream = useChatStore((state) => state.startStream);
  const appendDelta = useChatStore((state) => state.appendDelta);
  const finishStream = useChatStore((state) => state.finishStream);
  const buffers = useRef({
    text: new StreamBuffer(),
    thinking: new StreamBuffer(),
  });

  useEffect(() => {
    const off = onChatStream(sessionId, (chunk) => {
      if (chunk.type === "text-delta") {
        const flushed = buffers.current.text.push(chunk.text);
        if (flushed) {
          appendDelta(sessionId, "text", flushed);
        }
      } else if (chunk.type === "reasoning-delta") {
        const flushed = buffers.current.thinking.push(chunk.text);
        if (flushed) {
          appendDelta(sessionId, "thinking", flushed);
        }
      } else {
        // finish/error：尾部不足 30ms 的缓冲不补吐，invalidate 重取已含完整持久化内容
        finishStream(sessionId);
        void queryClient.invalidateQueries({
          queryKey: ["messages", sessionId],
        });
      }
    });
    // 卸载/换绑时除了解绑监听，还要清流状态：否则流在无监听期间结束时，
    // isStreaming[sessionId] 永远为 true（发送按钮卡在「停止」且无法再发送）。
    // 若此时流仍在进行，主进程会照常持久化，重新进入会话时由 query 重取补齐。
    return () => {
      off();
      finishStream(sessionId);
    };
  }, [sessionId, appendDelta, finishStream, queryClient]);

  const sending = useChatStore(
    (state) => state.isStreaming[sessionId] ?? false,
  );

  const send = async (content: string, modelId?: number) => {
    startStream(sessionId);
    try {
      await ChatApi.send({ sessionId, content, modelId });
    } catch (e) {
      // 早期失败（会话不存在/并发请求/未选模型）时用户消息可能已落库，失效重取
      finishStream(sessionId);
      void queryClient.invalidateQueries({ queryKey: ["messages", sessionId] });
      throw e;
    }
  };

  const regenerate = async () => {
    startStream(sessionId);
    try {
      await ChatApi.regenerate(sessionId);
    } catch (e) {
      finishStream(sessionId);
      void queryClient.invalidateQueries({ queryKey: ["messages", sessionId] });
      throw e;
    }
  };

  return {
    sending,
    send,
    regenerate,
    stop: () => ChatApi.stop(sessionId),
  };
}

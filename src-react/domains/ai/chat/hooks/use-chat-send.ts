/**
 * 发送链路：invoke chat:send → 订阅 chat:stream → StreamBuffer 节流写 store
 * → finish/error 后 invalidate messages 并清空缓冲；error 附错误码映射的 i18n 提示
 */
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import ChatApi, {
  onChatStream,
  type ChatModelParams,
} from "../../api/chat.api";
import { useChatStore } from "../store/chat.store";
import { StreamBuffer } from "../store/stream-buffer";

export function useChatSend(sessionId: number) {
  const queryClient = useQueryClient();
  const { t } = useTranslation(["chat"]);
  // 逐个选择器取 action（引用稳定），避免整库订阅导致每次 delta 重渲染
  const startStream = useChatStore((state) => state.startStream);
  const appendDelta = useChatStore((state) => state.appendDelta);
  const finishStream = useChatStore((state) => state.finishStream);
  const setStreamContent = useChatStore((state) => state.setStreamContent);
  const buffers = useRef({
    text: new StreamBuffer(),
    thinking: new StreamBuffer(),
  });

  useEffect(() => {
    // 流结束标记：迟到的 status 响应不得复活已结束的流状态（spec §4）
    let ended = false;
    // finish/error 公共收尾：尾部不足 30ms 的缓冲不补吐，invalidate 重取已含完整持久化内容
    const endStream = () => {
      ended = true;
      finishStream(sessionId);
      void queryClient.invalidateQueries({
        queryKey: ["messages", sessionId],
      });
    };

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
      } else if (chunk.type === "error") {
        // 主文案用错误码映射的 i18n 文案，原始 upstream 信息作详情
        endStream();
        toast.error(t(`chat:errors.${chunk.errorCode ?? "UNKNOWN"}`), {
          description: chunk.message,
        });
      } else {
        endStream();
      }
    });
    // 切回会话：先订阅再查询，streaming 则以主进程快照恢复（spec §4）；
    // 响应迟到于流结束时忽略，避免复活已结束的流状态
    void ChatApi.status(sessionId)
      .then((status) => {
        if (!ended && status.streaming) {
          setStreamContent(sessionId, {
            text: status.text,
            thinking: status.thinking,
          });
        }
      })
      .catch(() => {
        /* 查询失败按非流式处理，不阻塞挂载 */
      });
    // 卸载/换绑时除了解绑监听，还要清流状态：否则流在无监听期间结束时，
    // isStreaming[sessionId] 永远为 true（发送按钮卡在「停止」且无法再发送）。
    // 若此时流仍在进行，主进程会照常持久化，重新进入会话时由 query 重取补齐。
    return () => {
      off();
      finishStream(sessionId);
    };
  }, [sessionId, appendDelta, finishStream, setStreamContent, queryClient, t]);

  const sending = useChatStore(
    (state) => state.isStreaming[sessionId] ?? false,
  );

  /** 单次请求参数覆盖（spec §4.2 第三优先级）；regenerate 不支持（沿用原请求参数） */
  const send = async (
    content: string,
    modelId?: number,
    overrides?: ChatModelParams,
  ) => {
    startStream(sessionId);
    try {
      await ChatApi.send({ sessionId, content, modelId, overrides });
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

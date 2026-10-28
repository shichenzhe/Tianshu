/**
 * 发送链路：invoke chat:send → 订阅 chat:stream → StreamBuffer 节流写 store
 * → finish/error 后 invalidate messages 并清空缓冲；error 附错误码映射的 i18n 提示
 */
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import ChatApi, {
  onChatStream,
  type ChatModelParams,
  type ChatSendImage,
} from "../../api/chat.api";
import { useChatStore } from "../store/chat.store";
import { StreamBuffer } from "../store/stream-buffer";
import {
  appendOptimisticMessage,
  buildOptimisticUserMessage,
} from "../lib/optimistic-user-message";

export function useChatSend(sessionId: number) {
  const queryClient = useQueryClient();
  const { t } = useTranslation(["chat"]);
  // 逐个选择器取 action（引用稳定），避免整库订阅导致每次 delta 重渲染
  const startStream = useChatStore((state) => state.startStream);
  const appendDelta = useChatStore((state) => state.appendDelta);
  const finishStream = useChatStore((state) => state.finishStream);
  const setStreamContent = useChatStore((state) => state.setStreamContent);
  const updateTool = useChatStore((state) => state.updateTool);
  const buffers = useRef({
    text: new StreamBuffer(),
    thinking: new StreamBuffer(),
  });

  useEffect(() => {
    // 哨兵 id（<=0，文件窗惰建期 useFileSession 传 -1）：会话未建，
    // 不订阅不查状态；真实 id 换入后本 effect 重跑建立流订阅
    if (sessionId <= 0) return;
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
      } else if (chunk.type === "finish") {
        endStream();
      } else if (chunk.type === "title-updated") {
        // AI 起名完成 → 刷新侧边栏会话列表（spec §6）
        void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      } else if (chunk.type === "tool-update") {
        // P1：工具流式状态进 store 缓冲（args/output 缺省由 updateTool 跳过合并）
        updateTool(sessionId, chunk.toolCallId, {
          toolName: chunk.toolName,
          args: chunk.args,
          state: chunk.state,
          output: chunk.output,
        });
      } else if (chunk.type === "approval-request") {
        // P1：审批请求仅补 argSummary，待渲染层弹审批 UI（后续任务接线）
        updateTool(sessionId, chunk.toolCallId, {
          toolName: chunk.toolName,
          argSummary: chunk.argSummary,
        });
      }
    });
    // 切回会话：先订阅再查询，streaming 则以主进程快照恢复（spec §4）；
    // 响应迟到于流结束时忽略，避免复活已结束的流状态
    void ChatApi.status(sessionId)
      .then((status) => {
        if (!ended && status.streaming) {
          // FIFO 下快照已含未 flush 的缓冲增量，先清空缓冲避免重复渲染
          buffers.current.text.flush();
          buffers.current.thinking.flush();
          setStreamContent(sessionId, {
            text: status.text,
            thinking: status.thinking,
            // P1：主进程快照已含工具态，整体透传恢复 agent 进度
            tools: status.tools,
          });
        }
      })
      .catch(() => {
        /* 查询失败按非流式处理，不阻塞挂载 */
      });
    // 卸载/换绑时除了解绑监听，还要清流状态：否则流在无监听期间结束时，
    // isStreaming[sessionId] 永远为 true（发送按钮卡在「停止」且无法再发送）。
    // 若此时流仍在进行，主进程会照常持久化，重新进入会话时由 query 重取补齐。
    // 卸载后迟到的 status 响应同样不得复活流状态，置位结束标记
    return () => {
      ended = true;
      off();
      finishStream(sessionId);
    };
  }, [
    sessionId,
    appendDelta,
    finishStream,
    setStreamContent,
    updateTool,
    queryClient,
    t,
  ]);

  const sending = useChatStore(
    (state) => state.isStreaming[sessionId] ?? false,
  );

  /** 单次请求参数覆盖（spec §4.2 第三优先级）；regenerate 不支持（沿用原请求参数）。
   *  三个发送回调引用须稳定（H4）：下游 ChatPane 的 useCallback 以它们为
   *  依赖，引用逐渲染变化会击穿 memo 的 MessageItem 列表 */
  const send = useCallback(
    async (
      content: string,
      modelId?: number,
      overrides?: ChatModelParams,
      images?: ChatSendImage[],
    ) => {
      startStream(sessionId);
      // 乐观插入：chat:send 要等整轮流结束才 resolve（后端 send 内
      // await streamAndPersist），若只依赖 finish 的 invalidate 重取，
      // 用户消息将从发送起缺失整轮、与 assistant 完整消息一起在流末
      // 才出现——发送瞬间本地写入负 id 占位；finish/error 的 invalidate
      // 拿回服务器真值替换（早期失败未落库时乐观消息即被清除）
      appendOptimisticMessage(
        queryClient,
        sessionId,
        buildOptimisticUserMessage(sessionId, content),
      );
      try {
        await ChatApi.send({ sessionId, content, modelId, overrides, images });
      } catch (e) {
        // 早期失败（会话不存在/并发请求/未选模型）时用户消息可能已落库，失效重取
        finishStream(sessionId);
        void queryClient.invalidateQueries({
          queryKey: ["messages", sessionId],
        });
        throw e;
      }
    },
    [sessionId, startStream, finishStream, queryClient],
  );

  const regenerate = useCallback(
    async (messageId?: number) => {
      startStream(sessionId);
      try {
        await ChatApi.regenerate(sessionId, messageId);
      } catch (e) {
        finishStream(sessionId);
        void queryClient.invalidateQueries({
          queryKey: ["messages", sessionId],
        });
        throw e;
      }
    },
    [sessionId, startStream, finishStream, queryClient],
  );

  /** 编辑 user 消息并重发（与 regenerate 同模式：流式状态先行，失败收尾重取） */
  const editResend = useCallback(
    async (messageId: number, content: string) => {
      startStream(sessionId);
      try {
        await ChatApi.editAndResend(sessionId, messageId, content);
      } catch (e) {
        finishStream(sessionId);
        void queryClient.invalidateQueries({
          queryKey: ["messages", sessionId],
        });
        throw e;
      }
    },
    [sessionId, startStream, finishStream, queryClient],
  );

  return {
    sending,
    send,
    regenerate,
    editResend,
    stop: useCallback(() => ChatApi.stop(sessionId), [sessionId]),
  };
}

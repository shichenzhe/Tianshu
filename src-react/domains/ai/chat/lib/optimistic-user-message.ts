import type { InfiniteData, QueryClient } from "@tanstack/react-query";

import type { MessagePage, MessageRecord } from "../../api/session.api";
import { serializeBlocks } from "../model/blocks";

/**
 * 乐观用户消息（负数临时 id 占位）：发送瞬间插入 ["messages"] 缓存，
 * 流结束（finish/error）的 invalidate 重取拿回服务器真值（正 id）替换。
 * 图片附件不乐观——MessageImage 经 IPC 按相对数据根路径读盘，乐观阶段
 * 的绝对路径无法解析；输入区粘贴预览已覆盖输入期体验，图片随重取出现。
 */
export function buildOptimisticUserMessage(
  sessionId: number,
  content: string,
): MessageRecord {
  return {
    id: -Date.now(),
    sessionId,
    role: "user",
    blocks: serializeBlocks(content ? [{ type: "text", text: content }] : []),
    createdAt: new Date().toISOString(),
  };
}

/**
 * 追加乐观消息到 ["messages", sessionId] 无限查询缓存末页尾部。
 * 无缓存（会话页未挂载/未加载）时跳过：观察者不存在则乐观不可见，
 * 流结束 invalidate 拿回全量真值，行为回退为发送前现状。
 */
export function appendOptimisticMessage(
  queryClient: QueryClient,
  sessionId: number,
  message: MessageRecord,
): void {
  queryClient.setQueryData<InfiniteData<MessagePage>>(
    ["messages", sessionId],
    (existing) => {
      if (!existing?.pages.length) {
        return existing;
      }
      const pages = existing.pages.map((page, index) =>
        index === existing.pages.length - 1
          ? { ...page, items: [...page.items, message] }
          : page,
      );
      return { ...existing, pages };
    },
  );
}

/**
 * 编辑重发乐观更新（纯函数）：与后端 editAndResend 对齐——定位待编辑的
 * user 消息，重写其 blocks 为新文本、截掉其后全部消息，流式期间前端缓存
 * 立即呈现（live 气泡紧跟其后），流结束/失败由 invalidateQueries 拿回真值
 */
import type { MessageRecord } from "../../api/session.api";
import { serializeBlocks } from "../model/blocks";

export function truncateMessagesForEdit(
  messages: MessageRecord[],
  messageId: number,
  text: string,
): MessageRecord[] {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index === -1) {
    // messageId 不在缓存中（并发下已被删除等）：原样返回，交由后续 invalidate 纠偏
    return messages;
  }
  // slice 浅拷贝前缀后仅替换目标元素（其余元素共享原引用，不 mutate 入参）
  const kept = messages.slice(0, index + 1);
  kept[index] = {
    ...messages[index],
    blocks: serializeBlocks([{ type: "text", text }]),
  };
  return kept;
}

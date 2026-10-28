import { serializeBlocks } from "./blocks";

/**
 * 消息记录（message:getById / rounds 落库行的渲染端形态）。
 * 移动端搬迁（T10）：原自 mirror src-react/domains/ai/api/session.api.ts
 * import（移动端无该 api 层），此处按原形内联定义，字段零改动。
 */
export interface MessageRecord {
  id: number;
  sessionId: number;
  role: "user" | "assistant" | "system";
  blocks: string;
  modelId?: number;
  assistantId?: number;
  error?: string;
  /** 生成耗时毫秒(assistant 轮,v9) */
  durationMs?: number;
  createdAt: string;
}

/**
 * 乐观用户消息（负数临时 id 占位）：发送瞬间插入消息列表，
 * 流结束（finish/error）后的重取拿回服务器真值（正 id）替换。
 * 图片附件不乐观——乐观阶段的绝对路径无法解析；输入区粘贴预览已
 * 覆盖输入期体验，图片随重取出现。
 *
 * 移动端搬迁（T10）：仅搬 buildOptimisticUserMessage 纯函数；
 * 桌面端 appendOptimisticMessage（react-query setQueryData 无限缓存
 * 追加）依赖 @tanstack/react-query——移动端状态层为 zustand，未装该包，
 * 故不搬（列表追加由 store 任务实现）。
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

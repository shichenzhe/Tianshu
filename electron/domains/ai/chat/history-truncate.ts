import { parseBlocks } from "./blocks";

/**
 * token 估算：1 token ≈ 2 字符（P0 近似，中文场景够用）
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2);
}

/**
 * 单条消息 token 估算（text/thinking 块按文本计入；tool_call 块按
 * args JSON + 输出全文计入——blocksToModelMessages 会原样回喂工具调用，
 * 若按 0 计则工具密集会话会被截断误判为未超窗，导致下一次请求失败）
 */
export function estimateMessageTokens(blocksJson: string): number {
  return parseBlocks(blocksJson).reduce((sum, block) => {
    if (block.type === "text" || block.type === "thinking") {
      return sum + estimateTokens(block.text);
    }
    if (block.type === "tool_call") {
      // args JSON + 输出全文按 2 字符/token 估算，另加结构开销常数
      const argsLen =
        block.args === undefined ? 0 : JSON.stringify(block.args).length;
      const outputLen =
        typeof block.output === "string" ? block.output.length : 0;
      return sum + Math.ceil((argsLen + outputLen) / 2) + 20;
    }
    return sum;
  }, 0);
}

/**
 * 从最新往回按 contextWindow 累积，超窗丢弃最老消息；至少保留最近一条
 */
export function truncateHistory<T extends { blocks: string }>(
  messages: T[],
  contextWindow?: number,
): T[] {
  if (!contextWindow || contextWindow <= 0) {
    return messages;
  }
  let budget = contextWindow;
  const kept: T[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = estimateMessageTokens(messages[i].blocks);
    if (cost > budget && kept.length > 0) {
      break;
    }
    budget -= cost;
    kept.unshift(messages[i]);
  }
  return kept;
}

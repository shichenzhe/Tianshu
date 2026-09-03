import { parseBlocks } from "./blocks";

/**
 * token 估算：1 token ≈ 2 字符（P0 近似，中文场景够用）
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2);
}

/**
 * 单条消息 token 估算（text/thinking 块计入）
 */
export function estimateMessageTokens(blocksJson: string): number {
  return parseBlocks(blocksJson).reduce(
    (sum, block) =>
      block.type === "text" || block.type === "thinking"
        ? sum + estimateTokens(block.text)
        : sum,
    0,
  );
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

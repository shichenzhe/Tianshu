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

export interface TruncateHistoryOptions {
  /** 输出 token 与 system/tools 等固定开销的预留 */
  reserveTokens?: number;
  /** 截断时额外留出的余量比例（滞回带），0~1，默认 0.2 */
  headroomRatio?: number;
}

const DEFAULT_HEADROOM_RATIO = 0.2;

/** maxTokens 未配置时的输出预留兜底，输入预算需为其让位 */
export const DEFAULT_RESERVE_OUTPUT_TOKENS = 4096;

/**
 * 输入预算预留：输出 token 上限（未配置按 4096 兜底）+ system 与工具
 * 定义的固定开销——截断预算扣除后才是不挤压输出的历史窗口
 */
export function estimateReserveTokens(
  maxTokens: number | undefined,
  system: string | undefined,
  toolDefinitions: unknown[],
): number {
  return (
    (maxTokens ?? DEFAULT_RESERVE_OUTPUT_TOKENS) +
    estimateTokens(system ?? "") +
    estimateTokens(JSON.stringify(toolDefinitions ?? []))
  );
}

/**
 * 滞回式窗口截断：未超预算时全量原样返回（前缀逐字节稳定，服务端
 * 前缀缓存持续命中）；超预算后不逐条滑动，而是一次截到预算的
 * (1 - headroom)，之后多轮只追加尾部、不再动头部，避免前缀缓存
 * 每轮失效。至少保留最近一条（keep-at-least-one）
 */
export function truncateHistory<T extends { blocks: string }>(
  messages: T[],
  contextWindow?: number,
  options: TruncateHistoryOptions = {},
): T[] {
  if (!contextWindow || contextWindow <= 0) {
    return messages;
  }
  const budget = Math.max(1, contextWindow - (options.reserveTokens ?? 0));
  const totalCost = messages.reduce(
    (sum, m) => sum + estimateMessageTokens(m.blocks),
    0,
  );
  if (totalCost <= budget) {
    return messages;
  }
  const ratio = Math.min(
    Math.max(options.headroomRatio ?? DEFAULT_HEADROOM_RATIO, 0),
    0.9,
  );
  let remaining = budget * (1 - ratio);
  const kept: T[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = estimateMessageTokens(messages[i].blocks);
    if (cost > remaining && kept.length > 0) {
      break;
    }
    remaining -= cost;
    kept.unshift(messages[i]);
  }
  return kept;
}

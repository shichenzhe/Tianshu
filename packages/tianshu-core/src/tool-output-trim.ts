/**
 * 旧轮工具输出回喂瘦身（spec §18 项 1）：非最近轮且超阈值的 tool_call
 * output 替换为「头 + 截断标注 + 尾」，只作用于**发给模型的回喂副本**——
 * DB blocks、编辑重发（truncateAfterAndStream）、MessageItem 回看全量不动。
 * 截断判定与 token 估算（estimateMessageTokens/truncateHistory）消费瘦身后
 * 副本：调用方在 truncateHistory 之前先跑本模块即可（trim 在前即达成）。
 * 「轮」按消息计：最近 N 个含 tool_call 的消息（工具轮）整条豁免——
 * 多步 agent 一轮多工具，轮内输出模型常需整段回看；豁免之外的轮内
 * 逐块判断超限并截断。
 */
import { parseBlocks } from "./blocks";
import type { MessageBlock, ToolCallBlock } from "@tianshu/protocol";

/** 触发瘦身的 output 字符数阈值（超过才截） */
export const TRIM_THRESHOLD_CHARS = 6000;
/** 瘦身保留头部字符数 */
export const TRIM_HEAD_CHARS = 3000;
/** 瘦身保留尾部字符数 */
export const TRIM_TAIL_CHARS = 1000;
/** 最近 N 个工具轮（含 tool_call 的消息）整条豁免 */
export const TRIM_RECENT_ROUNDS = 2;

export interface TrimToolOutputsOptions {
  /**
   * 本条消息之后（更新轮次）历史中含 tool_call 的消息数——跨消息
   * 「最近 N 轮」判定：从尾数工具轮，前 N 轮整条豁免。单条消息独立
   * 调用（如单测）缺省 0，即本消息即最新工具轮
   */
  newerToolCallRounds?: number;
}

/**
 * 截断标注：被移除字符数动态计算。中文常量——这是给模型看的提示而非
 * UI 文案，不适用 i18n；不提示「原文见历史」（DB 原文对模型不可达，
 * 防误导）
 */
function trimOutput(output: string): string {
  const removed = output.length - TRIM_HEAD_CHARS - TRIM_TAIL_CHARS;
  return (
    output.slice(0, TRIM_HEAD_CHARS) +
    `\n\n[已截断 ${removed} 字符]\n\n` +
    output.slice(-TRIM_TAIL_CHARS)
  );
}

const isToolCall = (block: MessageBlock): block is ToolCallBlock =>
  block.type === "tool_call";

/**
 * 单条消息工具输出瘦身（纯函数，入参不可变）：本消息属「最近 N 轮」
 * （含 tool_call 且其后工具轮数 < N）→ 整条豁免原样返回；否则全部
 * output 为 string 且超阈值的 tool_call 块，output 替换为头 + 截断
 * 标注 + 尾。返回浅拷贝新数组，仅目标块替换为新对象，其余块保留原引用
 */
export function trimToolOutputs(
  blocks: MessageBlock[],
  opts: TrimToolOutputsOptions = {},
): MessageBlock[] {
  const isRecentRound =
    blocks.some(isToolCall) &&
    (opts.newerToolCallRounds ?? 0) < TRIM_RECENT_ROUNDS;
  if (isRecentRound) {
    return [...blocks];
  }
  return blocks.map((block) =>
    isToolCall(block) &&
    typeof block.output === "string" &&
    block.output.length > TRIM_THRESHOLD_CHARS
      ? { ...block, output: trimOutput(block.output) }
      : block,
  );
}

/** 历史消息（JSON blocks 形态，assembleContext/runChatStream 入参口径） */
export interface HistoryMessage {
  role: "user" | "assistant";
  blocks: string;
}

/** 瘦身后的回喂消息（blocks 已解析并截断） */
export interface TrimmedHistoryMessage {
  role: "user" | "assistant";
  blocks: MessageBlock[];
}

/**
 * 整段历史回喂瘦身（接线辅助，runChatStream 与 computeUsageBreakdown
 * 同口径共用）：JSON blocks 逐条 parse + trimToolOutputs，倒序遍历使
 * 处理每条消息时恰好持有其后所有消息的工具轮计数（跨消息「最近 N 轮」
 * 判定；不含 tool_call 的消息不计轮）。返回新数组新消息对象，入参不可变
 */
export function trimHistoryToolOutputs(
  history: HistoryMessage[],
): TrimmedHistoryMessage[] {
  const parsed: TrimmedHistoryMessage[] = history.map((m) => ({
    ...m,
    blocks: parseBlocks(m.blocks),
  }));
  let newerToolCallRounds = 0;
  for (let i = parsed.length - 1; i >= 0; i--) {
    parsed[i] = {
      ...parsed[i],
      blocks: trimToolOutputs(parsed[i].blocks, { newerToolCallRounds }),
    };
    // trim 不移除 tool_call 块：瘦身后计数与原文一致
    if (parsed[i].blocks.some(isToolCall)) {
      newerToolCallRounds++;
    }
  }
  return parsed;
}

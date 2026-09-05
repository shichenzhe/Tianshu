/**
 * 消息 blocks 过程/结论分组（深度思考面板渲染前置）
 * thinking 块合并为面板正文，tool_call 块收进面板工具序列，
 * text（答案正文）与 usage 留在消息主流保序渲染
 */

import type { MessageBlock, TextBlock, UsageBlock } from "../model/blocks";

/** 面板内工具条目（平铺 ToolCallCard props，与流式 ToolStreamState 同构） */
export interface ToolPanelItem {
  toolName: string;
  args?: unknown;
  /** 主进程透传的状态字符串（渲染层不收窄） */
  state: string;
  output?: string;
}

export interface GroupedBlocks {
  /** 全部 thinking 块按序以空行拼接 */
  thinkingText: string;
  tools: ToolPanelItem[];
  texts: TextBlock[];
  usage?: UsageBlock;
  /** thinking 或 tool_call 存在任一即为 true（面板渲染门槛） */
  hasProcess: boolean;
}

export function groupBlocks(blocks: MessageBlock[]): GroupedBlocks {
  let thinkingText = "";
  const tools: ToolPanelItem[] = [];
  const texts: TextBlock[] = [];
  let usage: UsageBlock | undefined;

  for (const block of blocks) {
    switch (block.type) {
      case "thinking":
        thinkingText = thinkingText
          ? `${thinkingText}\n\n${block.text}`
          : block.text;
        break;
      case "tool_call":
        tools.push({
          toolName: block.toolName,
          args: block.args,
          state: block.state,
          output: typeof block.output === "string" ? block.output : undefined,
        });
        break;
      case "text":
        texts.push(block);
        break;
      case "usage":
        usage = block;
        break;
    }
  }

  return {
    thinkingText,
    tools,
    texts,
    usage,
    hasProcess: thinkingText.length > 0 || tools.length > 0,
  };
}

/** 摘要硬截长度上限（无句读时） */
const SUMMARY_MAX_LENGTH = 96;
/** 句末标点（中英） */
const SENTENCE_END = /[。！？.!?]/;

/**
 * 折叠态摘要：取到首个句末标点为止（首句即总结）；无句读时
 * 不超过上限原样返回，超过硬截加省略号
 */
export function summarizeThinking(text: string): string {
  const trimmed = text.trim();
  const firstEnd = trimmed
    .slice(0, SUMMARY_MAX_LENGTH)
    .split("")
    .findIndex((ch) => SENTENCE_END.test(ch));
  if (firstEnd !== -1) {
    return trimmed.slice(0, firstEnd + 1);
  }
  if (trimmed.length <= SUMMARY_MAX_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, SUMMARY_MAX_LENGTH)}…`;
}

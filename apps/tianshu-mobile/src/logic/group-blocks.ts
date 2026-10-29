/**
 * 消息 blocks 过程/结论分组（深度思考面板渲染前置）
 * thinking 块合并为面板正文，tool_call 块收进面板工具序列，
 * text（答案正文）与 usage 留在消息主流保序渲染
 */

import type { MessageBlock, TextBlock, UsageBlock } from "./blocks";

/** show_widget 工具名（消息流内渲染可视化组件；与后端
 *  electron/domains/ai/agent/widget-tool.ts 同名约定——工具块按名分流） */
export const WIDGET_TOOL_NAME = "show_widget";

/** recommend_expert 工具名（会话内专家推荐卡；与后端
 *  electron/domains/ai/agent/recommend-expert-tool.ts 同名约定） */
export const RECOMMEND_TOOL_NAME = "recommend_expert";
/** 双名集合（2026-10-29 改名批次）：远端历史 blocks 存老名 recommend_experts，不迁移——按集合分流 */
export const RECOMMEND_TOOL_NAMES: ReadonlySet<string> = new Set([
  "recommend_expert",
  "recommend_experts",
]);

/** 面板内工具条目（平铺 ToolCallCard props，与流式 ToolStreamState 同构） */
export interface ToolPanelItem {
  toolName: string;
  args?: unknown;
  /** 主进程透传的状态字符串（渲染层不收窄） */
  state: string;
  output?: string;
}

/** 消息流内渲染的可视化组件条目（show_widget 工具块分流；args 为
 *  { title?, widget_code }，渲染层经 WidgetRenderer 沙箱呈现） */
export interface WidgetPanelItem {
  toolCallId: string;
  title?: string;
  code: string;
  /** 工具执行态（running 中渲染加载态，done 后注入 iframe） */
  state: string;
}

/** 推荐卡条目（recommend_expert 工具块分流；args 为
 *  { candidates, reason }，渲染层经 ExpertRecommendCard 呈现） */
export interface RecommendPanelItem {
  toolCallId: string;
  reason: string;
  slugs: string[];
  state: string;
}

export interface GroupedBlocks {
  /** 全部 thinking 块按序以空行拼接 */
  thinkingText: string;
  tools: ToolPanelItem[];
  /** show_widget 工具块（消息流内沙箱渲染，不进思考面板） */
  widgets: WidgetPanelItem[];
  /** recommend_expert 工具块（消息流内推荐卡，不进思考面板） */
  recommends: RecommendPanelItem[];
  texts: TextBlock[];
  usage?: UsageBlock;
  /** thinking 或 tool_call 存在任一即为 true（面板渲染门槛） */
  hasProcess: boolean;
}

export function groupBlocks(blocks: MessageBlock[]): GroupedBlocks {
  let thinkingText = "";
  const tools: ToolPanelItem[] = [];
  const widgets: WidgetPanelItem[] = [];
  const recommends: RecommendPanelItem[] = [];
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
        // show_widget 分流消息流（正文位沙箱渲染）；其余进思考面板工具组
        if (block.toolName === WIDGET_TOOL_NAME) {
          const args = (block.args ?? {}) as {
            title?: string;
            widget_code?: string;
          };
          widgets.push({
            toolCallId: block.toolCallId,
            title: args.title,
            code: args.widget_code ?? "",
            state: block.state,
          });
          break;
        }
        // recommend_expert 同样分流消息流（正文位推荐卡渲染）
        if (RECOMMEND_TOOL_NAMES.has(block.toolName)) {
          const args = (block.args ?? {}) as {
            candidates?: string[];
            reason?: string;
          };
          recommends.push({
            toolCallId: block.toolCallId,
            reason: args.reason ?? "",
            slugs: args.candidates ?? [],
            state: block.state,
          });
          break;
        }
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
    widgets,
    recommends,
    texts,
    usage,
    hasProcess:
      thinkingText.length > 0 ||
      tools.length > 0 ||
      widgets.length > 0 ||
      recommends.length > 0,
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

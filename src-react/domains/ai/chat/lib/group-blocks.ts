/**
 * 消息 blocks 过程/结论分组（深度思考面板渲染前置）
 * thinking 块合并为面板正文，tool_call 块收进面板工具序列，
 * text（答案正文）与 usage 留在消息主流保序渲染
 */

import type { MessageBlock, TextBlock, UsageBlock } from "../model/blocks";

/** show_widget 工具名（消息流内渲染可视化组件；与后端
 *  electron/domains/ai/agent/widget-tool.ts 同名约定——工具块按名分流） */
export const WIDGET_TOOL_NAME = "show_widget";

/** recommend_experts 工具名（会话内专家推荐卡；与后端
 *  electron/domains/ai/agent/recommend-expert-tool.ts 同名约定） */
export const RECOMMEND_TOOL_NAME = "recommend_experts";

/** show_table 工具名（会话内数据表格卡；与后端
 *  electron/domains/ai/agent/display-tools.ts 同名约定——工具块按名分流） */
export const SHOW_TABLE_TOOL_NAME = "show_table";

/** show_summary 工具名（会话内摘要指标卡；同名约定同上） */
export const SHOW_SUMMARY_TOOL_NAME = "show_summary";

/** confirm_form 工具名（工作流执行前的人确认卡；与后端
 *  electron/domains/ai/agent/confirm-form-tool.ts 同名约定） */
export const CONFIRM_FORM_TOOL_NAME = "confirm_form";

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

/** 推荐卡条目（recommend_experts 工具块分流；args 为
 *  { candidates, reason }，渲染层经 ExpertRecommendCard 呈现） */
export interface RecommendPanelItem {
  toolCallId: string;
  reason: string;
  slugs: string[];
  state: string;
}

/** 表格卡列定义（show_table args.columns；与 display-tools schema 同形） */
export interface TableColumn {
  key: string;
  label: string;
}

/** 表格卡条目（show_table 工具块分流；args 为
 *  { title?, columns, rows }，渲染层经 TableViewCard 呈现；rows 单元格
 *  仅标量——args 渐进期未过校验时按空表渲染） */
export interface TablePanelItem {
  toolCallId: string;
  title?: string;
  columns: TableColumn[];
  rows: Array<Record<string, unknown>>;
  state: string;
}

/** 摘要卡条目（show_summary 工具块分流；args 为
 *  { title?, items }，渲染层经 SummaryCard 呈现） */
export interface SummaryPanelItem {
  toolCallId: string;
  title?: string;
  items: Array<{ label: string; value: string | number; hint?: string }>;
  state: string;
}

/** 确认卡表单字段（confirm_form args.fields；与 confirm-form-tool schema
 *  同形） */
export interface ConfirmFormField {
  key: string;
  label: string;
  value: string;
  hint?: string;
}

/** 确认卡条目（confirm_form 工具块分流；args 为
 *  { workflowId, workflowName?, title?, fields }，渲染层经
 *  ConfirmFormCard 呈现——running 态可编辑待确认，output 为终态回执） */
export interface ConfirmFormPanelItem {
  toolCallId: string;
  title?: string;
  workflowId: number;
  workflowName: string;
  fields: ConfirmFormField[];
  state: string;
  output?: string;
}

export interface GroupedBlocks {
  /** 全部 thinking 块按序以空行拼接 */
  thinkingText: string;
  tools: ToolPanelItem[];
  /** show_widget 工具块（消息流内沙箱渲染，不进思考面板） */
  widgets: WidgetPanelItem[];
  /** recommend_experts 工具块（消息流内推荐卡，不进思考面板） */
  recommends: RecommendPanelItem[];
  /** show_table 工具块（消息流内表格卡，不进思考面板） */
  tables: TablePanelItem[];
  /** show_summary 工具块（消息流内摘要卡，不进思考面板） */
  summaries: SummaryPanelItem[];
  /** confirm_form 工具块（消息流内确认卡，不进思考面板） */
  confirmForms: ConfirmFormPanelItem[];
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
  const tables: TablePanelItem[] = [];
  const summaries: SummaryPanelItem[] = [];
  const confirmForms: ConfirmFormPanelItem[] = [];
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
        // recommend_experts 同样分流消息流（正文位推荐卡渲染）
        if (block.toolName === RECOMMEND_TOOL_NAME) {
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
        // show_table 分流消息流（正文位表格卡渲染）
        if (block.toolName === SHOW_TABLE_TOOL_NAME) {
          const args = (block.args ?? {}) as {
            title?: string;
            columns?: TableColumn[];
            rows?: Array<Record<string, unknown>>;
          };
          tables.push({
            toolCallId: block.toolCallId,
            title: args.title,
            columns: Array.isArray(args.columns) ? args.columns : [],
            rows: Array.isArray(args.rows) ? args.rows : [],
            state: block.state,
          });
          break;
        }
        // show_summary 分流消息流（正文位摘要卡渲染）
        if (block.toolName === SHOW_SUMMARY_TOOL_NAME) {
          const args = (block.args ?? {}) as {
            title?: string;
            items?: SummaryPanelItem["items"];
          };
          summaries.push({
            toolCallId: block.toolCallId,
            title: args.title,
            items: Array.isArray(args.items) ? args.items : [],
            state: block.state,
          });
          break;
        }
        // confirm_form 分流消息流（正文位确认卡渲染；output 供终态回执展示）
        if (block.toolName === CONFIRM_FORM_TOOL_NAME) {
          const args = (block.args ?? {}) as {
            title?: string;
            workflowId?: number;
            workflowName?: string;
            fields?: ConfirmFormField[];
          };
          confirmForms.push({
            toolCallId: block.toolCallId,
            title: args.title,
            workflowId:
              typeof args.workflowId === "number" ? args.workflowId : 0,
            workflowName:
              typeof args.workflowName === "string" ? args.workflowName : "",
            fields: Array.isArray(args.fields) ? args.fields : [],
            state: block.state,
            output: typeof block.output === "string" ? block.output : undefined,
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
    tables,
    summaries,
    confirmForms,
    texts,
    usage,
    hasProcess:
      thinkingText.length > 0 ||
      tools.length > 0 ||
      widgets.length > 0 ||
      recommends.length > 0 ||
      tables.length > 0 ||
      summaries.length > 0 ||
      confirmForms.length > 0,
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

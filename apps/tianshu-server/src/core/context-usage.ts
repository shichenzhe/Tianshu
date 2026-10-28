/**
 * 上下文用量拆解（RC-T5 裁定：server 版保留——mirror 同名文件因闭包不纯
 * 未入 @tianshu/core（RC-T3 no-go），双份差异入 T7 drift manifest）。
 * blocks/history-truncate/tool-output-trim/param-merge 自 RC-T5 起消费
 * @tianshu/core 包实现；SkillSummary/ToolDefinitionLike 为本文件持有的
 * server 侧类型收敛。
 */
import { buildSystemPrompt, type SkillSummary } from './skill-prompt';
import {
  type ChatModelParams,
  estimateMessageTokens,
  estimateReserveTokens,
  estimateTokens,
  trimHistoryToolOutputs,
  truncateHistory,
} from '@tianshu/core';

/**
 * 工具定义最小形状（移植适配）：token 拆解仅消费 name（mcp__ 前缀分类）
 * 与 JSON 序列化全文（运行时传入完整定义对象，序列化含全部字段，估算
 * 口径与 mirror 一致）；完整 ToolDefinition（含 zod parameters/execute）
 * 由工具层引入，结构兼容可直接传入
 */
export interface ToolDefinitionLike {
  name: string;
  /** 完整工具定义其余字段透传（JSON 序列化计量口径） */
  [key: string]: unknown;
}

/** 上下文用量拆解（与下次请求实际组装同口径） */
export interface ContextUsageBreakdown {
  /** 系统提示词：人设/模式指令/压缩摘要（不含技能清单段） */
  system: number;
  /** 非 MCP 工具定义（内置工具与子智能体描述） */
  tools: number;
  /** 对话消息：截断后实际发送的历史 */
  messages: number;
  /** 连接器及 MCP：mcp__ 前缀工具定义 */
  mcp: number;
  /** 技能：system 中注入的技能清单段 */
  skills: number;
  /** 五项之和 */
  total: number;
  /** 模型上限（未配置为 null，前端显示 --） */
  contextWindow: number | null;
}

interface ComputeUsageParams {
  systemWithSummary?: string;
  skills: SkillSummary[];
  toolDefinitions: ToolDefinitionLike[];
  history: Array<{ role: 'user' | 'assistant'; blocks: string }>;
  contextWindow: number | null;
  params: ChatModelParams;
}

/** 工具定义 token：空集不序列化（计 0），与截断侧口径一致 */
function toolDefinitionTokens(defs: ToolDefinitionLike[]): number {
  return defs.length === 0 ? 0 : estimateTokens(JSON.stringify(defs));
}

/**
 * 上下文用量拆解（纯函数）：computeUsageBreakdown 在本仓仅单测消费
 * （语义守护），生产消费方在 mirror chat.service。与 runChatStream
 * 相同的组装口径——system 按技能段拆分、工具按 mcp__ 前缀拆分、
 * messages 经截断（含输出预留），展示的是下次请求实际占用的上下文
 */
export function computeUsageBreakdown(
  params: ComputeUsageParams,
): ContextUsageBreakdown {
  const skillsSection =
    params.skills.length > 0
      ? buildSystemPrompt(undefined, params.skills)
      : undefined;
  const skills = skillsSection ? estimateTokens(skillsSection) : 0;
  const systemTokens = params.systemWithSummary
    ? estimateTokens(params.systemWithSummary)
    : 0;
  const system = Math.max(0, systemTokens - skills);
  const isMcp = (def: ToolDefinitionLike) => def.name.startsWith('mcp__');
  const tools = toolDefinitionTokens(
    params.toolDefinitions.filter((def) => !isMcp(def)),
  );
  const mcp = toolDefinitionTokens(params.toolDefinitions.filter(isMcp));
  // 解析一次复用 + 旧轮工具输出瘦身（spec §18 项 1）：与 runChatStream
  // 回喂组装同口径——展示的是下次请求实际占用的上下文
  const messages = truncateHistory(
    trimHistoryToolOutputs(params.history),
    params.contextWindow ?? undefined,
    {
      reserveTokens: estimateReserveTokens(
        params.params.maxTokens,
        params.systemWithSummary,
        params.toolDefinitions,
      ),
    },
  ).reduce((sum, m) => sum + estimateMessageTokens(m.blocks), 0);
  const total = system + tools + messages + mcp + skills;
  return {
    system,
    tools,
    messages,
    mcp,
    skills,
    total,
    contextWindow: params.contextWindow,
  };
}

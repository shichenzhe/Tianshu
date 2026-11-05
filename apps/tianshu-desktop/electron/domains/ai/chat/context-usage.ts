import type { SkillInfo } from "../agent/skill-loader";
import { buildSystemPrompt } from "../agent/skill-prompt";
import type { ToolDefinition } from "../agent/file-tools";
import type { ChatModelParams } from "./param-merge";
import {
  estimateMessageTokens,
  estimateReserveTokens,
  estimateTokens,
  truncateHistory,
} from "./history-truncate";
import { trimHistoryToolOutputs } from "./tool-output-trim";

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
  /** 生效模型上限（三层兜底 model>provider>131072 后恒有值；类型保留 null
   *  供纯函数直测与未来无模型语境，生产调用侧不再出现 null） */
  contextWindow: number | null;
  /** 下次请求组装时硬截已发生（earliest 消息被裁出窗口——chat-core §6
   *  项 5 截断丢失提示，2026-11-05） */
  truncated: boolean;
  /** 被裁出的消息条数（truncated 时 > 0） */
  truncatedMessages: number;
  /** 成员调度累计（可观测性批：llmCallEvent meta 行聚合——真实发生量，
   *  独立于五类估算；无成员调用的会话不携带） */
  member?: MemberUsageSummary;
  /** 记忆占用（批9 P6）：个性化段实际注入 token（persona/画像/手动记忆/
   *  指令；已含于 system 项——拆解展示不加总，无个性化行不携带） */
  memory?: number;
}

/** 成员调度累计用量（专家团可观测性批） */
export interface MemberUsageSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

interface ComputeUsageParams {
  systemWithSummary?: string;
  skills: SkillInfo[];
  toolDefinitions: ToolDefinition[];
  history: Array<{ role: "user" | "assistant"; blocks: string }>;
  contextWindow: number | null;
  params: ChatModelParams;
}

/** 工具定义 token：空集不序列化（计 0），与截断侧口径一致 */
function toolDefinitionTokens(defs: ToolDefinition[]): number {
  return defs.length === 0 ? 0 : estimateTokens(JSON.stringify(defs));
}

/**
 * 上下文用量拆解（纯函数，供 chat:usage IPC 与单测复用）：
 * 与 runChatStream 相同的组装口径——system 按技能段拆分、工具按
 * mcp__ 前缀拆分、messages 经截断（含输出预留），展示的是下次
 * 请求实际占用的上下文
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
  const isMcp = (def: ToolDefinition) => def.name.startsWith("mcp__");
  const tools = toolDefinitionTokens(
    params.toolDefinitions.filter((def) => !isMcp(def)),
  );
  const mcp = toolDefinitionTokens(params.toolDefinitions.filter(isMcp));
  // 解析一次复用 + 旧轮工具输出瘦身（spec §18 项 1）：与 runChatStream
  // 回喂组装同口径——展示的是下次请求实际占用的上下文
  const trimmed = trimHistoryToolOutputs(params.history);
  const kept = truncateHistory(trimmed, params.contextWindow ?? undefined, {
    reserveTokens: estimateReserveTokens(
      params.params.maxTokens,
      params.systemWithSummary,
      params.toolDefinitions,
    ),
  });
  const messages = kept.reduce(
    (sum, m) => sum + estimateMessageTokens(m.blocks),
    0,
  );
  // 截断丢失提示（chat-core §6 项 5）：硬截静默发生 → 面板透出「已裁早期
  // 上下文」——kept 少于 trimmed 的条数即被裁消息数（同口径组装天然可得）
  const truncatedMessages = trimmed.length - kept.length;
  const total = system + tools + messages + mcp + skills;
  return {
    system,
    tools,
    messages,
    mcp,
    skills,
    total,
    contextWindow: params.contextWindow,
    truncated: truncatedMessages > 0,
    truncatedMessages,
  };
}

/** 成员调度用量聚合（可观测性批）：llmCallEvent meta 行（成员补全埋点）
 *  的本会话累计——真实发生量非估算 */
export function summarizeMemberUsage(
  rows: Array<{ inputTokens: number; outputTokens: number }>,
): MemberUsageSummary {
  return rows.reduce<MemberUsageSummary>(
    (sum, row) => ({
      calls: sum.calls + 1,
      inputTokens: sum.inputTokens + row.inputTokens,
      outputTokens: sum.outputTokens + row.outputTokens,
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0 },
  );
}

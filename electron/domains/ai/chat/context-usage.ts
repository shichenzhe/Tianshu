import type { SkillInfo } from "../agent/skill-loader";
import { buildSystemPrompt } from "../agent/skill-prompt";
import type { ToolDefinition } from "../agent/file-tools";
import { parseBlocks } from "./blocks";
import type { ChatModelParams } from "./param-merge";
import {
  estimateMessageTokens,
  estimateReserveTokens,
  estimateTokens,
  truncateHistory,
} from "./history-truncate";

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
  // 解析一次复用：截断估算与合计共享同一 parse 结果
  const messages = truncateHistory(
    params.history.map((m) => ({ ...m, blocks: parseBlocks(m.blocks) })),
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

import { app, dialog, ipcMain, shell, type WebContents } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  generateText,
  jsonSchema,
  streamText,
  stepCountIs,
  type FlexibleSchema,
  type LanguageModel,
  type ToolSet,
} from "ai";
import prisma from "../../../commons/prisma-client";
import Log from "../../../commons/Log";
import { buildPersonalizedSystem } from "../personalization/personalization.prompt";
import { loadPersonalization } from "../personalization/personalization.repo";
import {
  blocksToModelMessages,
  parseBlocks,
  serializeBlocks,
  type MessageBlock,
  type TextBlock,
  type ThinkingBlock,
  type ToolCallBlock,
} from "./blocks";
import { mergeParams, type ChatModelParams } from "./param-merge";
import { estimateReserveTokens, truncateHistory } from "./history-truncate";
import {
  computeUsageBreakdown,
  type ContextUsageBreakdown,
} from "./context-usage";
import { classifyError } from "./error-classify";
import { createLanguageModel } from "../provider/provider-factory";
import { SessionRepository, type AppendMessageParams } from "./session.repo";
import { registry, registerTools } from "../agent/tool-registry";
import { loadSkills, type SkillInfo } from "../agent/skill-loader";
import { buildSystemPrompt } from "../agent/skill-prompt";
import { makeReadSkillTool } from "../agent/read-skill";
import { makePlanTools } from "../agent/plan-tools";
import { filterDisabledSkills } from "../skill/skill-sync";
import type { ToolDefinition } from "../agent/file-tools";
import { resolveSafePath } from "../agent/file-tools";
import { ApprovalCoordinator } from "../agent/approval";
import { PermissionStore } from "../agent/permission-mode";
import {
  buildProjectSystemBase,
  type ProjectPromptContext,
} from "../../project/project-prompt";
import type ProjectRepository from "../../project/project.repo";
import type {
  ChatSendParams,
  ChatStatusResult,
  ChatStreamChunk,
} from "../../../../src-react/domains/ai/api/chat.api";
import type { WorkspaceRecord } from "../../../../src-react/domains/ai/api/workspace.api";
import type { SecurityEventSink } from "../../../../src-react/domains/security/model/types";
import {
  commandGate,
  commandWatchBlacklist,
  type CommandDecision,
} from "../../security/command-gate";
import { fileGate } from "../../security/file-gate";
import type { FileAccessDecision } from "../../security/file-policy";
import { countFilesForEstimate } from "../../security/file-history";
import type { BackupFileResult } from "../../security/file-history";

type AssistantRow = NonNullable<
  Awaited<ReturnType<typeof prisma.assistant.findFirst>>
>;

/** 会话消息行（regenerate / editAndResend 定位与截断共用） */
type ChatMessageRow = Awaited<
  ReturnType<typeof prisma.message.findMany>
>[number];

// plan_* 工具组静态注册进聚合 registry（模块加载一次；create_skill 经
// SkillRepository 构造注册先例）。项目会话专属——collectToolDefinitions
// 按会话归属过滤，非项目会话剔除；三工具均 write → 走统一两级审批门禁
registerTools(makePlanTools({ prisma }));

/** /compact 摘要指令:让模型基于全量历史输出可独立携带的上下文摘要 */
const COMPACT_DIRECTIVE =
  "请把以上对话压缩为一份简洁的上下文摘要,供后续对话直接引用:保留关键事实、已做的决定、未决事项、重要的文件路径/引用与代码要点,舍弃寒暄与过程细节。直接输出摘要正文,不要任何前言。";

/** assistant blocks JSON → 纯文本(text 块拼接;解析失败返回空串) */
function extractAssistantText(blocksJson: string): string {
  try {
    const blocks = JSON.parse(blocksJson) as Array<{
      type: string;
      text?: string;
    }>;
    return blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");
  } catch {
    return "";
  }
}

/** 步数上限保险丝（spec 决策 #3：宽上限，上下文截断为自然限界） */
const DEFAULT_MAX_STEPS = 50;

/** write 工具被用户拒绝时的回喂文案（spec 决策 #4：拒绝后循环继续） */
const TOOL_DENIED_OUTPUT = "用户拒绝了此操作";

/** P3 计划模式指令段（设计 spec §4 逐字） */
const PLAN_MODE_INSTRUCTION =
  "当前处于计划模式：请先分析任务并输出完整可执行的计划（步骤/涉及文件/命令），在我明确确认之前不要调用任何工具执行操作。";

/** 工具执行被中止时的回喂文案 */
const TOOL_ABORTED_OUTPUT = "已中断";

/** 工具输出 chunk / 落库截断上限，防止超长输出撑爆渲染层与 DB */
const TOOL_OUTPUT_SLICE = 2000;

/**
 * agent 上下文（P1）：工具执行与审批所需的最小注入集，
 * 由 ChatService 装配（prisma / ApprovalCoordinator），runChatStream 保持纯函数可测
 */
export interface AgentStreamOptions {
  sessionId: number;
  /**
   * 绑定目录的规范化绝对路径（无尾部分隔符）；未绑定目录时为 undefined——
   * 文件四件依赖它（不注入），read_skill 与 mcp__ 工具不依赖（P2 常驻）
   */
  workspacePath?: string;
  /**
   * 会话归属项目 id（项目模块子系统 F）：plan_* 工具组的属地依据，
   * 非项目会话为 null（该工具组在 collectToolDefinitions 侧已被剔除）
   */
  projectId?: number | null;
  /**
   * 完全访问实时判定（P3 spec §2）：每次 write 工具判定与执行前查询，
   * 撤回立即生效；P4 反馈 2.1：完全访问同时豁免 MCP 写工具
   */
  fullAccess: () => boolean;
  /**
   * 工作空间级工具记忆（P4 反馈 2，参照 Claude Code allowed-tools）：
   * 命中 toolPermission 表 → 跳过审批直执行；每次 write 判定前查询
   */
  isToolAllowed: (toolName: string) => Promise<boolean>;
  /** 挂起等待渲染层审批决议；resolve false = 拒绝 */
  requestApproval: (toolCallId: string, argSummary: string) => Promise<boolean>;
  /** 安全事件上报（SP1）：透传给工具 ctx（run_command 拦截/cwd 回退） */
  onSecurityEvent?: SecurityEventSink;
  /** 审批决议审计（SP1）：approved/denied 由 runToolCall 决议分支回调 */
  onApprovalResolved?: (
    toolName: string,
    decision: "approved" | "denied",
    argSummary: string,
  ) => void;
  /** 命令安全判定门（SP2）：缺省走 commandGate 模块单例 */
  decideCommand?: (command: string) => CommandDecision;
  /** 文件安全判定门（SP3）：缺省走 fileGate 模块单例 */
  decideFileAccess?: (
    absPath: string,
    workspacePath: string,
  ) => FileAccessDecision;
  /** 批量删除阈值（SP4 数据安全）：delete_file 目录预估 ≥ 阈值强制审批；缺省 50 */
  bulkDeleteThreshold?: number;
  /** 删除保护（SP4 数据安全）：透传 delete_file（true=回收站）；缺省 true */
  deleteProtection?: boolean;
  /** 备份回调（SP4 数据安全）：write_file 覆盖前 / delete_file 永久删除前；缺省不备份 */
  onBackupFile?: (
    absPath: string,
    sessionId: number,
  ) => Promise<BackupFileResult>;
  /** 无人值守流（automation，SP2）：ask 命中强制拒绝而非挂起审批 */
  unattended?: boolean;
}

/**
 * 数据安全装配（SP4）：ChatService 构造注入，闭包实时读安全中心配置
 * （运行中改配置即生效）；缺席（测试/未接线）时走缺省值
 */
export interface ChatDataSafety {
  backupFile: (absPath: string, sessionId: number) => Promise<BackupFileResult>;
  deleteProtection: () => boolean;
  bulkDeleteThreshold: () => number;
}

export interface ChatStreamOptions {
  model: LanguageModel;
  system?: string;
  /** 历史消息（含本次用户消息；函数内部截断并转换为 ModelMessage） */
  history: Array<{ role: "user" | "assistant"; blocks: string }>;
  params: ChatModelParams;
  contextWindow?: number;
  abortSignal?: AbortSignal;
  onChunk?: (chunk: ChatStreamChunk) => void;
  /**
   * 注入的工具定义（P2：service 组装——read_skill 常驻 + registry 注册工具，
   * 未绑定目录时不含文件四件；runChatStream 侧要求与 agent 同时在场才启用工具）
   */
  toolDefinitions?: ToolDefinition[];
  /** 工具执行/审批上下文；缺省时不注入工具（纯对话） */
  agent?: AgentStreamOptions;
  /** SDK 多步循环步数上限（保险丝），默认 50 */
  maxSteps?: number;
}

export interface ChatStreamResult {
  blocks: MessageBlock[];
  errorCode?: string;
  errorMessage?: string;
}

/** 审批横幅直显的参数摘要：run_command 取命令前 60 字符（spec §6），
 * 其余优先路径，否则 JSON 截断 */
function summarizeArgs(toolName: string, input: unknown): string {
  const record = (
    typeof input === "object" && input !== null ? input : {}
  ) as Record<string, unknown>;
  if (
    toolName === "run_command" &&
    typeof record.command === "string" &&
    record.command
  ) {
    return `${toolName} → ${record.command.slice(0, 60)}`;
  }
  if (typeof record.path === "string" && record.path) {
    return `${toolName} → ${record.path}`;
  }
  try {
    return JSON.stringify(input).slice(0, 100);
  } catch {
    return toolName;
  }
}

/** 工作空间路径规范化：resolve 绝对化并去尾部分隔符（T2 review carry） */
export function normalizeWorkspacePath(directoryPath: string): string {
  const resolved = path.resolve(directoryPath);
  return resolved.length > 1 && resolved.endsWith(path.sep)
    ? resolved.slice(0, -1)
    : resolved;
}

/**
 * 按会话模式组装 system（P3 spec R5）：ask 仅助手原文（技能清单不注入）；
 * plan 在技能组装结果之后以空行追加计划指令段；agent 现状
 */
function buildModeSystem(
  mode: "agent" | "ask" | "plan",
  base: string | undefined,
  skills: SkillInfo[],
): string | undefined {
  if (mode === "ask") {
    return base;
  }
  const withSkills = buildSystemPrompt(base, skills);
  if (mode !== "plan") {
    return withSkills;
  }
  return withSkills
    ? `${withSkills}\n\n${PLAN_MODE_INSTRUCTION}`
    : PLAN_MODE_INSTRUCTION;
}

/** 项目会话工具硬隔离结果（项目模块二期 §3.7）：ask 模式不适用（零工具零技能） */
interface ProjectToolIsolation {
  /** 过滤后技能清单（= 启用扫描结果 ∩ 挂载技能名） */
  skills: SkillInfo[];
  /** 声明段消费的项目上下文（技能名收窄到实际可用集，声明与实际一致） */
  declaredCtx: ProjectPromptContext;
  /** 挂载连接器名集合（mcp__ 工具前缀白名单；空数组 = 全隔离） */
  allowedMcpServers: string[];
}

/**
 * 项目会话工具硬隔离（项目模块二期 §3.7）：技能清单按挂载集过滤、
 * 声明段技能名同步收窄、连接器名透传为 mcp__ 前缀白名单。
 * 纯函数：由 assembleContext 在项目上下文非空且非 ask 模式时调用
 */
function isolateProjectTools(
  skills: SkillInfo[],
  projectCtx: ProjectPromptContext,
): ProjectToolIsolation {
  const mounted = skills.filter((skill) =>
    projectCtx.boundSkillNames.includes(skill.name),
  );
  return {
    skills: mounted,
    declaredCtx: {
      ...projectCtx,
      boundSkillNames: mounted.map((skill) => skill.name),
    },
    allowedMcpServers: projectCtx.boundConnectorNames,
  };
}

/**
 * promise 与中止信号竞速：SDK 流迭代会等待 execute settle，用户中止时
 * 必须主动了结（审批挂起/长执行场景），否则整条流永久悬挂
 */
function raceWithAbort<T>(
  promise: Promise<T>,
  abortSignal: AbortSignal | undefined,
  onAbort: () => T,
): Promise<T> {
  if (!abortSignal) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const detach = () => abortSignal.removeEventListener("abort", onAbortEvent);
    const onAbortEvent = () => {
      detach();
      resolve(onAbort());
    };
    if (abortSignal.aborted) {
      onAbortEvent();
      return;
    }
    abortSignal.addEventListener("abort", onAbortEvent, { once: true });
    promise.then(
      (value) => {
        detach();
        resolve(value);
      },
      (error) => {
        detach();
        reject(error);
      },
    );
  });
}

/** 挂起等待审批：推 awaiting-approval 与 approval-request 两 chunk 后等待决议 */
async function requestToolApproval(
  def: ToolDefinition,
  toolCallId: string,
  input: unknown,
  agent: AgentStreamOptions,
  onChunk?: (chunk: ChatStreamChunk) => void,
): Promise<boolean> {
  const argSummary = summarizeArgs(def.name, input);
  onChunk?.({
    type: "tool-update",
    toolCallId,
    toolName: def.name,
    state: "awaiting-approval",
  });
  onChunk?.({
    type: "approval-request",
    toolCallId,
    toolName: def.name,
    argSummary,
  });
  return agent.requestApproval(toolCallId, argSummary);
}

/** 工具执行异常兜底：转「错误:」文案回喂，避免 tool-error 打断流 */
async function executeToolSafe(
  def: ToolDefinition,
  agent: AgentStreamOptions,
  input: unknown,
): Promise<string> {
  try {
    return await def.execute(
      // 未绑定工作空间时无路径（文件工具不会注入；mcp/read_skill 不读 ctx）；
      // fullAccess 供文件四件边界放开与 run_command cwd 放开（P3 spec §6）；
      // projectId 供 plan_* 工具属地校验（子系统 F，非项目会话 null）；
      // onSecurityEvent 供 run_command 拦截/cwd 回退上报（SP1 审计）
      {
        workspacePath: agent.workspacePath ?? "",
        sessionId: agent.sessionId,
        fullAccess: agent.fullAccess(),
        projectId: agent.projectId ?? null,
        onSecurityEvent: agent.onSecurityEvent,
        // SP2 子进程黑名单（会话与 automation 统一监控；win32 在 child-monitor 内 no-op）
        commandWatchBlacklist: commandWatchBlacklist(),
        // SP4 数据安全：删除保护与备份回调（装配快照，每流一次）
        deleteProtection: agent.deleteProtection,
        onBackupFile: agent.onBackupFile,
      },
      input,
    );
  } catch (e) {
    return `错误: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 审批决议类型：aborted 与用户拒绝区分（前者落 error 终态） */
type ApprovalDecision = "approved" | "denied" | "aborted";

function toApprovalDecision(approved: boolean): ApprovalDecision {
  return approved ? "approved" : "denied";
}

/** 审批决议（含中止竞速）：等待用户决议或中止信号先到 */
async function awaitApproval(
  def: ToolDefinition,
  toolCallId: string,
  input: unknown,
  agent: AgentStreamOptions,
  abortSignal: AbortSignal | undefined,
  onChunk?: (chunk: ChatStreamChunk) => void,
): Promise<ApprovalDecision> {
  return raceWithAbort(
    requestToolApproval(def, toolCallId, input, agent, onChunk).then(
      toApprovalDecision,
    ),
    abortSignal,
    () => "aborted",
  );
}

const COMMAND_BLOCKED_OUTPUT = "错误: 该命令被命令安全策略禁止（程序黑名单）";
const COMMAND_UNATTENDED_OUTPUT =
  "错误: 无人值守任务不可执行询问名单命令，请从询问名单移除或改为人工会话执行";

/** run_command 判定门：非 run_command 或无命令返回 null */
function resolveCommandGate(
  agent: AgentStreamOptions,
  toolName: string,
  input: unknown,
): CommandDecision | null {
  if (toolName !== "run_command") return null;
  const command = (input as { command?: unknown } | null)?.command;
  if (typeof command !== "string" || command === "") return null;
  return (agent.decideCommand ?? commandGate)(command);
}

/** 命令判定门审计事件（detail 带 command 截断 + 附加字段） */
function emitCommandEvent(
  agent: AgentStreamOptions,
  input: unknown,
  eventType: string,
  decision: "blocked" | "rejected" | "info" | "allowed",
  extra: Record<string, unknown>,
): void {
  const command = String(
    (input as { command?: unknown } | null)?.command ?? "",
  );
  agent.onSecurityEvent?.({
    eventType,
    decision,
    detail: { command: command.slice(0, 200), ...extra },
    commandPreview: command.slice(0, 100),
    sessionId: agent.sessionId,
  });
}

const FILE_UNATTENDED_OUTPUT =
  "错误: 无人值守任务不可访问黑名单路径，请调整名单或改为人工会话执行";
const FILE_GATE_TOOLS = new Set([
  "read_file",
  "write_file",
  "list_dir",
  "delete_file",
]);

/** 批量删除 unattended 强拒文案（SP4） */
const BULK_UNATTENDED_OUTPUT =
  "错误: 无人值守任务不可执行批量删除，请调整安全中心阈值或改为人工会话执行";
/** 批量删除阈值缺省（SP4）：与安全中心默认配置一致（bulkDeleteThreshold） */
const BULK_DELETE_THRESHOLD_DEFAULT = 50;

/** 批量删除预估（SP4）：delete_file 且目录预估 ≥ 阈值 → 估值；不涉及返回 null */
async function resolveBulkDelete(
  agent: AgentStreamOptions,
  toolName: string,
  input: unknown,
): Promise<number | null> {
  if (toolName !== "delete_file" || !agent.workspacePath) return null;
  const rel = (input as { path?: unknown } | null)?.path;
  if (typeof rel !== "string" || rel === "") return null;
  try {
    const abs = resolveSafePath(agent.workspacePath, rel, agent.fullAccess());
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat?.isDirectory()) return null;
    const threshold =
      agent.bulkDeleteThreshold ?? BULK_DELETE_THRESHOLD_DEFAULT;
    const count = await countFilesForEstimate(abs);
    return count >= threshold ? count : null;
  } catch {
    return null;
  }
}

/** 文件判定门：非文件工具/无 path/解析失败（越界等）返回 null */
function resolveFileGate(
  agent: AgentStreamOptions,
  toolName: string,
  input: unknown,
): FileAccessDecision | null {
  if (!FILE_GATE_TOOLS.has(toolName) || !agent.workspacePath) return null;
  const rel = (input as { path?: unknown } | null)?.path;
  if (typeof rel !== "string" || rel === "") return null;
  try {
    const abs = resolveSafePath(agent.workspacePath, rel, agent.fullAccess());
    return (agent.decideFileAccess ?? fileGate)(abs, agent.workspacePath);
  } catch {
    return null;
  }
}

/** 文件门审计事件（detail.path 截 200 + 附加字段） */
function emitFileEvent(
  agent: AgentStreamOptions,
  input: unknown,
  eventType: string,
  decision: "rejected" | "info" | "allowed",
  extra: Record<string, unknown>,
): void {
  const p = String((input as { path?: unknown } | null)?.path ?? "");
  agent.onSecurityEvent?.({
    eventType,
    decision,
    detail: { path: p.slice(0, 200), ...extra },
    sessionId: agent.sessionId,
  });
}

/**
 * 工具调用全流程（包装注册表工具的 execute，供单测导出）：
 * 命令判定门（SP2）：run_command 先经 gate——block 拒 / ask 无条件审批
 * （unattended 强拒）/ allow 跳审批 / default 回落既有链路（行为不变）；
 * 文件判定门（SP3，SP4 增 delete_file）：文件四件先经 gate——block 无条件审批
 * （unattended 强拒）/ allow 跳审批 / default 回落既有链路（与命令门互斥，default 时链路不变）；
 * 批量删除预估门（SP4）：delete_file 目录预估 ≥ 阈值 → 无条件强制审批
 * （fullAccess 不豁免；unattended 强拒）；
 * write 审批判定（P4 反馈）——完全访问直执行（含 MCP）；
 * 工作空间已记忆（toolPermission 表，参照 Claude Code allowed-tools）直执行；
 * 默认态且未记忆 → 挂起审批；拒绝以文案回喂（循环继续）；中止竞速防流悬挂
 */
export async function runToolCall(
  def: ToolDefinition,
  agent: AgentStreamOptions,
  toolCallId: string,
  input: unknown,
  abortSignal: AbortSignal | undefined,
  onChunk?: (chunk: ChatStreamChunk) => void,
  finalStates?: Map<string, ToolCallBlock["state"]>,
): Promise<string> {
  const gate = resolveCommandGate(agent, def.name, input);
  if (gate === "block") {
    finalStates?.set(toolCallId, "denied");
    onChunk?.({
      type: "tool-update",
      toolCallId,
      toolName: def.name,
      state: "denied",
      output: COMMAND_BLOCKED_OUTPUT,
    });
    emitCommandEvent(agent, input, "command-safety.blocked", "blocked", {
      source: "blacklist",
    });
    return COMMAND_BLOCKED_OUTPUT;
  }
  if (gate === "ask" && agent.unattended) {
    finalStates?.set(toolCallId, "denied");
    onChunk?.({
      type: "tool-update",
      toolCallId,
      toolName: def.name,
      state: "denied",
      output: COMMAND_UNATTENDED_OUTPUT,
    });
    emitCommandEvent(agent, input, "command-safety.rejected", "rejected", {
      reason: "unattended",
    });
    return COMMAND_UNATTENDED_OUTPUT;
  }
  if (gate === "ask") {
    emitCommandEvent(agent, input, "command-safety.needs-approval", "info", {});
  }
  if (gate === "allow") {
    emitCommandEvent(
      agent,
      input,
      "command-safety.allow-listed",
      "allowed",
      {},
    );
  }
  const fileGateDecision = resolveFileGate(agent, def.name, input);
  if (fileGateDecision === "block" && agent.unattended) {
    finalStates?.set(toolCallId, "denied");
    onChunk?.({
      type: "tool-update",
      toolCallId,
      toolName: def.name,
      state: "denied",
      output: FILE_UNATTENDED_OUTPUT,
    });
    emitFileEvent(agent, input, "file-safety.rejected", "rejected", {
      reason: "unattended",
    });
    return FILE_UNATTENDED_OUTPUT;
  }
  if (fileGateDecision === "block") {
    emitFileEvent(agent, input, "file-safety.needs-approval", "info", {
      source: "blocklist",
    });
  }
  if (fileGateDecision === "allow") {
    emitFileEvent(agent, input, "file-safety.allow-listed", "allowed", {});
  }
  const bulkEstimate = await resolveBulkDelete(agent, def.name, input);
  if (bulkEstimate !== null && agent.unattended) {
    finalStates?.set(toolCallId, "denied");
    onChunk?.({
      type: "tool-update",
      toolCallId,
      toolName: def.name,
      state: "denied",
      output: BULK_UNATTENDED_OUTPUT,
    });
    emitFileEvent(
      agent,
      input,
      "data-safety.bulk-delete-rejected",
      "rejected",
      {
        estimated: bulkEstimate,
        reason: "unattended",
      },
    );
    return BULK_UNATTENDED_OUTPUT;
  }
  if (bulkEstimate !== null) {
    emitFileEvent(
      agent,
      input,
      "data-safety.bulk-delete-needs-approval",
      "info",
      { estimated: bulkEstimate },
    );
  }
  const needsApproval =
    bulkEstimate !== null ||
    gate === "ask" ||
    fileGateDecision === "block" ||
    (gate !== "allow" &&
      fileGateDecision !== "allow" &&
      def.kind === "write" &&
      !agent.fullAccess() &&
      !(await agent.isToolAllowed(def.name)));
  if (needsApproval) {
    const decision = await awaitApproval(
      def,
      toolCallId,
      input,
      agent,
      abortSignal,
      onChunk,
    );
    if (decision === "aborted") {
      finalStates?.set(toolCallId, "error");
      return TOOL_ABORTED_OUTPUT;
    }
    if (decision === "denied") {
      finalStates?.set(toolCallId, "denied");
      onChunk?.({
        type: "tool-update",
        toolCallId,
        toolName: def.name,
        state: "denied",
        output: TOOL_DENIED_OUTPUT,
      });
      agent.onApprovalResolved?.(
        def.name,
        decision,
        summarizeArgs(def.name, input),
      );
      return TOOL_DENIED_OUTPUT;
    }
    // aborted/denied 均已 return，此处必为 approved（SP1 审计：批准决议）
    agent.onApprovalResolved?.(
      def.name,
      decision,
      summarizeArgs(def.name, input),
    );
  }
  onChunk?.({
    type: "tool-update",
    toolCallId,
    toolName: def.name,
    state: "running",
  });
  const output = await raceWithAbort(
    executeToolSafe(def, agent, input),
    abortSignal,
    () => {
      finalStates?.set(toolCallId, "error");
      return TOOL_ABORTED_OUTPUT;
    },
  );
  if (abortSignal?.aborted) {
    return output;
  }
  onChunk?.({
    type: "tool-update",
    toolCallId,
    toolName: def.name,
    state: output.startsWith("错误:") ? "error" : "done",
    output: output.slice(0, TOOL_OUTPUT_SLICE),
  });
  return output;
}

/**
 * SDK inputSchema 分流（P2 硬 carry M4）：内置工具为 zod schema 原样注入；
 * MCP 工具 parameters 是 JSON Schema 裸对象——SDK asSchema 会将其误当
 * lazy schema 调用而崩溃，必须先经 jsonSchema() 包装
 */
function toInputSchema(
  parameters: ToolDefinition["parameters"],
): FlexibleSchema {
  if (parameters instanceof z.ZodType) {
    return parameters;
  }
  return jsonSchema(parameters as Parameters<typeof jsonSchema>[0]);
}

/** 组装 SDK ToolSet：SDK 按 inputSchema 自动校验 input，无需手动校验
 * （v7 事实核正：工具 schema 属性名为 inputSchema，非 parameters） */
function buildToolSet(
  defs: ToolDefinition[],
  agent: AgentStreamOptions,
  onChunk?: (chunk: ChatStreamChunk) => void,
  finalStates?: Map<string, ToolCallBlock["state"]>,
): ToolSet {
  const set: ToolSet = {};
  for (const def of defs) {
    set[def.name] = {
      description: def.description,
      inputSchema: toInputSchema(def.parameters),
      // execute 第二参 options 携带 toolCallId 与 abortSignal（v7 ToolExecutionOptions）
      execute: (input, options) =>
        runToolCall(
          def,
          agent,
          options.toolCallId,
          input,
          options.abortSignal,
          onChunk,
          finalStates,
        ),
    };
  }
  return set;
}

/** text/thinking 增量：无开放块则新起一块（工具调用后的文本另起新块，保序） */
function appendDelta<T extends TextBlock | ThinkingBlock>(
  blocks: MessageBlock[],
  open: T | null,
  type: T["type"],
  delta: string,
  onChunk?: (chunk: ChatStreamChunk) => void,
): T {
  if (!open) {
    open = { type, text: "" } as T;
    blocks.push(open);
  }
  open.text += delta;
  onChunk?.(
    type === "text"
      ? { type: "text-delta", text: delta }
      : { type: "reasoning-delta", text: delta },
  );
  return open;
}

function asArgs(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

/** tool-call part：关闭开放块语义由调用方处理，此处落块并推 ready chunk */
function handleToolCallPart(
  blocks: MessageBlock[],
  toolBlocks: Map<string, ToolCallBlock>,
  part: { toolCallId: string; toolName: string; input: unknown },
  onChunk?: (chunk: ChatStreamChunk) => void,
): void {
  const block: ToolCallBlock = {
    type: "tool_call",
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    args: asArgs(part.input),
    state: "ready",
  };
  blocks.push(block);
  toolBlocks.set(block.toolCallId, block);
  onChunk?.({
    type: "tool-update",
    toolCallId: block.toolCallId,
    toolName: block.toolName,
    args: block.args,
    state: "ready",
  });
}

/** tool-result part：按拒绝/错误/成功落终态（拒绝/中止由 execute 包装器标记） */
function finalizeToolBlock(
  block: ToolCallBlock | undefined,
  output: string,
  finalStates: Map<string, ToolCallBlock["state"]>,
): void {
  if (!block) {
    return;
  }
  block.output = output;
  block.state =
    finalStates.get(block.toolCallId) ??
    (output.startsWith("错误:") ? "error" : "done");
}

function markToolError(block: ToolCallBlock | undefined, error: unknown): void {
  if (!block) {
    return;
  }
  block.state = "error";
  block.output = `错误: ${error instanceof Error ? error.message : String(error)}`;
}

/** 中断/异常时未到达终态的工具块记 error("已中断")（spec §1 持久化决策） */
function finalizeInterruptedToolBlocks(
  toolBlocks: Map<string, ToolCallBlock>,
): void {
  const nonTerminal = new Set(["ready", "awaiting-approval", "running"]);
  for (const block of toolBlocks.values()) {
    if (nonTerminal.has(block.state)) {
      block.state = "error";
      block.output = "已中断";
    }
  }
}

/**
 * 流式执行核心（可注入 model 与工具，供单测）。
 * 传入 toolDefinitions + agent 时启用 SDK 内建多步工具循环
 * （stopWhen 保险丝），tool-result 自动回喂下一步；否则与 P0 行为一致
 */
export async function runChatStream(
  options: ChatStreamOptions,
): Promise<ChatStreamResult> {
  const blocks: MessageBlock[] = [];
  const toolBlocks = new Map<string, ToolCallBlock>();
  const finalStates = new Map<string, ToolCallBlock["state"]>();
  let openText: TextBlock | null = null;
  let openThinking: ThinkingBlock | null = null;
  let usage: { input: number; output: number } | undefined;
  let errorCode: string | undefined;
  let errorMessage: string | undefined;

  const messages = truncateHistory(options.history, options.contextWindow, {
    reserveTokens: estimateReserveTokens(
      options.params.maxTokens,
      options.system,
      options.toolDefinitions ?? [],
    ),
  }).flatMap((m) => blocksToModelMessages(parseBlocks(m.blocks), m.role));

  const streamOptions = {
    model: options.model,
    system: options.system,
    messages,
    temperature: options.params.temperature,
    topP: options.params.topP,
    maxOutputTokens: options.params.maxTokens,
    abortSignal: options.abortSignal,
  };
  const tools =
    options.agent && options.toolDefinitions?.length
      ? buildToolSet(
          options.toolDefinitions,
          options.agent,
          options.onChunk,
          finalStates,
        )
      : undefined;
  const result = tools
    ? streamText({
        ...streamOptions,
        tools,
        stopWhen: stepCountIs(options.maxSteps ?? DEFAULT_MAX_STEPS),
      })
    : streamText(streamOptions);

  try {
    for await (const part of result.stream) {
      if (part.type === "text-delta") {
        openText = appendDelta(
          blocks,
          openText,
          "text",
          part.text,
          options.onChunk,
        );
      } else if (part.type === "reasoning-delta") {
        openThinking = appendDelta(
          blocks,
          openThinking,
          "thinking",
          part.text,
          options.onChunk,
        );
      } else if (part.type === "tool-call") {
        // 工具调用打断文本流：关闭开放块，后续文本另起新块
        openText = null;
        openThinking = null;
        handleToolCallPart(blocks, toolBlocks, part, options.onChunk);
      } else if (part.type === "tool-result") {
        finalizeToolBlock(
          toolBlocks.get(part.toolCallId),
          String(part.output ?? ""),
          finalStates,
        );
      } else if (part.type === "tool-error") {
        markToolError(toolBlocks.get(part.toolCallId), part.error);
      } else if (part.type === "finish") {
        openText = null;
        openThinking = null;
        // 错误路径的 finish 无真实 token 数（undefined），不产出 usage
        const { inputTokens, outputTokens } = part.totalUsage;
        if (inputTokens !== undefined || outputTokens !== undefined) {
          usage = {
            input: inputTokens ?? 0,
            output: outputTokens ?? 0,
          };
        }
      } else if (part.type === "error") {
        // 用户主动中止不是错误：不记录错误码、不推送错误 chunk（已生成部分照常保留）
        if (options.abortSignal?.aborted) {
          continue;
        }
        errorCode = classifyError(part.error);
        errorMessage =
          part.error instanceof Error ? part.error.message : String(part.error);
      }
    }
  } catch (error) {
    // 迭代抛出的异常（渲染层销毁、模型流中断等）与 error part 等价处理；
    // 用户主动中止不是错误：吞掉异常，保留已累积内容
    if (!options.abortSignal?.aborted) {
      errorCode = classifyError(error);
      errorMessage = error instanceof Error ? error.message : String(error);
    }
  }
  finalizeInterruptedToolBlocks(toolBlocks);

  if (usage) {
    blocks.push({ type: "usage", input: usage.input, output: usage.output });
  }
  return { blocks, errorCode, errorMessage };
}

/** 流式工具态快照（chat:status 恢复渲染层 agent 态用，与 T6 store 同构） */
export interface ToolSnapshotState {
  toolName: string;
  args?: unknown;
  state: string;
  output?: string;
  argSummary?: string;
}

interface StreamSnapshot {
  text: string;
  thinking: string;
  tools: { order: string[]; map: Record<string, ToolSnapshotState> };
}

function emptySnapshot(): StreamSnapshot {
  return { text: "", thinking: "", tools: { order: [], map: {} } };
}

type ToolStreamChunk = Extract<
  ChatStreamChunk,
  { type: "tool-update" | "approval-request" }
>;

/** 最小依赖接口：仅用到禁用名单（测试可注入 stub） */
type SkillDisabledLookup = { getDisabledNames(): Promise<Set<string>> };

export default class ChatService {
  private aborts = new Map<number, AbortController>();
  private snapshots = new Map<number, StreamSnapshot>();
  private approvals = new ApprovalCoordinator();
  /** P3：会话工具权限模式（内存态，spec §8：无会话校验静默收） */
  private permissions = new PermissionStore();

  constructor(
    private sessions: SessionRepository,
    private skillRepo?: SkillDisabledLookup,
    // 项目模块一期：项目会话 base 注入项目上下文（项目指令+挂载专家）；
    // repo 缺席（测试）时回退助手 prompt，行为与非项目会话一致
    private projectRepo?: ProjectRepository,
    // 审计事件出口（SP1）：Application 注入 auditLogService.append；
    // 缺席（测试/未接线）时全部回调静默空转，行为与接入前一致
    private auditSink?: SecurityEventSink,
    // 数据安全装配（SP4）：Application 注入备份/删除保护/批量阈值闭包；
    // 缺席（测试/未接线）时走缺省值，行为与接入前一致
    private dataSafety?: ChatDataSafety,
  ) {
    this.registerHandlers();
  }

  private registerHandlers() {
    ipcMain.handle("chat:send", (event, params: ChatSendParams) =>
      this.send(params, event.sender),
    );
    ipcMain.handle("chat:compact", (event, sessionId: number) =>
      this.compact(sessionId, event.sender),
    );
    ipcMain.handle(
      "chat:regenerate",
      (event, sessionId: number, messageId?: number) =>
        this.regenerate(sessionId, messageId, event.sender),
    );
    // 编辑重发：改写目标 user 消息并删除其后全部，重跑流
    ipcMain.handle(
      "chat:editAndResend",
      (event, sessionId: number, messageId: number, content: string) =>
        this.editAndResend(sessionId, messageId, content, event.sender),
    );
    ipcMain.handle("chat:stop", (_, sessionId: number) => this.stop(sessionId));
    ipcMain.handle("chat:status", (_, sessionId: number) =>
      this.status(sessionId),
    );
    // 上下文用量拆解（输入框环形指示器数据源）
    ipcMain.handle("chat:usage", (_, sessionId: number) =>
      this.getUsageBreakdown(sessionId),
    );
    // P1 审批决议：渲染层 → 主进程，resolve 挂起的 write 工具
    ipcMain.handle(
      "agent:approve",
      (_, toolCallId: string, approved: boolean) =>
        this.approvals.respond(toolCallId, approved),
    );
    // P3 会话工具权限：default 询问 / full 放行（spec §8：无会话校验静默收）
    ipcMain.handle("permission:get", (_, sessionId: number) =>
      this.permissions.get(sessionId),
    );
    ipcMain.handle(
      "permission:set",
      (_, sessionId: number, mode: "default" | "full") =>
        this.permissions.set(sessionId, mode),
    );
    // P4 工作空间级工具记忆（参照 Claude Code allowed-tools）：
    // 「允许并记住」写表 → 该工具在本工作空间后续免审
    ipcMain.handle(
      "permission:rememberTool",
      async (_, workspaceId: number, toolName: string): Promise<void> => {
        await prisma.toolPermission.upsert({
          where: { workspaceId_toolName: { workspaceId, toolName } },
          update: {},
          create: { workspaceId, toolName },
        });
        // remembered 审计（SP1 终审归档补齐项，SP2 接入）
        this.auditSink?.({
          eventType: `${
            toolName === "run_command" ? "command-safety" : "file-safety"
          }.remembered`,
          decision: "info",
          detail: { tool: toolName, workspaceId },
        });
      },
    );
    ipcMain.handle(
      "permission:listAllowedTools",
      (_, workspaceId: number): Promise<string[]> =>
        prisma.toolPermission
          .findMany({
            where: { workspaceId },
            orderBy: { createdAt: "desc" },
            select: { toolName: true },
          })
          .then((rows) => rows.map((row) => row.toolName)),
    );
    ipcMain.handle(
      "permission:forgetTool",
      async (_, workspaceId: number, toolName: string): Promise<void> => {
        await prisma.toolPermission.deleteMany({
          where: { workspaceId, toolName },
        });
      },
    );
    // P1 工作空间目录绑定：目录选择弹窗在主进程（dialog 属 GUI，repo 不引 electron）。
    // 用户取消返回 null，渲染层静默处理；存入前归一化（resolve + 去尾分隔符）
    ipcMain.handle(
      "workspace:bindDirectory",
      async (_, workspaceId: number): Promise<WorkspaceRecord | null> => {
        const result = await dialog.showOpenDialog({
          properties: ["openDirectory"],
        });
        if (result.canceled || !result.filePaths[0]) {
          return null;
        }
        return this.sessions.updateWorkspaceBoundDirectory(
          workspaceId,
          normalizeWorkspacePath(result.filePaths[0]),
        );
      },
    );
    // 解绑走同一写通道（null = 解绑），独立于 workspace:update 参数类型
    ipcMain.handle(
      "workspace:unbindDirectory",
      async (_, workspaceId: number): Promise<WorkspaceRecord | null> =>
        this.sessions.updateWorkspaceBoundDirectory(workspaceId, null),
    );
    // 技能目录一键打开（P2 skill 无管理界面，文件系统即配置——保证发现性）
    ipcMain.handle("skill:openDir", async (): Promise<string> => {
      const skillsDir = path.join(app.getPath("userData"), "skills");
      await fs.mkdir(skillsDir, { recursive: true });
      // openPath 失败时 resolve 而非 reject（返回错误串）——转 reject 让渲染层 toast
      const openError = await shell.openPath(skillsDir);
      if (openError) {
        throw new Error(openError);
      }
      return skillsDir;
    });
    // P3 文件引用：多选弹窗 + 逐文件读取文本（≤512KB、NUL 视为二进制拒绝）。
    // 单文件失败不影响其余（带 error 返回，渲染层 toast 后丢弃）；取消返回空数组
    ipcMain.handle(
      "file:pickAndRead",
      async (): Promise<
        Array<
          { path: string; content: string } | { path: string; error: string }
        >
      > => {
        const result = await dialog.showOpenDialog({
          properties: ["openFile", "multiSelections"],
        });
        if (result.canceled || result.filePaths.length === 0) {
          return [];
        }
        return Promise.all(
          result.filePaths.map(async (filePath) => {
            try {
              const stat = await fs.stat(filePath);
              if (stat.size > 512 * 1024) {
                return { path: filePath, error: "超过 512KB 上限" };
              }
              const buf = await fs.readFile(filePath);
              if (buf.includes(0)) {
                return { path: filePath, error: "二进制文件不支持" };
              }
              return { path: filePath, content: buf.toString("utf8") };
            } catch {
              return { path: filePath, error: "读取失败" };
            }
          }),
        );
      },
    );
    // @ 联想数据源：工作空间内文件清单（相对路径，posix 分隔符）；
    // 排除 node_modules/.git/dist 与隐藏项，上限 2000；未绑定目录返回 null
    ipcMain.handle(
      "file:listWorkspaceFiles",
      async (_, workspaceId: number): Promise<string[] | null> => {
        const workspace = await this.sessions.getWorkspace(workspaceId);
        const root = workspace?.directoryPath?.trim();
        if (!root) {
          return null;
        }
        const EXCLUDED = new Set(["node_modules", ".git", "dist"]);
        const files: string[] = [];
        const walk = async (dir: string, prefix: string): Promise<void> => {
          if (files.length >= 2000) {
            return;
          }
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (files.length >= 2000) {
              return;
            }
            if (entry.name.startsWith(".")) {
              continue;
            }
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
              if (EXCLUDED.has(entry.name)) {
                continue;
              }
              await walk(path.join(dir, entry.name), rel);
            } else if (entry.isFile()) {
              files.push(rel);
            }
          }
        };
        try {
          await walk(root, "");
        } catch {
          return files;
        }
        return files;
      },
    );
    // @ 选中后读取工作空间内单个文件；resolveSafePath 校验 + 同 pickAndRead 的
    // 大小/二进制规则
    ipcMain.handle(
      "file:readWorkspaceFile",
      async (
        _,
        workspaceId: number,
        relPath: string,
      ): Promise<{ content: string } | { error: string }> => {
        const workspace = await this.sessions.getWorkspace(workspaceId);
        const root = workspace?.directoryPath?.trim();
        if (!root) {
          return { error: "未绑定工作空间目录" };
        }
        let absolute: string;
        try {
          absolute = resolveSafePath(root, relPath);
        } catch {
          return { error: "路径超出工作空间范围" };
        }
        try {
          const stat = await fs.stat(absolute);
          if (stat.size > 512 * 1024) {
            return { error: "超过 512KB 上限" };
          }
          const buf = await fs.readFile(absolute);
          if (buf.includes(0)) {
            return { error: "二进制文件不支持" };
          }
          return { content: buf.toString("utf8") };
        } catch {
          return { error: "读取失败" };
        }
      },
    );
  }

  private emit(
    sender: WebContents | undefined,
    sessionId: number,
    chunk: ChatStreamChunk,
  ) {
    // 渲染层窗口可能已销毁：跳过推送，避免异常冒泡中断持久化与终止 chunk
    if (!sender || sender.isDestroyed()) {
      return;
    }
    sender.send(`chat:stream:${sessionId}`, chunk);
  }

  /**
   * /compact 会话压缩(/compact 命令实现):先清压缩态(保证压缩基于全量
   * 历史)→ 摘要指令走一次普通 send(流式可见)→ 取最后一条 assistant 文本
   * 落 session.summary/compactedUpToId;后续 send 上下文 = 摘要 + 压缩点后消息
   */
  async compact(sessionId: number, sender?: WebContents): Promise<void> {
    const session = await this.sessions.getSession(sessionId);
    if (!session) {
      throw new Error("SESSION_NOT_FOUND");
    }
    await this.sessions.updateSummary(sessionId, null, null);
    await this.send({ sessionId, content: COMPACT_DIRECTIVE }, sender);
    const rows = await prisma.message.findMany({
      where: { sessionId, role: "assistant" },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    const last = rows[0];
    if (!last) {
      return;
    }
    const summaryText = extractAssistantText(last.blocks);
    if (summaryText.trim() === "") {
      return;
    }
    await this.sessions.updateSummary(sessionId, summaryText, last.id);
  }

  async send(params: ChatSendParams, sender?: WebContents): Promise<void> {
    // 并发检查必须是首条语句；AbortController 在首个 await 前注册，消除 TOCTOU 窗口
    // 业务错误 message 只传错误码（Electron invoke 拒绝时仅保留 message），渲染端映射 i18n
    if (this.aborts.has(params.sessionId)) {
      throw new Error("CONCURRENT_REQUEST");
    }
    const abort = new AbortController();
    this.aborts.set(params.sessionId, abort);
    try {
      const session = await this.sessions.getSession(params.sessionId);
      if (!session) {
        throw new Error("SESSION_NOT_FOUND");
      }

      // 请求级模型选择写入会话当前值（会话记住上次选择，spec §4.2）
      if (params.modelId) {
        await this.sessions.setSessionModel(params.sessionId, params.modelId);
      }

      // 用户消息立即落库 + 首条消息自动起标题
      await this.sessions.appendMessage({
        sessionId: params.sessionId,
        role: "user",
        blocks: serializeBlocks([{ type: "text", text: params.content }]),
        assistantId: session.assistantId ?? undefined,
      } satisfies AppendMessageParams);
      await this.sessions.autotitleIfDefault(params.sessionId, params.content);

      await this.streamAndPersist(
        params.sessionId,
        abort,
        sender,
        params.overrides,
      );
    } catch (error) {
      // 早期失败（会话不存在/未选模型等）也要清理注册，避免映射表泄漏；
      // streamAndPersist 的 finally 已清理时此处为幂等空操作
      this.aborts.delete(params.sessionId);
      throw error;
    }
  }

  /**
   * 重新生成(任意位置):目标 assistant 消息(缺省最后一条)→ 定位其前
   * 最后一条 user,删除该 user 之后全部(目标及其后内容被覆盖)→ 重跑流
   */
  async regenerate(
    sessionId: number,
    messageId?: number,
    sender?: WebContents,
  ): Promise<void> {
    if (this.aborts.has(sessionId)) {
      throw new Error("CONCURRENT_REQUEST");
    }
    const abort = new AbortController();
    this.aborts.set(sessionId, abort);
    try {
      const session = await this.sessions.getSession(sessionId);
      if (!session) {
        throw new Error("SESSION_NOT_FOUND");
      }
      const rows = await prisma.message.findMany({
        where: { sessionId },
        orderBy: { createdAt: "asc" },
      });
      let targetIdx = -1;
      if (messageId !== undefined) {
        targetIdx = rows.findIndex(
          (row) => row.id === messageId && row.role === "assistant",
        );
        if (targetIdx === -1) {
          throw new Error("MESSAGE_NOT_FOUND");
        }
      } else {
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i].role === "assistant") {
            targetIdx = i;
            break;
          }
        }
      }
      if (targetIdx === -1) {
        throw new Error("NOTHING_TO_REGENERATE");
      }
      let lastUserIdx = -1;
      for (let i = targetIdx - 1; i >= 0; i--) {
        if (rows[i].role === "user") {
          lastUserIdx = i;
          break;
        }
      }
      if (lastUserIdx === -1) {
        throw new Error("NOTHING_TO_REGENERATE");
      }
      await this.truncateAfterAndStream(
        sessionId,
        rows,
        lastUserIdx,
        session.compactedUpToId,
        abort,
        sender,
      );
    } catch (error) {
      this.aborts.delete(sessionId);
      throw error;
    }
  }

  /**
   * 编辑重发:目标 user 消息就地改写为新内容(保留原时间戳)→ 删除其后全部
   * (原回答等内容被覆盖)→ 重跑流
   */
  async editAndResend(
    sessionId: number,
    messageId: number,
    content: string,
    sender?: WebContents,
  ): Promise<void> {
    // 并发检查必须是首条语句；AbortController 在首个 await 前注册，消除 TOCTOU 窗口
    if (this.aborts.has(sessionId)) {
      throw new Error("CONCURRENT_REQUEST");
    }
    const abort = new AbortController();
    this.aborts.set(sessionId, abort);
    try {
      const session = await this.sessions.getSession(sessionId);
      if (!session) {
        throw new Error("SESSION_NOT_FOUND");
      }
      const rows = await prisma.message.findMany({
        where: { sessionId },
        orderBy: { createdAt: "asc" },
      });
      const targetIdx = rows.findIndex(
        (row) => row.id === messageId && row.role === "user",
      );
      if (targetIdx === -1) {
        throw new Error("MESSAGE_NOT_FOUND");
      }
      await prisma.message.update({
        where: { id: messageId },
        data: { blocks: serializeBlocks([{ type: "text", text: content }]) },
      });
      await this.truncateAfterAndStream(
        sessionId,
        rows,
        targetIdx,
        session.compactedUpToId,
        abort,
        sender,
      );
    } catch (error) {
      // 早期失败同样清理注册(与 send 一致)；streamAndPersist 的 finally
      // 已清理时此处为幂等空操作
      this.aborts.delete(sessionId);
      throw error;
    }
  }

  /**
   * 截断重跑(regenerate 与 editAndResend 共用):删除保留边界(含)之后全部
   * 消息 → 压缩点失效清理 → 重启流(AbortController 由调用方在首个 await
   * 前注册并传入)
   */
  private async truncateAfterAndStream(
    sessionId: number,
    rows: ChatMessageRow[],
    keepUpToIndex: number,
    compactedUpToId: number | null,
    abort: AbortController,
    sender?: WebContents,
  ): Promise<void> {
    const tailIds = rows.slice(keepUpToIndex + 1).map((row) => row.id);
    if (tailIds.length > 0) {
      await prisma.message.deleteMany({ where: { id: { in: tailIds } } });
    }
    // 压缩点消息被删(压缩点位于被删尾部)→ 摘要随之失效:
    // 不清会让 history 过滤掉压缩点之前的全部消息 → 空上下文
    if (compactedUpToId != null && tailIds.includes(compactedUpToId)) {
      await this.sessions.updateSummary(sessionId, null, null);
    }
    await this.streamAndPersist(sessionId, abort, sender);
  }

  /**
   * agent 上下文装配（P2）：所有会话都具备——read_skill 与 mcp__ 工具不依赖
   * 工作空间（spec 决策 #3 常驻注入），mcp__ 写类审批也始终可用（决策 #1）。
   * workspacePath 仅在绑定目录后有值；fullAccess 实时查 PermissionStore
   * （P3 两级审批：workspace.writeApprovedAt 读取路径已废弃，spec R2）。
   * P4 反馈 2：isToolAllowed 查 toolPermission 表（工作空间级 allowed-tools）
   * SP1 安全中心：onSecurityEvent/onApprovalResolved 桥接 auditSink 审计出口
   */
  private async resolveAgentOptions(
    session: { workspaceId: number; projectId?: number | null },
    sessionId: number,
  ): Promise<AgentStreamOptions> {
    const workspace = session.workspaceId
      ? await this.sessions.getWorkspace(session.workspaceId)
      : null;
    const directoryPath = workspace?.directoryPath?.trim() || null;
    const workspaceId = workspace?.id ?? null;
    return {
      sessionId,
      workspacePath: directoryPath
        ? normalizeWorkspacePath(directoryPath)
        : undefined,
      projectId: session.projectId ?? null,
      fullAccess: () => this.permissions.get(sessionId) === "full",
      isToolAllowed: async (toolName: string) => {
        if (workspaceId === null) {
          return false;
        }
        const row = await prisma.toolPermission.findUnique({
          where: { workspaceId_toolName: { workspaceId, toolName } },
          select: { id: true },
        });
        return row !== null;
      },
      requestApproval: (toolCallId, argSummary) =>
        this.approvals.request(toolCallId, argSummary),
      // SP4 数据安全：闭包实时读配置（运行中改配置即生效）
      deleteProtection: this.dataSafety?.deleteProtection() ?? true,
      bulkDeleteThreshold:
        this.dataSafety?.bulkDeleteThreshold() ?? BULK_DELETE_THRESHOLD_DEFAULT,
      onBackupFile: this.dataSafety
        ? (absPath, sid) => this.dataSafety!.backupFile(absPath, sid)
        : undefined,
      // SP2 命令判定门：与 automation 共享模块单例（会话流不设 unattended）
      decideCommand: commandGate,
      // SP3 文件判定门：同命令门共享模块单例
      decideFileAccess: fileGate,
      onSecurityEvent: (event) => this.auditSink?.(event),
      onApprovalResolved: (toolName, decision, argSummary) => {
        // 决议词汇对齐审计侧：内部 denied 记 rejected（AuditDecision 与 UI i18n 词汇）
        const audited = decision === "approved" ? "approved" : "rejected";
        const category =
          toolName === "run_command" ? "command-safety" : "file-safety";
        this.auditSink?.({
          eventType: `${category}.${audited}`,
          decision: audited,
          detail: { tool: toolName, summary: argSummary },
          sessionId,
        });
      },
    };
  }

  /**
   * 注入工具集（P2 spec 决策 #3）：read_skill 常驻（未绑定目录也注入，与
   * system prompt 消费同一次 skills 扫描）；mcp__* 经 registry 透传——
   * 项目会话工具硬隔离（二期 §3.7）：allowedMcpServers 非 null 时仅保留
   * 挂载连接器前缀的工具（前缀 `mcp__<server>__` 精确到 server 边界），
   * 非 mcp 工具不受影响；null = 非项目/ask 会话，全量（plan_* 除外——
   * 项目专属工具，全局会话无计划上下文，子系统 F）；
   * create_skill 落盘到用户技能目录、不依赖工作空间，未绑定目录也放行（P-D）；
   * 文件四件依赖工作空间路径，仅绑定目录后注入
   */
  private collectToolDefinitions(
    agent: AgentStreamOptions,
    skills: SkillInfo[],
    allowedMcpServers: string[] | null = null,
  ): ToolDefinition[] {
    const registered = registry.getDefinitions();
    const workspaceScoped = agent.workspacePath
      ? registered
      : registered.filter(
          (def) => def.name.startsWith("mcp__") || def.name === "create_skill",
        );
    const injected = allowedMcpServers
      ? workspaceScoped.filter(
          (def) =>
            !def.name.startsWith("mcp__") ||
            allowedMcpServers.some((server) =>
              def.name.startsWith(`mcp__${server}__`),
            ),
        )
      : workspaceScoped.filter((def) => !def.name.startsWith("plan_"));
    return [makeReadSkillTool(skills), ...injected];
  }

  /**
   * 技能清单即时扫描（设计 spec §2）：每次 send 现算、无缓存——增删技能免重启生效；
   * 用户级目录始终加载，工作空间级仅在绑定目录时追加（数组序即优先级，同名用户级胜）
   */
  private collectSkills(workspaceDir?: string) {
    const dirs: Array<{ dir: string; source: "user" | "workspace" }> = [
      { dir: path.join(app.getPath("userData"), "skills"), source: "user" },
    ];
    if (workspaceDir) {
      dirs.push({
        dir: path.join(workspaceDir, ".tianshu", "skills"),
        source: "workspace",
      });
    }
    return loadSkills(dirs);
  }

  /**
   * 禁用即时生效（P-A spec §4.2）：user 级按 DB 启用态过滤（禁用对模型=
   * 不存在）；repo 缺席（测试）时不过滤，行为与 P2 一致
   */
  private async collectEnabledSkills(workspaceDir?: string) {
    const all = this.collectSkills(workspaceDir);
    if (!this.skillRepo) {
      return all;
    }
    const disabled = await this.skillRepo.getDisabledNames();
    return filterDisabledSkills(all, disabled);
  }

  /**
   * 通用编排：解析模型/助手 → 合并参数 → 截断历史 → agent 流式执行 → 持久化
   * （AbortController 由调用方在首个 await 前注册并传入，此处负责 finally 清理）
   */
  private async streamAndPersist(
    sessionId: number,
    abort: AbortController,
    sender?: WebContents,
    overrides?: ChatModelParams,
    maxSteps: number = DEFAULT_MAX_STEPS,
  ): Promise<void> {
    const startedAt = Date.now();
    const ctx = await this.assembleContext(sessionId, overrides);
    try {
      const result = await runChatStream({
        model: createLanguageModel(
          {
            type: ctx.providerRow.type,
            baseUrl: ctx.providerRow.baseUrl,
            apiKey: ctx.providerRow.apiKey ?? undefined,
            extraHeaders: ctx.providerRow.extraHeaders,
          },
          ctx.modelRow.modelId,
        ),
        system: ctx.systemWithSummary,
        history: ctx.history,
        contextWindow: ctx.modelRow.contextWindow ?? undefined,
        params: ctx.merged,
        abortSignal: abort.signal,
        toolDefinitions:
          ctx.mode === "ask"
            ? []
            : this.collectToolDefinitions(
                ctx.agent,
                ctx.skills,
                ctx.allowedMcpServers,
              ),
        agent: ctx.agent,
        maxSteps,
        onChunk: (chunk) => {
          // 先累积主进程快照（供切回会话恢复），再照常推送渲染层；
          // 流收尾（finally 清理后）到达的迟到工具事件只转发不落快照
          if (this.aborts.has(sessionId)) {
            this.accumulateSnapshot(sessionId, chunk);
          }
          this.emit(sender, sessionId, chunk);
        },
      });

      // 持久化 assistant 消息（中断也保留已生成部分）
      if (result.blocks.length > 0 || result.errorCode) {
        await this.sessions.appendMessage({
          sessionId,
          role: "assistant",
          blocks: serializeBlocks(result.blocks),
          modelId: ctx.modelId,
          assistantId: ctx.session.assistantId ?? undefined,
          error: result.errorMessage,
          durationMs: Date.now() - startedAt,
        } satisfies AppendMessageParams);
      }
      if (result.errorCode) {
        this.emit(sender, sessionId, {
          type: "error",
          errorCode: result.errorCode,
          message: result.errorMessage ?? "",
        });
      } else {
        this.emit(sender, sessionId, { type: "finish" });
        // 首轮问答完成 → AI 起标题（不阻塞、失败静默，spec §6）
        void this.generateTitleIfFirstExchange(sessionId, sender, {
          type: ctx.providerRow.type,
          baseUrl: ctx.providerRow.baseUrl,
          apiKey: ctx.providerRow.apiKey ?? undefined,
          extraHeaders: ctx.providerRow.extraHeaders,
          modelId: ctx.modelRow.modelId,
        });
      }
    } finally {
      this.aborts.delete(sessionId);
      this.snapshots.delete(sessionId);
      // 中断/收尾：作废全部未决审批（resolve false），释放挂起的 execute（spec 决策 #5）
      this.approvals.voidAll();
    }
  }

  /**
   * 上下文组装（send 与用量拆解共用）：会话/模型/助手 → 参数合并 →
   * 压缩态过滤历史 → agent/模式/技能 → system（含压缩摘要）
   */
  private async assembleContext(
    sessionId: number,
    overrides?: ChatModelParams,
  ) {
    const session = await this.sessions.getSession(sessionId);
    if (!session) {
      throw new Error("SESSION_NOT_FOUND");
    }
    const modelId = await this.sessions.getEffectiveModelId(sessionId);
    if (!modelId) {
      throw new Error("NO_MODEL");
    }
    const modelRow = await prisma.model.findUnique({ where: { id: modelId } });
    const providerRow = modelRow
      ? await prisma.provider.findUnique({
          where: { id: modelRow.providerId },
        })
      : null;
    if (!modelRow || !providerRow) {
      throw new Error("MODEL_OR_PROVIDER_MISSING");
    }
    const assistantRow: AssistantRow | null = session.assistantId
      ? await prisma.assistant.findUnique({
          where: { id: session.assistantId },
        })
      : null;

    const merged = mergeParams([
      {
        temperature: modelRow.temperature ?? undefined,
        topP: modelRow.topP ?? undefined,
        maxTokens: modelRow.maxTokens ?? undefined,
      },
      {
        temperature: assistantRow?.temperature ?? undefined,
        topP: assistantRow?.topP ?? undefined,
        maxTokens: assistantRow?.maxTokens ?? undefined,
      },
      overrides,
    ]);

    // /compact 压缩态:历史只取压缩点之后(摘要经 system 注入替代旧消息)
    // 宽松判空:旧会话/测试 stub 字段可能为 undefined,均视为未压缩
    const compacted =
      session.compactedUpToId != null && session.summary != null;
    const history = (
      await prisma.message.findMany({
        where: { sessionId },
        orderBy: { createdAt: "asc" },
      })
    )
      .filter(
        (row) =>
          row.role !== "system" &&
          !row.error &&
          (!compacted || row.id > (session.compactedUpToId ?? 0)),
      )
      .map((row) => ({
        role: row.role as "user" | "assistant",
        blocks: row.blocks,
      }));

    const agent = await this.resolveAgentOptions(session, sessionId);
    // P3 模式组装（spec R5）：DB null/未识别值归一 agent；ask 零工具零技能
    // （扫描整个跳过：技能清单与 read_skill 均不注入），plan 仅追加指令段
    const mode: "agent" | "ask" | "plan" =
      session.mode === "ask" || session.mode === "plan"
        ? session.mode
        : "agent";
    const skills =
      mode === "ask"
        ? []
        : await this.collectEnabledSkills(agent.workspacePath);
    // 压缩态摘要段:拼在模式 system 之后(无 base 时单独成段)
    // 个性化段注入（spec §4.5）：persona 前置 + 行为段后置，全默认时逐字节还原
    // 项目会话（项目模块一期 spec §5）：base 换为项目上下文（项目指令+挂载专家
    // prompt+能力软约束声明）；非项目会话或项目上下文为空 → 原助手 prompt 不变。
    // 工具硬隔离（二期 §3.7）：ask 外的项目会话，技能清单按挂载集过滤、
    // mcp 工具按挂载连接器前缀过滤（声明段同步收窄到实际可用集）
    const projectCtx = session.projectId
      ? await this.projectRepo?.getPromptContext(session.projectId)
      : null;
    const isolation =
      projectCtx && mode !== "ask"
        ? isolateProjectTools(skills, projectCtx)
        : null;
    const sessionSkills = isolation ? isolation.skills : skills;
    const allowedMcpServers = isolation?.allowedMcpServers ?? null;
    const baseProjectCtx = isolation ? isolation.declaredCtx : projectCtx;
    const base = baseProjectCtx
      ? (buildProjectSystemBase(baseProjectCtx) ?? assistantRow?.systemPrompt)
      : assistantRow?.systemPrompt;
    const personalization = await loadPersonalization();
    const baseSystem = buildPersonalizedSystem(
      personalization,
      buildModeSystem(mode, base, sessionSkills),
    );
    const systemWithSummary =
      compacted && session.summary
        ? `${baseSystem ? `${baseSystem}\n\n` : ""}【此前对话摘要】\n${session.summary}`
        : baseSystem;
    return {
      session,
      modelId,
      modelRow,
      providerRow,
      assistantRow,
      merged,
      compacted,
      history,
      agent,
      mode,
      skills: sessionSkills,
      allowedMcpServers,
      baseSystem,
      systemWithSummary,
    };
  }

  /**
   * 上下文用量拆解（chat:usage）：与下次请求同口径组装并按五类估算
   * token 占比；会话缺失/未配模型返回 null（前端灰态）
   */
  async getUsageBreakdown(
    sessionId: number,
  ): Promise<ContextUsageBreakdown | null> {
    try {
      const ctx = await this.assembleContext(sessionId);
      const toolDefinitions =
        ctx.mode === "ask"
          ? []
          : this.collectToolDefinitions(
              ctx.agent,
              ctx.skills,
              ctx.allowedMcpServers,
            );
      return computeUsageBreakdown({
        systemWithSummary: ctx.systemWithSummary,
        skills: ctx.skills,
        toolDefinitions,
        history: ctx.history,
        contextWindow: ctx.modelRow.contextWindow ?? null,
        params: ctx.merged,
      });
    } catch {
      return null;
    }
  }

  /** chunk 累积进主进程快照（text/thinking 追加，工具事件保序合入） */
  private accumulateSnapshot(sessionId: number, chunk: ChatStreamChunk): void {
    const snap = this.snapshots.get(sessionId) ?? emptySnapshot();
    if (chunk.type === "text-delta") {
      snap.text += chunk.text;
    } else if (chunk.type === "reasoning-delta") {
      snap.thinking += chunk.text;
    } else if (
      chunk.type === "tool-update" ||
      chunk.type === "approval-request"
    ) {
      this.applyToolChunk(snap, chunk);
    }
    this.snapshots.set(sessionId, snap);
  }

  /** 工具 chunk 合入快照：新 toolCallId 追加 order，浅合并状态字段 */
  private applyToolChunk(snap: StreamSnapshot, chunk: ToolStreamChunk): void {
    const existing = snap.tools.map[chunk.toolCallId];
    if (!existing) {
      snap.tools.order.push(chunk.toolCallId);
    }
    const state = existing ?? { toolName: chunk.toolName, state: "" };
    state.toolName = chunk.toolName;
    if (chunk.type === "tool-update") {
      state.state = chunk.state;
      if (chunk.args !== undefined) {
        state.args = chunk.args;
      }
      if (chunk.output !== undefined) {
        state.output = chunk.output;
      }
    } else {
      state.argSummary = chunk.argSummary;
    }
    snap.tools.map[chunk.toolCallId] = state;
  }

  /**
   * 查询会话流状态（切回会话时恢复 UI 用，spec §4；P1 增含 tools 态，
   * P3 增含 accessMode 供权限胶囊恢复）
   */
  status(sessionId: number): ChatStatusResult {
    const snap = this.snapshots.get(sessionId);
    return {
      streaming: this.aborts.has(sessionId),
      accessMode: this.permissions.get(sessionId),
      text: snap?.text ?? "",
      thinking: snap?.thinking ?? "",
      tools: snap?.tools ?? { order: [], map: {} },
    };
  }

  /**
   * 标题模型调用（独立可注入点，测试覆写；默认真实调用当前会话模型）
   */
  async titleModelText(ctx: {
    type: string;
    baseUrl: string;
    apiKey?: string;
    extraHeaders?: string | null;
    modelId: string;
    userText: string;
    assistantText: string;
  }): Promise<string> {
    const result = await generateText({
      model: createLanguageModel(ctx, ctx.modelId),
      system:
        "你是对话标题生成器。为以下对话生成一个不超过 12 字的中文标题，只输出标题本身。",
      prompt: `用户：${ctx.userText}\n助手：${ctx.assistantText}`,
      maxOutputTokens: 30,
    });
    return result.text;
  }

  /**
   * 首轮问答完成后 AI 起标题（fire-and-forget；失败静默降级仅记日志，spec §6）
   */
  private async generateTitleIfFirstExchange(
    sessionId: number,
    sender: WebContents | undefined,
    ctx: {
      type: string;
      baseUrl: string;
      apiKey?: string;
      extraHeaders?: string | null;
      modelId: string;
    },
  ): Promise<void> {
    try {
      const rows = (await prisma.message.findMany({
        where: { sessionId },
        orderBy: { createdAt: "asc" },
      })) as Array<{ role: string; blocks: string; error: string | null }>;
      const visible = rows.filter((row) => row.role !== "system" && !row.error);
      if (visible.length !== 2) {
        return;
      }
      const session = await this.sessions.getSession(sessionId);
      if (!session) {
        return;
      }
      const truncate = (blocksJson: string) => {
        const text = parseBlocks(blocksJson)
          .filter((block) => block.type === "text")
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("\n");
        return text.slice(0, 200);
      };
      // P0 的 autotitleIfDefault 在流式开始前已把默认标题改写为首条消息前 20 字，
      // 故两个哨兵态（默认标题 / autotitle 截断态）都视为未命名；手动改名两者皆不匹配 → 保护
      const firstUserTitle = truncate(visible[0].blocks).slice(0, 20);
      if (session.title !== "新会话" && session.title !== firstUserTitle) {
        return;
      }
      const title = (
        await this.titleModelText({
          ...ctx,
          userText: truncate(visible[0].blocks),
          assistantText: truncate(visible[1].blocks),
        })
      )
        .trim()
        .slice(0, 20);
      if (!title) {
        return;
      }
      await this.sessions.renameSession(sessionId, title);
      this.emit(sender, sessionId, { type: "title-updated", title });
    } catch (e) {
      // 标题失败静默降级（对用户无感知）：仅记录日志保留可观测性
      Log.warn("AI 标题生成失败", e instanceof Error ? e.message : e);
    }
  }

  stop(sessionId: number): void {
    this.aborts.get(sessionId)?.abort();
  }
}

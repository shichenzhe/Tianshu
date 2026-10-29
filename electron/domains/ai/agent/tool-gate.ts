/** 工具调用安全门（自 chat.service 抽出解环，见 2026-10-15 spec §4.2）：
 * 命令门/文件门/批量删除预估/审批/审计全链收口，chat 与 orchestration
 * （经 langchain-tool-adapter）共用。语义与抽出前逐行为等价。 */
import type { ToolDefinition } from "./file-tools";
import { resolveSafePath } from "./file-tools";
// ChatStreamChunk 实际定义在 src-react chat.api（chunk 协议类型，叶模块），
// 与抽出前 chat.service 同源 import，不构成环
import type { ChatStreamChunk } from "../../../../src-react/domains/ai/api/chat.api";
import type { ToolCallBlock } from "../chat/blocks";
import fs from "node:fs/promises";
import Log from "../../../commons/Log";
import type { SecurityEventSink } from "../../../../src-react/domains/security/model/types";
import {
  commandGate,
  commandWatchBlacklist,
  type CommandDecision,
} from "../../security/command-gate";
import {
  assessCommandRisk,
  type CommandRisk,
} from "../../security/command-risk";
import { fileGate } from "../../security/file-gate";
import type { FileAccessDecision } from "../../security/file-policy";
import { countFilesForEstimate } from "../../security/file-history";
import type { BackupFileResult } from "../../security/file-history";

/** write 工具被用户拒绝时的回喂文案（spec 决策 #4：拒绝后循环继续） */
const TOOL_DENIED_OUTPUT = "用户拒绝了此操作";

/** 工具执行被中止时的回喂文案 */
const TOOL_ABORTED_OUTPUT = "已中断";

/** 工具输出 chunk / 落库截断上限，防止超长输出撑爆渲染层与 DB */
const TOOL_OUTPUT_SLICE = 2000;

/**
 * agent 上下文（P1）：工具执行与审批所需的最小注入集，
 * 由 ChatService 装配（prisma / ApprovalCoordinator），runChatStream 保持纯函数可测
 */
export interface AgentStreamOptions {
  /** 图执行无会话传 null（2026-10-28 去会话化） */
  sessionId: number | null;
  /**
   * 会话归属用户 id（专家 2.0）：透传工具 ctx，供 create/update_expert
   * 等按用户隔离落库的工具消费
   */
  userId?: number;
  /**
   * 会话绑定工作空间 id（create_schedule 落库依据）：透传工具
   * ctx；未绑定目录的会话为 undefined
   */
  workspaceId?: number;
  /**
   * 会话当前模型 id（create_schedule 任务执行模型依据）：
   * 透传工具 ctx；未选模型为 undefined
   */
  modelId?: number;
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
  /** 安全事件上报（SP1）：透传给工具 ctx（bash 拦截/cwd 回退） */
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
  /** 批量删除阈值（SP4 数据安全）：rm 目录预估 ≥ 阈值强制审批；缺省 50 */
  bulkDeleteThreshold?: number;
  /** 删除保护（SP4 数据安全）：透传 rm（true=回收站）；缺省 true */
  deleteProtection?: boolean;
  /** 备份回调（SP4 数据安全）：write 覆盖前 / rm 永久删除前；缺省不备份 */
  onBackupFile?: (
    absPath: string,
    sessionId: number | null,
  ) => Promise<BackupFileResult>;
  /** 写盘后通知（文件窗口联动，spec §6.4）：write 落盘后回调；缺省不广播 */
  onFileWritten?: (absPath: string) => void;
  /**
   * 会话级路径授权清单（文件窗口 spec §6.4）：闭包实时读内存缓存
   * （grant/revoke IPC 原地更新）——resolveFileGate/resolveBulkDelete 与
   * 工具 ctx 消费；缺席（非文件窗口会话/测试）无清单，越界照旧拒绝
   */
  grantedPaths?: () => string[];
  /** 无人值守流（automation，SP2）：ask 命中强制拒绝而非挂起审批 */
  unattended?: boolean;
  /** 监控埋点（token/工具监控 spec §4.1 #3）：终态工具事件回调；
   *  缺席（单测）不采集；durationMs 仅执行路径有（denied 无计时） */
  toolStats?: (event: {
    toolName: string;
    state: "done" | "denied" | "error";
    durationMs?: number;
  }) => void;
  /** 面板联动（web 工具 browse）：sender 销毁安全；sessionId 由装配闭包补进 payload */
  emitPanel?: (
    event: "detailPanel:openBrowser",
    payload: { url: string },
  ) => void;
}

/** 审批横幅直显的参数摘要：bash 取命令前 60 字符（spec §6），
 * 其余优先路径，否则 JSON 截断 */
function summarizeArgs(toolName: string, input: unknown): string {
  const record = (
    typeof input === "object" && input !== null ? input : {}
  ) as Record<string, unknown>;
  if (
    toolName === "bash" &&
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
      // fullAccess 供文件四件边界放开与 bash cwd 放开（P3 spec §6）；
      // projectId 供 plan_* 工具属地校验（子系统 F，非项目会话 null）；
      // onSecurityEvent 供 bash 拦截/cwd 回退上报（SP1 审计）；
      // userId 供 create/update_expert 按用户隔离落库（专家 2.0）；
      // workspaceId/modelId 供 create_schedule 落库（防模型幻觉填参）
      {
        workspacePath: agent.workspacePath ?? "",
        sessionId: agent.sessionId,
        userId: agent.userId,
        workspaceId: agent.workspaceId,
        modelId: agent.modelId,
        fullAccess: agent.fullAccess(),
        projectId: agent.projectId ?? null,
        onSecurityEvent: agent.onSecurityEvent,
        // SP2 子进程黑名单（会话与 automation 统一监控；win32 在 child-monitor 内 no-op）
        commandWatchBlacklist: commandWatchBlacklist(),
        // SP4 数据安全：删除保护与备份回调（装配快照，每流一次）
        deleteProtection: agent.deleteProtection,
        onBackupFile: agent.onBackupFile,
        // 文件窗口联动（spec §6.4）：write 写盘后广播 fileChanged
        onFileWritten: agent.onFileWritten,
        // 会话级路径授权清单（spec §6.4）：read/list 越界放行；write 已
        // 免审直执行（权限放宽 spec §4.4），delete 审批横幅仍走（闭包实时
        // 读，未授权会话 undefined=无清单）
        grantedPaths: agent.grantedPaths?.(),
        // 面板联动（web 工具 browse）：executeToolSafe 透传装配闭包
        emitPanel: agent.emitPanel,
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

export const COMMAND_BLOCKED_OUTPUT =
  "错误: 该命令被命令安全策略禁止（程序黑名单）";
export const COMMAND_UNATTENDED_OUTPUT =
  "错误: 无人值守任务不可执行询问名单命令，请从询问名单移除或改为人工会话执行";

/** bash 判定门：非 bash 或无命令返回 null */
function resolveCommandGate(
  agent: AgentStreamOptions,
  toolName: string,
  input: unknown,
): CommandDecision | null {
  if (toolName !== "bash") return null;
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
  "read",
  "write",
  "ls",
  "rm",
]);

/** 批量删除 unattended 强拒文案（SP4） */
const BULK_UNATTENDED_OUTPUT =
  "错误: 无人值守任务不可执行批量删除，请调整安全中心阈值或改为人工会话执行";
/** 批量删除阈值缺省（SP4）：与安全中心默认配置一致（bulkDeleteThreshold）；
 * chat.service 装配侧（dataSafety 缺席回落）共用同一缺省 */
export const BULK_DELETE_THRESHOLD_DEFAULT = 50;

/** 批量删除预估（SP4）：rm 且目录预估 ≥ 阈值 → 估值；不涉及返回 null */
async function resolveBulkDelete(
  agent: AgentStreamOptions,
  toolName: string,
  input: unknown,
): Promise<number | null> {
  if (toolName !== "rm" || !agent.workspacePath) return null;
  const rel = (input as { path?: unknown } | null)?.path;
  if (typeof rel !== "string" || rel === "") return null;
  try {
    const abs = resolveSafePath(
      agent.workspacePath,
      rel,
      agent.fullAccess(),
      agent.grantedPaths?.(),
    );
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat?.isDirectory()) return null;
    const threshold =
      agent.bulkDeleteThreshold ?? BULK_DELETE_THRESHOLD_DEFAULT;
    const count = await countFilesForEstimate(abs);
    return count >= threshold ? count : null;
  } catch (e) {
    Log.error(`批量删除预估失败 toolName=${toolName} path=${rel}`, e);
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
    const abs = resolveSafePath(
      agent.workspacePath,
      rel,
      agent.fullAccess(),
      agent.grantedPaths?.(),
    );
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
 * DB 写低风险免审集（权限放宽 spec §4.4）：落库无文件系统风险；
 * read 类工具本就不审批，此处只列 kind=write 的业务工具
 */
const AUTO_EXEMPT_WRITE_TOOLS = new Set([
  // plan 组坍缩二件（2026-10-29 改名批次；老名历史调用经别名归一
  // 落到新名后同享免审）
  "todo_write",
  "create_skill",
  "create_expert",
  "update_expert",
]);

/**
 * 网络域工具集（免审面，2026-10-24 裁定——无单独授权必要，任何档位均
 * 直执行）：web 双工具 + browser 四件 + mcp__ 连接器前缀（注入本就来自
 * enabled server——「已启用的连接器」语义天然成立）
 */
const NETWORK_TOOL_NAMES = new Set([
  "fetch",
  "browse",
  "browser_snapshot",
  "browser_navigate",
  "browser_click",
  "browser_type",
]);

const MCP_TOOL_PREFIX = "mcp__";

function isNetworkTool(toolName: string): boolean {
  return (
    NETWORK_TOOL_NAMES.has(toolName) || toolName.startsWith(MCP_TOOL_PREFIX)
  );
}

/** bash 危险分级判定（spec §4.1/§4.5）：非 bash/无命令返回 null */
function resolveCommandRisk(toolName: string, input: unknown): CommandRisk {
  if (toolName !== "bash") return null;
  const command = (input as { command?: unknown } | null)?.command;
  if (typeof command !== "string" || command === "") return null;
  return assessCommandRisk(command);
}

/**
 * 工具调用全流程（包装注册表工具的 execute，供单测导出）：
 * 命令判定门（SP2）：bash 先经 gate——block 拒 / ask 审批
 * （unattended 强拒；full 豁免）/ allow 跳审批 / default 回落既有链路；
 * 危险分级线（权限放宽 2026-10-24 spec §4.5）：HIGH/CRITICAL 危险命令
 * default/full 两档均审批（对齐 WorkBuddy bypass），unattended 强拒；
 * 文件判定门（SP3，SP4 增 rm）：文件四件先经 gate——block 审批
 * （unattended 强拒；full 豁免）/ allow 跳审批 / default 回落既有链路（与命令门互斥，default 时链路不变）；
 * 批量删除预估门（SP4）：rm 目录预估 ≥ 阈值 → 无条件强制审批
 * （unattended 强拒；full 豁免——2026-10-23 三档递进裁定推翻 SP4 旧不豁免
 * 裁定，回收站/备份保护不依赖审批照常兜底）；
 * write 审批判定（P4 反馈）——完全访问直执行（含 MCP）；
 * 工作空间已记忆（toolPermission 表，参照 Claude Code allowed-tools）直执行；
 * 权限放宽（2026-10-24 spec §4.4）：default 档审批面收窄为「高危询问」——
 * 普通命令（bash 兜底移除）/write 工作空间内/DB 写
 * （AUTO_EXEMPT_WRITE_TOOLS）直执行，其余 write 未记忆挂起审批；
 * full 档=用户显式免责+内置硬线（程序黑名单/危险分级），其余询问全豁免；
 * 拒绝以文案回喂（循环继续）；中止竞速防流悬挂
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
    // 监控埋点（spec §4.1 #3）：安全门拒绝也是终态，与审批拒绝同口径计 denied
    agent.toolStats?.({ toolName: def.name, state: "denied" });
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
  // 危险分级（2026-10-24 权限放宽 spec §4.5）：HIGH/CRITICAL 两档均审批
  // （full 亦不豁免，对齐 WorkBuddy bypass "requires confirmation every
  // time"）；unattended 强拒（与 cmdAsk 强拒同语义）
  const commandRisk = resolveCommandRisk(def.name, input);
  if (commandRisk && agent.unattended) {
    finalStates?.set(toolCallId, "denied");
    agent.toolStats?.({ toolName: def.name, state: "denied" });
    onChunk?.({
      type: "tool-update",
      toolCallId,
      toolName: def.name,
      state: "denied",
      output: COMMAND_UNATTENDED_OUTPUT,
    });
    emitCommandEvent(agent, input, "command-safety.rejected", "rejected", {
      reason: "unattended",
      risk: commandRisk,
    });
    return COMMAND_UNATTENDED_OUTPUT;
  }
  if (commandRisk) {
    emitCommandEvent(agent, input, "command-safety.needs-approval", "info", {
      source: "risk-table",
      risk: commandRisk,
    });
  }
  if (gate === "ask" && agent.unattended) {
    finalStates?.set(toolCallId, "denied");
    agent.toolStats?.({ toolName: def.name, state: "denied" });
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
    agent.toolStats?.({ toolName: def.name, state: "denied" });
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
    agent.toolStats?.({ toolName: def.name, state: "denied" });
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
  // write 直执行时的决策留痕（spec §4.7；full 档全放行不发——语义噪音）
  const writeAutoAllowed =
    !agent.fullAccess() &&
    def.name === "write" &&
    fileGateDecision !== "block" &&
    gate === null;
  if (writeAutoAllowed) {
    emitFileEvent(agent, input, "file-safety.auto-allowed", "info", {
      reason: "workspace-write",
    });
  }
  // write 兜底收窄（权限放宽 spec §4.4）：普通命令/write/DB 写免审，
  // 只剩其余 write（mcp__ 写类等）的记忆或审批；展开为独立布尔值避免
  // 深嵌套括号（brief 原稿末层括号失衡，语义不变）
  const writeFallbackNeedsApproval =
    gate !== "allow" &&
    fileGateDecision !== "allow" &&
    def.kind === "write" &&
    // 网络域免审（2026-10-24 裁定重落）：任何档位直执行
    !isNetworkTool(def.name) &&
    // DB 写低风险免审（spec §4.4）
    !AUTO_EXEMPT_WRITE_TOOLS.has(def.name) &&
    // write 工作空间内免审（spec §4.4）：审批面只剩文件门 block
    def.name !== "write" &&
    // bash 兜底审批移除（spec §4.4）：危险面已由分级表前置
    // 捕获，gate 为 allow/default 直执行——审批面只剩 ask 源
    def.name !== "bash" &&
    !(await agent.isToolAllowed(def.name));
  const needsApproval =
    // 危险分级（spec §4.5）：先于 fullAccess 短路——full 也审
    commandRisk !== null ||
    // full（bypass，2026-10-23 三档递进裁定）：一切询问消失——程序黑名单
    // 与危险分级硬拒/审批已前置，此处只剩询问面；推翻 SP4「批量删除
    // fullAccess 不豁免」旧裁定：回收站/备份保护不依赖审批照常生效
    (!agent.fullAccess() &&
      (bulkEstimate !== null ||
        gate === "ask" ||
        fileGateDecision === "block" ||
        writeFallbackNeedsApproval));
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
      agent.toolStats?.({ toolName: def.name, state: "denied" });
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
  // 监控埋点（spec §4.1 #3）：执行路径计时起点（denied 无执行不计时长）
  const toolStartedAt = Date.now();
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
  // 监控埋点（spec §4.1 #3）：终态计时上报（中止提前返回处不计，spec §4.2）
  agent.toolStats?.({
    toolName: def.name,
    state: output.startsWith("错误:") ? "error" : "done",
    durationMs: Date.now() - toolStartedAt,
  });
  return output;
}

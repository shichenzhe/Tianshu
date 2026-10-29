/**
 * 工具调用安全门（自 mirror electron/domains/ai/agent/tool-gate.ts 移植）：
 * 命令门/文件门/批量删除预估/审批/审计全链收口，runChatStream 与
 * langchain-tool-adapter 共用，绝不直调 def.execute。
 * 无头端偏离（spec §12 偏离 2）：mirror 的 unattended 强拒语义扩展为
 * allowDangerousTools 配置门（config.yml tianshu.chat.allowDangerousTools，
 * 缺省 false）——false 时 bash 整体直接拒绝、批量删除预估达阈值
 * 直接拒绝（denied 终态 + 拒绝 chunk 回喂，不挂起审批）；true 时回到
 * mirror 原判定链。
 * T7 审批裁定：一期协议无 approve 端点、无应答方——agent.autoDenyApprovals
 * （config tianshu.chat.accessMode=default 装配）时需审批操作不挂起等待，
 * 直接以配置放行提示文案拒绝；审批挂起链（approval-request → respond）
 * 保留给二期 approve 端点/auto-approve 模式。
 */
import type { ToolDefinition } from './tool-definition';
import type { BackupFileResult } from './tool-definition';
import { resolveSafePath } from './file-tools';
import { BRIDGE_TOOL_NAMES } from './bridge/browser-bridge-tools';
import type { ChatStreamChunk, ToolCallBlock } from '@tianshu/protocol';
import fs from 'node:fs/promises';
import { countFilesForEstimate } from '../security/file-history-estimate';
import { commandGate, type CommandDecision } from '../security/command-gate';
import { assessCommandRisk, type CommandRisk } from '../security/command-risk';
import { fileGate } from '../security/file-gate';
import type { FileAccessDecision } from '../security/file-policy';
import type { SecurityEventSink } from './security-events';

/** write 工具被用户拒绝时的回喂文案（拒绝后循环继续） */
const TOOL_DENIED_OUTPUT = '用户拒绝了此操作';

/** 工具执行被中止时的回喂文案 */
const TOOL_ABORTED_OUTPUT = '已中断';

/** 工具输出 chunk / 落库截断上限，防止超长输出撑爆协议与 DB */
const TOOL_OUTPUT_SLICE = 2000;

/**
 * agent 上下文：工具执行与审批所需的最小注入集，由 ChatRunnerService
 * 装配，runChatStream 保持纯函数可测
 */
export interface AgentStreamOptions {
  /** 图执行无会话传 null（2026-10-28 去会话化） */
  sessionId: number | null;
  /** 会话归属用户 id：透传工具 ctx，供按用户隔离落库的工具消费 */
  userId?: number;
  /** 会话绑定工作空间 id：透传工具 ctx；未绑定目录的会话为 undefined */
  workspaceId?: number;
  /** 会话当前模型 id：透传工具 ctx；未选模型为 undefined */
  modelId?: number;
  /** 绑定目录的规范化绝对路径（无尾部分隔符）；未绑定目录时为 undefined——
   *  文件五件与 fetch 依赖它（不注入），read_skill/create_skill/
   *  bash 不依赖（常驻） */
  workspacePath?: string;
  /** 会话归属项目 id：plan_* 工具组的属地依据，非项目会话为 null */
  projectId?: number | null;
  /** 危险工具开关（spec §12 偏离 2）：false（缺省）时 bash 与
   *  批量删除直接拒绝；true 时走 mirror 原判定链 */
  allowDangerousTools?: boolean;
  /** 完全访问实时判定：每次 write 工具判定与执行前查询，撤回立即生效 */
  fullAccess: () => boolean;
  /** 工作空间级工具记忆：命中跳过审批直执行；每次 write 判定前查询。
   *  服务端未移植 toolPermission 表，装配恒 false（每 write 必审批） */
  isToolAllowed: (toolName: string) => Promise<boolean>;
  /** 挂起等待审批决议（relay 应答注入）；resolve false = 拒绝 */
  requestApproval: (toolCallId: string, argSummary: string) => Promise<boolean>;
  /** 无应答方裁定（T7）：true 时需审批操作不挂起，直接以
   *  APPROVAL_AUTO_DENIED_OUTPUT 拒绝（denied chunk 回喂，循环继续） */
  autoDenyApprovals?: boolean;
  /** 安全事件上报：透传给工具 ctx（bash 拦截/cwd 回退） */
  onSecurityEvent?: SecurityEventSink;
  /** 审批决议审计：approved/denied 由 runToolCall 决议分支回调 */
  onApprovalResolved?: (
    toolName: string,
    decision: 'approved' | 'denied',
    argSummary: string,
  ) => void;
  /** 命令安全判定门：缺省走 commandGate 模块单例 */
  decideCommand?: (command: string) => CommandDecision;
  /** 文件安全判定门：缺省走 fileGate 模块单例 */
  decideFileAccess?: (
    absPath: string,
    workspacePath: string,
  ) => FileAccessDecision;
  /** 批量删除阈值：rm 目录预估 ≥ 阈值强制审批；缺省 50 */
  bulkDeleteThreshold?: number;
  /** 删除保护：透传 rm（true=移入回收目录）；缺省 true */
  deleteProtection?: boolean;
  /** 回收目录根（服务端 trash 实现消费）；缺省 ~/.tianshu-server/trash */
  trashRoot?: string;
  /** 备份回调：write 覆盖前 / rm 永久删除前；缺省不备份 */
  onBackupFile?: (
    absPath: string,
    sessionId: number | null,
  ) => Promise<BackupFileResult>;
  /** 写盘后通知；缺省不广播 */
  onFileWritten?: (absPath: string) => void;
  /** 会话级路径授权清单：闭包实时读；缺席无清单，越界照旧拒绝 */
  grantedPaths?: () => string[];
  /** 监控埋点：终态工具事件回调；缺席（单测）不采集 */
  toolStats?: (event: {
    toolName: string;
    state: 'done' | 'denied' | 'error';
    durationMs?: number;
  }) => void;
}

/** 审批横幅直显的参数摘要：bash 取命令前 60 字符，
 *  其余优先路径，否则 JSON 截断 */
function summarizeArgs(toolName: string, input: unknown): string {
  const record = (
    typeof input === 'object' && input !== null ? input : {}
  ) as Record<string, unknown>;
  if (
    toolName === 'bash' &&
    typeof record.command === 'string' &&
    record.command
  ) {
    return `${toolName} → ${record.command.slice(0, 60)}`;
  }
  if (typeof record.path === 'string' && record.path) {
    return `${toolName} → ${record.path}`;
  }
  try {
    return JSON.stringify(input).slice(0, 100);
  } catch {
    return toolName;
  }
}

/**
 * promise 与中止信号竞速：流迭代会等待 execute settle，用户中止时
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
    const detach = () => abortSignal.removeEventListener('abort', onAbortEvent);
    const onAbortEvent = () => {
      detach();
      resolve(onAbort());
    };
    if (abortSignal.aborted) {
      onAbortEvent();
      return;
    }
    abortSignal.addEventListener('abort', onAbortEvent, { once: true });
    promise.then(
      (value) => {
        detach();
        resolve(value);
      },
      (error) => {
        detach();
        // 原样转发拒绝（eslint 要求 Error 形；非 Error 包一层保留信息）
        reject(error instanceof Error ? error : new Error(String(error)));
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
    type: 'tool-update',
    toolCallId,
    toolName: def.name,
    state: 'awaiting-approval',
  });
  onChunk?.({
    type: 'approval-request',
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
      {
        workspacePath: agent.workspacePath ?? '',
        sessionId: agent.sessionId,
        userId: agent.userId,
        workspaceId: agent.workspaceId,
        modelId: agent.modelId,
        fullAccess: agent.fullAccess(),
        projectId: agent.projectId ?? null,
        onSecurityEvent: agent.onSecurityEvent,
        deleteProtection: agent.deleteProtection,
        trashRoot: agent.trashRoot,
        onBackupFile: agent.onBackupFile,
        onFileWritten: agent.onFileWritten,
        grantedPaths: agent.grantedPaths?.(),
      },
      input,
    );
  } catch (e) {
    return `错误: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 审批决议类型：aborted 与用户拒绝区分（前者落 error 终态） */
type ApprovalDecision = 'approved' | 'denied' | 'aborted';

function toApprovalDecision(approved: boolean): ApprovalDecision {
  return approved ? 'approved' : 'denied';
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
    () => 'aborted',
  );
}

export const COMMAND_BLOCKED_OUTPUT =
  '错误: 该命令被命令安全策略禁止（程序黑名单）';

/** allowDangerousTools=false 时 bash 整体拒绝文案（本仓新增门） */
export const COMMAND_DISABLED_OUTPUT =
  '错误: 服务端未开启 allowDangerousTools（tianshu.chat.allowDangerousTools），bash 已禁用';

/** allowDangerousTools=false 时批量删除拒绝文案（本仓新增门） */
export const BULK_DELETE_DISABLED_OUTPUT =
  '错误: 服务端未开启 allowDangerousTools（tianshu.chat.allowDangerousTools），批量删除已禁用';

/** autoDenyApprovals=true 时审批自动拒绝文案（T7 无头裁定，提示 config 放行） */
export const APPROVAL_AUTO_DENIED_OUTPUT =
  '错误: 无头端默认拒绝需审批的操作（config.yml tianshu.chat.accessMode 设为 auto-approve 可放行）';

/** bash 判定门：非 bash 或无命令返回 null */
function resolveCommandGate(
  agent: AgentStreamOptions,
  toolName: string,
  input: unknown,
): CommandDecision | null {
  if (toolName !== 'bash') return null;
  const command = (input as { command?: unknown } | null)?.command;
  if (typeof command !== 'string' || command === '') return null;
  return (agent.decideCommand ?? commandGate)(command);
}

/** 命令判定门审计事件（detail 带 command 截断 + 附加字段） */
function emitCommandEvent(
  agent: AgentStreamOptions,
  input: unknown,
  eventType: string,
  decision: 'blocked' | 'rejected' | 'info' | 'allowed',
  extra: Record<string, unknown>,
): void {
  const rawCommand = (input as { command?: unknown } | null)?.command;
  const command = typeof rawCommand === 'string' ? rawCommand : '';
  agent.onSecurityEvent?.({
    eventType,
    decision,
    detail: { command: command.slice(0, 200), ...extra },
    sessionId: agent.sessionId,
  });
}

const FILE_GATE_TOOLS = new Set([
  'read',
  'write',
  'ls',
  'rm',
]);

/** 批量删除阈值缺省：与 mirror 安全中心默认配置一致 */
export const BULK_DELETE_THRESHOLD_DEFAULT = 50;

/** 批量删除预估：rm 且目录预估 ≥ 阈值 → 估值；不涉及返回 null */
async function resolveBulkDelete(
  agent: AgentStreamOptions,
  toolName: string,
  input: unknown,
): Promise<number | null> {
  if (toolName !== 'rm' || !agent.workspacePath) return null;
  const rel = (input as { path?: unknown } | null)?.path;
  if (typeof rel !== 'string' || rel === '') return null;
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
  } catch {
    // 预估失败不挡链路（fail-open，与 mirror 同口径）
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
  if (typeof rel !== 'string' || rel === '') return null;
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
  decision: 'rejected' | 'info' | 'allowed',
  extra: Record<string, unknown>,
): void {
  const rawPath = (input as { path?: unknown } | null)?.path;
  const p = typeof rawPath === 'string' ? rawPath : '';
  agent.onSecurityEvent?.({
    eventType,
    decision,
    detail: { path: p.slice(0, 200), ...extra },
    sessionId: agent.sessionId,
  });
}

/** 终态拒绝的统一出口：denied 记账 + chunk + 拒绝文案返回（循环继续） */
function denyWithChunk(
  agent: AgentStreamOptions,
  toolCallId: string,
  def: ToolDefinition,
  output: string,
  finalStates?: Map<string, ToolCallBlock['state']>,
  onChunk?: (chunk: ChatStreamChunk) => void,
): string {
  finalStates?.set(toolCallId, 'denied');
  agent.toolStats?.({ toolName: def.name, state: 'denied' });
  onChunk?.({
    type: 'tool-update',
    toolCallId,
    toolName: def.name,
    state: 'denied',
    output,
  });
  return output;
}

/**
 * DB 写低风险免审集（权限放宽 spec §4.4）：落库无文件系统风险；
 * read 类工具本就不审批，此处只列 kind=write 的业务工具
 */
const AUTO_EXEMPT_WRITE_TOOLS = new Set([
  'todo_write',
  'todo_write',
  'todo_write',
  'create_skill',
  'create_expert',
  'update_expert',
]);

/**
 * 网络域工具集（免审面，2026-10-24 裁定——无单独授权必要，任何档位均
 * 直执行）：web 双工具 + browser 四件 + mcp__ 连接器前缀（注入本就来自
 * enabled server——「已启用的连接器」语义天然成立）
 */
const NETWORK_TOOL_NAMES = new Set([
  'fetch',
  'browse',
  'browser_snapshot',
  'browser_navigate',
  'browser_click',
  'browser_type',
]);

const MCP_TOOL_PREFIX = 'mcp__';

function isNetworkTool(toolName: string): boolean {
  // browser 四件是桥转发工具，与 BRIDGE_TOOL_NAMES 豁免同向叠加无冲突
  return (
    NETWORK_TOOL_NAMES.has(toolName) || toolName.startsWith(MCP_TOOL_PREFIX)
  );
}

/** bash 危险分级判定（spec §4.1/§4.5）：非 bash/无命令返回 null */
function resolveCommandRisk(toolName: string, input: unknown): CommandRisk {
  if (toolName !== 'bash') return null;
  const command = (input as { command?: unknown } | null)?.command;
  if (typeof command !== 'string' || command === '') return null;
  return assessCommandRisk(command);
}

/**
 * 工具调用全流程（包装注册表工具的 execute，供单测导出）：
 * 危险工具门（本仓）：allowDangerousTools=false 时 bash 直接拒绝；
 * 命令判定门：block 拒 / ask 审批（full 豁免）/ allow 跳审批 /
 * default 回落既有链路；
 * 危险分级线（权限放宽 spec §4.5）：HIGH/CRITICAL 危险命令两档均审批
 * （full 亦不豁免，对齐 WorkBuddy bypass）——autoDenyApprovals 时经
 * needsApproval 分支自动拒（T7 无头裁定，不单独前置强拒避免双路径）；
 * 文件判定门：文件四件先经 gate——block 审批（full 豁免）/ allow 跳审批
 * / default 回落既有链路（与命令门互斥）；
 * 批量删除预估门：rm 目录预估 ≥ 阈值 → 强制审批（full 豁免——
 * 照 mirror 2026-10-23 三档递进裁定推翻旧不豁免裁定；allowDangerousTools
 * =false 时直接拒绝）；
 * write 审批判定——完全访问直执行（含 MCP）；已记忆直执行；
 * 权限放宽（2026-10-24 spec §4.4，mirror 同构）：default 档审批面收窄为
 * 「高危询问」——普通命令（bash 兜底移除）/write 工作空间内
 * /DB 写（AUTO_EXEMPT_WRITE_TOOLS）/网络域（isNetworkTool）直执行，其余
 * write 未记忆挂起审批；
 * 拒绝以文案回喂（循环继续）；autoDenyApprovals 不挂起直接拒；中止竞速
 * 防流悬挂
 */
export async function runToolCall(
  def: ToolDefinition,
  agent: AgentStreamOptions,
  toolCallId: string,
  input: unknown,
  abortSignal: AbortSignal | undefined,
  onChunk?: (chunk: ChatStreamChunk) => void,
  finalStates?: Map<string, ToolCallBlock['state']>,
): Promise<string> {
  // 危险工具门（spec §12 偏离 2）：先于一切判定——allowDangerousTools
  // 缺省 false（安全侧），bash 整体不可用
  if (def.name === 'bash' && !agent.allowDangerousTools) {
    emitCommandEvent(agent, input, 'command-safety.rejected', 'rejected', {
      reason: 'dangerous-tools-disabled',
    });
    return denyWithChunk(
      agent,
      toolCallId,
      def,
      COMMAND_DISABLED_OUTPUT,
      finalStates,
      onChunk,
    );
  }

  const gate = resolveCommandGate(agent, def.name, input);
  if (gate === 'block') {
    emitCommandEvent(agent, input, 'command-safety.blocked', 'blocked', {
      source: 'blacklist',
    });
    return denyWithChunk(
      agent,
      toolCallId,
      def,
      COMMAND_BLOCKED_OUTPUT,
      finalStates,
      onChunk,
    );
  }
  // 危险分级（权限放宽 spec §4.5）：HIGH/CRITICAL 两档均审批（full 亦不
  // 豁免，对齐 WorkBuddy bypass）——无人值守不单独前置强拒，server 侧经
  // needsApproval 分支的 autoDenyApprovals 自动拒覆盖（T7 无头裁定）
  const commandRisk = resolveCommandRisk(def.name, input);
  if (commandRisk) {
    emitCommandEvent(agent, input, 'command-safety.needs-approval', 'info', {
      source: 'risk-table',
      risk: commandRisk,
    });
  }
  if (gate === 'ask') {
    emitCommandEvent(agent, input, 'command-safety.needs-approval', 'info', {});
  }
  if (gate === 'allow') {
    emitCommandEvent(
      agent,
      input,
      'command-safety.allow-listed',
      'allowed',
      {},
    );
  }

  const fileGateDecision = resolveFileGate(agent, def.name, input);
  if (fileGateDecision === 'block') {
    emitFileEvent(agent, input, 'file-safety.needs-approval', 'info', {
      source: 'blocklist',
    });
  }
  if (fileGateDecision === 'allow') {
    emitFileEvent(agent, input, 'file-safety.allow-listed', 'allowed', {});
  }

  const bulkEstimate = await resolveBulkDelete(agent, def.name, input);
  if (bulkEstimate !== null && !agent.allowDangerousTools) {
    // 危险工具门（spec §12 偏离 2）：批量删除预估达阈值直接拒绝
    emitFileEvent(
      agent,
      input,
      'data-safety.bulk-delete-rejected',
      'rejected',
      { estimated: bulkEstimate, reason: 'dangerous-tools-disabled' },
    );
    return denyWithChunk(
      agent,
      toolCallId,
      def,
      BULK_DELETE_DISABLED_OUTPUT,
      finalStates,
      onChunk,
    );
  }
  if (bulkEstimate !== null) {
    emitFileEvent(
      agent,
      input,
      'data-safety.bulk-delete-needs-approval',
      'info',
      { estimated: bulkEstimate },
    );
  }
  // write 直执行时的决策留痕（spec §4.7；full 档全放行不发——语义噪音）
  const writeAutoAllowed =
    !agent.fullAccess() &&
    def.name === 'write' &&
    fileGateDecision !== 'block' &&
    gate === null;
  if (writeAutoAllowed) {
    emitFileEvent(agent, input, 'file-safety.auto-allowed', 'info', {
      reason: 'workspace-write',
    });
  }

  // write 兜底收窄（权限放宽 spec §4.4）：普通命令/write/DB 写/网络
  // 域免审，只剩其余 write（rm 等）的记忆或审批；fullAccess 提至
  // 外层与 mirror 3c 同构（bulk/ask/block 询问面 full 全豁免）
  const writeFallbackNeedsApproval =
    gate !== 'allow' &&
    fileGateDecision !== 'allow' &&
    def.kind === 'write' &&
    // 桥工具豁免本机 write 门禁（TB-T2/R3，spec §4.2 本意）：无头端无人
    // 审批，write 桥调用直接发出 tool.request 转控制端桌面审批卡；
    // 豁免面精确到桥工具名（BRIDGE_TOOL_NAMES），非全部 write
    !BRIDGE_TOOL_NAMES.has(def.name) &&
    // 网络域免审（2026-10-24 裁定重落）：任何档位直执行
    !isNetworkTool(def.name) &&
    // DB 写低风险免审（spec §4.4）
    !AUTO_EXEMPT_WRITE_TOOLS.has(def.name) &&
    // write 工作空间内免审（spec §4.4）：审批面只剩文件门 block
    def.name !== 'write' &&
    // bash 兜底审批移除（spec §4.4）：危险面已由分级表前置捕获，
    // gate 为 allow/default 直执行——审批面只剩 ask 源
    def.name !== 'bash' &&
    !(await agent.isToolAllowed(def.name));
  const needsApproval =
    // 危险分级（spec §4.5）：先于 fullAccess 短路——full 也审
    commandRisk !== null ||
    // full（bypass，2026-10-23 三档递进裁定）：一切询问消失——程序黑名单
    // 与危险分级已前置，此处只剩询问面（allowDangerousTools=false 的
    // 危险工具门不受档位影响照常强拒）
    (!agent.fullAccess() &&
      (bulkEstimate !== null ||
        gate === 'ask' ||
        fileGateDecision === 'block' ||
        writeFallbackNeedsApproval));
  if (needsApproval) {
    // T7 无头裁定：无应答方不挂起（挂起=永久悬挂），denied chunk 提示 config 放行
    if (agent.autoDenyApprovals) {
      return denyWithChunk(
        agent,
        toolCallId,
        def,
        APPROVAL_AUTO_DENIED_OUTPUT,
        finalStates,
        onChunk,
      );
    }
    const decision = await awaitApproval(
      def,
      toolCallId,
      input,
      agent,
      abortSignal,
      onChunk,
    );
    if (decision === 'aborted') {
      finalStates?.set(toolCallId, 'error');
      return TOOL_ABORTED_OUTPUT;
    }
    if (decision === 'denied') {
      agent.onApprovalResolved?.(
        def.name,
        decision,
        summarizeArgs(def.name, input),
      );
      return denyWithChunk(
        agent,
        toolCallId,
        def,
        TOOL_DENIED_OUTPUT,
        finalStates,
        onChunk,
      );
    }
    // aborted/denied 均已 return，此处必为 approved（审计：批准决议）
    agent.onApprovalResolved?.(
      def.name,
      decision,
      summarizeArgs(def.name, input),
    );
  }
  const toolStartedAt = Date.now();
  onChunk?.({
    type: 'tool-update',
    toolCallId,
    toolName: def.name,
    state: 'running',
  });
  const output = await raceWithAbort(
    executeToolSafe(def, agent, input),
    abortSignal,
    () => {
      finalStates?.set(toolCallId, 'error');
      return TOOL_ABORTED_OUTPUT;
    },
  );
  if (abortSignal?.aborted) {
    return output;
  }
  onChunk?.({
    type: 'tool-update',
    toolCallId,
    toolName: def.name,
    state: output.startsWith('错误:') ? 'error' : 'done',
    output: output.slice(0, TOOL_OUTPUT_SLICE),
  });
  agent.toolStats?.({
    toolName: def.name,
    state: output.startsWith('错误:') ? 'error' : 'done',
    durationMs: Date.now() - toolStartedAt,
  });
  return output;
}

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
import { truncateHistory } from "./history-truncate";
import { classifyError } from "./error-classify";
import { createLanguageModel } from "../provider/provider-factory";
import { SessionRepository, type AppendMessageParams } from "./session.repo";
import { registry } from "../agent/tool-registry";
import { loadSkills, type SkillInfo } from "../agent/skill-loader";
import { buildSystemPrompt } from "../agent/skill-prompt";
import { makeReadSkillTool } from "../agent/read-skill";
import type { ToolDefinition } from "../agent/file-tools";
import { ApprovalCoordinator } from "../agent/approval";
import type {
  ChatSendParams,
  ChatStatusResult,
  ChatStreamChunk,
} from "../../../../src-react/domains/ai/api/chat.api";
import type { WorkspaceRecord } from "../../../../src-react/domains/ai/api/workspace.api";

type AssistantRow = NonNullable<
  Awaited<ReturnType<typeof prisma.assistant.findFirst>>
>;

/** 步数上限保险丝（spec 决策 #3：宽上限，上下文截断为自然限界） */
const DEFAULT_MAX_STEPS = 50;

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
  sessionId: number;
  sessionWorkspaceId: number;
  /**
   * 绑定目录的规范化绝对路径（无尾部分隔符）；未绑定目录时为 undefined——
   * 文件四件依赖它（不注入），read_skill 与 mcp__ 工具不依赖（P2 常驻）
   */
  workspacePath?: string;
  /** write 授权实时判定（每次写入前查询，撤销立即生效，spec §1） */
  isWriteApproved: () => Promise<boolean>;
  /** 挂起等待渲染层审批决议；resolve false = 拒绝 */
  requestApproval: (toolCallId: string, argSummary: string) => Promise<boolean>;
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

/** 审批横幅直显的参数摘要：优先路径，否则 JSON 截断 */
function summarizeArgs(toolName: string, input: unknown): string {
  const record = (
    typeof input === "object" && input !== null ? input : {}
  ) as Record<string, unknown>;
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
      // 未绑定工作空间时无路径（文件工具不会注入；mcp/read_skill 不读 ctx）
      { workspacePath: agent.workspacePath ?? "", sessionId: agent.sessionId },
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

/**
 * 工具调用全流程（包装注册表工具的 execute）：
 * write 未授权先挂起审批（mcp__ 写类不吃工作空间授权，始终挂起，spec 决策 #1）；
 * 拒绝以文案回喂（循环继续）；中止竞速防流悬挂
 */
async function runToolCall(
  def: ToolDefinition,
  agent: AgentStreamOptions,
  toolCallId: string,
  input: unknown,
  abortSignal: AbortSignal | undefined,
  onChunk?: (chunk: ChatStreamChunk) => void,
  finalStates?: Map<string, ToolCallBlock["state"]>,
): Promise<string> {
  if (
    def.kind === "write" &&
    (def.name.startsWith("mcp__") || !(await agent.isWriteApproved()))
  ) {
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
      return TOOL_DENIED_OUTPUT;
    }
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

  const messages = truncateHistory(
    options.history,
    options.contextWindow,
  ).flatMap((m) => blocksToModelMessages(parseBlocks(m.blocks), m.role));

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

export default class ChatService {
  private aborts = new Map<number, AbortController>();
  private snapshots = new Map<number, StreamSnapshot>();
  private approvals = new ApprovalCoordinator();

  constructor(private sessions: SessionRepository) {
    this.registerHandlers();
  }

  private registerHandlers() {
    ipcMain.handle("chat:send", (event, params: ChatSendParams) =>
      this.send(params, event.sender),
    );
    ipcMain.handle("chat:regenerate", (event, sessionId: number) =>
      this.regenerate(sessionId, event.sender),
    );
    ipcMain.handle("chat:stop", (_, sessionId: number) => this.stop(sessionId));
    ipcMain.handle("chat:status", (_, sessionId: number) =>
      this.status(sessionId),
    );
    // P1 审批决议：渲染层 → 主进程，resolve 挂起的 write 工具
    ipcMain.handle(
      "agent:approve",
      (_, toolCallId: string, approved: boolean) =>
        this.approvals.respond(toolCallId, approved),
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
   * 重新生成：删除最后一条 user 消息之后的所有消息，重跑流（spec §4.2 原位替换）
   */
  async regenerate(sessionId: number, sender?: WebContents): Promise<void> {
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
      let lastUserIdx = -1;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].role === "user") {
          lastUserIdx = i;
          break;
        }
      }
      if (lastUserIdx === -1) {
        throw new Error("NOTHING_TO_REGENERATE");
      }
      const tailIds = rows.slice(lastUserIdx + 1).map((row) => row.id);
      if (tailIds.length > 0) {
        await prisma.message.deleteMany({ where: { id: { in: tailIds } } });
      }
      await this.streamAndPersist(sessionId, abort, sender);
    } catch (error) {
      this.aborts.delete(sessionId);
      throw error;
    }
  }

  /**
   * agent 上下文装配（P2）：所有会话都具备——read_skill 与 mcp__ 工具不依赖
   * 工作空间（spec 决策 #3 常驻注入），mcp__ 写类审批也始终可用（决策 #1）。
   * workspacePath 仅在绑定目录后有值；isWriteApproved 实时查询（撤销立即生效）
   */
  private async resolveAgentOptions(
    session: { workspaceId: number },
    sessionId: number,
  ): Promise<AgentStreamOptions> {
    const sessionWorkspaceId = session.workspaceId;
    const workspace = sessionWorkspaceId
      ? await this.sessions.getWorkspace(sessionWorkspaceId)
      : null;
    const directoryPath = workspace?.directoryPath?.trim() || null;
    return {
      sessionId,
      sessionWorkspaceId,
      workspacePath: directoryPath
        ? normalizeWorkspacePath(directoryPath)
        : undefined,
      isWriteApproved: async () => {
        if (!directoryPath) {
          return false;
        }
        const ws = await prisma.workspace.findUnique({
          where: { id: sessionWorkspaceId },
        });
        return ws?.writeApprovedAt != null;
      },
      requestApproval: (toolCallId, argSummary) =>
        this.approvals.request(toolCallId, argSummary),
    };
  }

  /**
   * 注入工具集（P2 spec 决策 #3）：read_skill 常驻（未绑定目录也注入，与
   * system prompt 消费同一次 skills 扫描）；mcp__* 经 registry 全量透传；
   * 文件四件依赖工作空间路径，仅绑定目录后注入
   */
  private collectToolDefinitions(
    agent: AgentStreamOptions,
    skills: SkillInfo[],
  ): ToolDefinition[] {
    const registered = registry.getDefinitions();
    const injected = agent.workspacePath
      ? registered
      : registered.filter((def) => def.name.startsWith("mcp__"));
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
        dir: path.join(workspaceDir, ".mirror", "skills"),
        source: "workspace",
      });
    }
    return loadSkills(dirs);
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

    const history = (
      await prisma.message.findMany({
        where: { sessionId },
        orderBy: { createdAt: "asc" },
      })
    )
      .filter((row) => row.role !== "system" && !row.error)
      .map((row) => ({
        role: row.role as "user" | "assistant",
        blocks: row.blocks,
      }));

    const agent = await this.resolveAgentOptions(session, sessionId);
    // 同一次扫描喂两处：system prompt 技能清单 + read_skill 工具查表
    const skills = this.collectSkills(agent.workspacePath);
    try {
      const result = await runChatStream({
        model: createLanguageModel(
          {
            type: providerRow.type,
            baseUrl: providerRow.baseUrl,
            apiKey: providerRow.apiKey ?? undefined,
            extraHeaders: providerRow.extraHeaders,
          },
          modelRow.modelId,
        ),
        system: buildSystemPrompt(assistantRow?.systemPrompt, skills),
        history,
        contextWindow: modelRow.contextWindow ?? undefined,
        params: merged,
        abortSignal: abort.signal,
        toolDefinitions: this.collectToolDefinitions(agent, skills),
        agent,
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
          modelId,
          assistantId: session.assistantId ?? undefined,
          error: result.errorMessage,
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
          type: providerRow.type,
          baseUrl: providerRow.baseUrl,
          apiKey: providerRow.apiKey ?? undefined,
          extraHeaders: providerRow.extraHeaders,
          modelId: modelRow.modelId,
        });
      }
    } finally {
      this.aborts.delete(sessionId);
      this.snapshots.delete(sessionId);
      // 中断/收尾：作废全部未决审批（resolve false），释放挂起的 execute（spec 决策 #5）
      this.approvals.voidAll();
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
   * 查询会话流状态（切回会话时恢复 UI 用，spec §4；P1 增含 tools 态）
   */
  status(sessionId: number): ChatStatusResult {
    const snap = this.snapshots.get(sessionId);
    return {
      streaming: this.aborts.has(sessionId),
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

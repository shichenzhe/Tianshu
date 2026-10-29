/**
 * 流式执行核心 runChatStream（RC-T4 自 mirror chat.service 剥出入包，以
 * mirror 实现为准——服务端仓 T6 改造版仅参考不照搬）。
 * - T3-3 换引擎：createReactAgent + streamEvents(v2)，事件经
 *   consumeAgentStream（./agent-chunk-emitter）归一为 onChunk 协议（前端
 *   零改动）；传入 toolDefinitions + agent + toTools 时启用 langgraph
 *   多步工具循环（recursionLimit 保险丝），tool-result 自动回喂下一步；
 *   否则与 P0 行为一致（纯对话）；
 * - 工具适配（toLangChainTools——runToolCall 安全门/审批/审计链，electron
 *   域闭包）不入包，经 options.toTools 参数注入；mirror 侧 chat.service
 *   薄包装固定注入，既有调用方（streamAndPersist/automation-runner/注入
 *   fake model 的单测）签名与行为不变；
 * - toolDefinitions/agent 对本函数近乎不透明（estimateReserveTokens 按
 *   unknown[] JSON 体积估算，其余整包透传 toTools），故以最小结构
 *   ToolDefinitionLike + 泛型 TAgent 约束（server 仓 ToolDefinitionLike
 *   先例）——宿主包装层可收窄回域内真身类型。
 */
import {
  createReactAgent,
  ToolNode,
} from "@langchain/langgraph/prebuilt";
import { GraphRecursionError } from "@langchain/langgraph";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { Command } from "@langchain/langgraph";
import type { ToolCall } from "@langchain/core/messages/tool";
import type { ToolMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type {
  ChatModelParams,
  ChatStreamChunk,
  MessageBlock,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
} from "@tianshu/protocol";
import { blocksToModelMessages, type ImageDataUrlLoader } from "./blocks";
import { estimateReserveTokens, truncateHistory } from "./history-truncate";
import { trimHistoryToolOutputs } from "./tool-output-trim";
import { classifyError } from "./error-classify";
import { consumeAgentStream } from "./agent-chunk-emitter";
import { canonicalToolName } from "./tool-alias";

/** 步数上限保险丝（spec 决策 #3：宽上限，上下文截断为自然限界） */
export const DEFAULT_MAX_STEPS = 50;

/**
 * 别名 ToolNode（2026-10-29 工具名精简批次）：模型模仿历史 blocks 发出
 * 老名 tool_call（编辑重发场景）时在 runTool 入口归一为新名分发。绑定面
 * 不受影响——createReactAgent 收 ToolNode 形参时取 node.tools 绑定模型
 * （react_agent_executor.js 非 Array 分支），新名 schema 单列可见、老名
 * 不双列。老名无映射时 canonicalToolName 原样透传（mcp__ 等）。
 */
class AliasToolNode extends ToolNode {
  protected override async runTool(
    call: ToolCall,
    config: LangGraphRunnableConfig,
    state: unknown,
  ): Promise<ToolMessage | Command> {
    const canonical = canonicalToolName(call.name);
    // 新名工具存在才归一分发；不存在按原名原样（过渡期老名注册项/
    // 测试替身兜底，终态生产面 def 恒新名不达此分支）
    const hasCanonical = this.tools.some((tool) => tool.name === canonical);
    return super.runTool(
      hasCanonical ? { ...call, name: canonical } : call,
      config,
      state,
    );
  }
}

/**
 * 最小结构工具定义（server 仓 ToolDefinitionLike 先例）：runChatStream 对
 * 工具定义只做估算与透传——estimateReserveTokens 按 unknown[] JSON 体积
 * 计入预留、装配经注入的 toTools；zod schema/JSON Schema/execute/kind 等
 * agent 域细节对包不透明，宿主泛型收窄
 */
export interface ToolDefinitionLike {
  name: string;
  description: string;
}

/** toTools 注入点载荷（mirror 侧 toLangChainTools 的 ToolAdapterOptions 同构） */
export interface ToolBindOptions {
  abortSignal?: AbortSignal;
  /** 工具执行 chunk 出口（审批卡等不经引擎事件流的工具态必须透传） */
  onChunk?: (chunk: ChatStreamChunk) => void;
  /** 拒绝/中止终态记录（拒绝块 state=denied 等落库判定用，键 = toolCallId） */
  finalStates?: Map<string, ToolCallBlock["state"]>;
}

/**
 * 工具适配器（参数注入）：宿主域 ToolDefinition[] + agent 上下文 → LangChain
 * 工具集。泛型随 ChatStreamOptions 推断，宿主实现（mirror toLangChainTools）
 * 即收窄回真身类型——包内不 import electron 域适配器
 */
export type ToolBinder<
  TToolDef extends ToolDefinitionLike = ToolDefinitionLike,
  TAgent = unknown,
> = (
  defs: TToolDef[],
  agent: TAgent,
  opts: ToolBindOptions,
) => StructuredToolInterface[];

export interface ChatStreamOptions<
  TToolDef extends ToolDefinitionLike = ToolDefinitionLike,
  TAgent = unknown,
> {
  model: BaseChatModel;
  system?: string;
  /** 历史消息（含本次用户消息；函数内部截断并转换为 LangChain 消息） */
  history: Array<{ role: "user" | "assistant"; blocks: string }>;
  /** 采样参数口径（终审 T9c）：temperature/topP 经 langchain-model-factory
   * 构造注入，runChatStream 内不再消费下发模型；仅 maxTokens 仍供
   * estimateReserveTokens 截断预算——勿误以为 params 直接下发模型 */
  params: ChatModelParams;
  contextWindow?: number;
  abortSignal?: AbortSignal;
  onChunk?: (chunk: ChatStreamChunk) => void;
  /**
   * 注入的工具定义（P2：service 组装——read_skill 常驻 + registry 注册工具，
   * 未绑定目录时不含文件四件；runChatStream 侧要求与 agent 同时在场才启用工具）
   */
  toolDefinitions?: TToolDef[];
  /** 工具执行/审批上下文；缺省时不注入工具（纯对话） */
  agent?: TAgent;
  /**
   * 工具适配器（宿主注入，RC-T4 参数化）：toolDefinitions 与 agent 同时
   * 在场时经它装配 LangChain 工具集；缺省（或 agent 缺席）不启用工具循环
   * ——mirror 由 chat.service 包装层固定注入 toLangChainTools，老调用
   * 零改动
   */
  toTools?: ToolBinder<TToolDef, TAgent>;
  /** SDK 多步循环步数上限（保险丝），默认 50 */
  maxSteps?: number;
  /** 历史图片块 → dataUrl 读取器（多模态回喂）；缺省时 image 块降级占位 */
  loadImage?: ImageDataUrlLoader;
}

export interface ChatStreamResult {
  blocks: MessageBlock[];
  errorCode?: string;
  errorMessage?: string;
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
  // MCP 字符串入参工具：模型按 description 内嵌 schema 生成 JSON 字符串，
  // 解析为对象展示（对齐旧 SDK 解析后进 part.input 的口径；解析失败空对象）
  if (typeof input === "string") {
    try {
      return asArgs(JSON.parse(input));
    } catch {
      return {};
    }
  }
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

/** tool-call（映射层 onToolCall 通用形状）：关闭开放块语义由调用方处理，
 * 此处落块并推 ready chunk */
function handleToolCallPart(
  blocks: MessageBlock[],
  toolBlocks: Map<string, ToolCallBlock>,
  part: { toolCallId: string; toolName: string; args: unknown },
  onChunk?: (chunk: ChatStreamChunk) => void,
): void {
  const block: ToolCallBlock = {
    type: "tool_call",
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    args: asArgs(part.args),
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
 * 流式执行核心（可注入 model 与工具，供单测）。T3-3 换引擎：
 * createReactAgent + streamEvents(v2)，事件经 consumeAgentStream 归一为
 * onChunk 协议（前端零改动）。传入 toolDefinitions + agent（+ toTools）时
 * 启用 langgraph 多步工具循环（recursionLimit 保险丝），tool-result 自动
 * 回喂下一步；否则与 P0 行为一致
 */
export async function runChatStream<
  TToolDef extends ToolDefinitionLike = ToolDefinitionLike,
  TAgent = unknown,
>(options: ChatStreamOptions<TToolDef, TAgent>): Promise<ChatStreamResult> {
  const blocks: MessageBlock[] = [];
  const toolBlocks = new Map<string, ToolCallBlock>();
  const finalStates = new Map<string, ToolCallBlock["state"]>();
  let openText: TextBlock | null = null;
  let openThinking: ThinkingBlock | null = null;
  let usage: { input: number; output: number } | undefined;
  let errorCode: string | undefined;
  let errorMessage: string | undefined;

  // 解析一次复用：token 估算与模型消息转换共享同一 parse 结果，
  // 避免长会话下同一批 blocks 被 JSON.parse 两遍；旧轮工具输出先瘦身
  // （spec §18 项 1）——只影响回喂副本（DB blocks/编辑重发/回看不动），
  // 截断判定与 token 估算天然消费瘦身后成本；blocksToModelMessages
  // 读图转 image_url content block 为 async，逐消息并行后拍平
  const messages = (
    await Promise.all(
      truncateHistory(
        trimHistoryToolOutputs(options.history),
        options.contextWindow,
        {
          reserveTokens: estimateReserveTokens(
            options.params.maxTokens,
            options.system,
            options.toolDefinitions ?? [],
          ),
        },
      ).map((m) => blocksToModelMessages(m.blocks, m.role, options.loadImage)),
    )
  ).flat();

  const { agent, toolDefinitions, toTools } = options;
  // d.ts 核对：createReactAgent 的 tools 为必填（undefined 不可），空集传 []。
  // ⚠ toTools 缺省且 agent+toolDefinitions 存在时静默纯聊（无错误信号）——
  // 消费方（mirror chat.service 薄包装/server chat-runner）必须注入 toTools
  const tools =
    agent && toolDefinitions?.length && toTools
      ? toTools(toolDefinitions, agent, {
          abortSignal: options.abortSignal,
          // 工具执行层 chunk（running/审批卡/终态）与拒绝终态记录经
          // runToolCall 产出——approval-request 不走引擎事件流，必须透传
          onChunk: options.onChunk,
          finalStates,
        })
      : [];

  const agentExecutor = createReactAgent({
    llm: options.model,
    // ToolNode 形参：绑定面（node.tools=新名集）与执行面（runTool 归一）
    // 分离——老名分发经 AliasToolNode 兑现，见类注释
    tools: new AliasToolNode(tools),
    // langgraph prebuilt 系统提示注入参数名为 prompt（安装版 d.ts 核对：
    // string | SystemMessage | fn | Runnable；string 即前置 SystemMessage）
    prompt: options.system,
  });

  const eventStream = agentExecutor.streamEvents(
    { messages },
    {
      version: "v2",
      // stepCountIs(n) 的 n 步模型 ↔ langgraph recursionLimit：一步 agent =
      // 模型 + 工具两个 super-step。T3-3 实测（langgraph 1.5.0）：limit=2n
      // 恰好 n 次模型调用（limit 触顶抛 GraphRecursionError，onError 侧按
      // 保险丝语义吞掉，对齐旧 stopWhen 无错截断）；2n+2 会多调一次
      recursionLimit: (options.maxSteps ?? DEFAULT_MAX_STEPS) * 2,
      signal: options.abortSignal,
    },
  );

  await consumeAgentStream(
    eventStream,
    {
      onTextDelta: (text) => {
        openText = appendDelta(blocks, openText, "text", text, options.onChunk);
      },
      onReasoningDelta: (text) => {
        openThinking = appendDelta(
          blocks,
          openThinking,
          "thinking",
          text,
          options.onChunk,
        );
      },
      onToolCall: (call) => {
        // 工具调用打断文本流：关闭开放块，后续文本另起新块
        openText = null;
        openThinking = null;
        handleToolCallPart(blocks, toolBlocks, call, options.onChunk);
      },
      onToolResult: (call) =>
        finalizeToolBlock(
          toolBlocks.get(call.toolCallId),
          call.output,
          finalStates,
        ),
      onToolError: (call) =>
        // tracer stringifyError = message + "\n\n" + stack：截首段只显 message
        markToolError(
          toolBlocks.get(call.toolCallId),
          call.error.split("\n")[0],
        ),
      onFinish: (u) => {
        openText = null;
        openThinking = null;
        usage = u;
      },
      onError: (error) => {
        // 用户主动中止不是错误：不记录错误码、不推送错误 chunk（已生成部分照常保留）
        if (options.abortSignal?.aborted) {
          return;
        }
        // 保险丝触顶（旧 stopWhen 语义）：无错截断，已生成内容照常保留。
        // instanceof 为主判据（T3-3 探针实证经 streamEvents 表面保留类身份），
        // message 前缀兜底多节点并发失败的 AggregateError 包装情形
        if (
          error instanceof GraphRecursionError ||
          (error instanceof Error &&
            error.message.startsWith("Recursion limit of"))
        ) {
          return;
        }
        errorCode = classifyError(error);
        errorMessage = error instanceof Error ? error.message : String(error);
      },
    },
    () => options.abortSignal?.aborted === true,
  );
  finalizeInterruptedToolBlocks(toolBlocks);

  if (usage) {
    blocks.push({ type: "usage", input: usage.input, output: usage.output });
  }
  return { blocks, errorCode, errorMessage };
}

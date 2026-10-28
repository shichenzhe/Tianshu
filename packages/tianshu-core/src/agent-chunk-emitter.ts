/**
 * streamEvents → onChunk 映射层（统一 LLM 栈 T3-2，spec §4.3）。实现自 mirror
 * electron/domains/ai/chat/agent-chunk-emitter.ts 物理搬入本包（RC-T4，随
 * runChatStream 闭包剥出——唯一依赖 @langchain/core 的 StreamEvent 类型，
 * 无 electron/chat 域耦合；原位改 re-export 兼容，老 import 链不变）。
 *
 * 消费 createReactAgent(...).streamEvents(v2) 产出的 StreamEvent 流，归一化为
 * 现有 onChunk 协议回调（Task 9 在 chat.service 接线，前端零改动的关键）。
 *
 * 载荷口径按本地安装版 dist 核对（@langchain/core 1.2.17 + langgraph 1.5.0）：
 * - on_chat_model_stream：data.chunk = AIMessageChunk，content 为 string 或
 *   ContentBlock[]（text 块 {type:"text", text}）；reasoning 走
 *   additional_kwargs.reasoning_content（OpenAI 兼容系深度思考字段）；usage_metadata
 *   {input_tokens, output_tokens} 每轮上报（OpenAI 末 chunk 单报；anthropic
 *   在 message_start 报 input、message_delta 报终值 output；google 分 chunk
 *   报增量），且同一轮 on_chat_model_end 聚合消息再报一次——直接累加会双计，
 *   故按 run_id 去重每轮恰计一次、跨轮累加（对齐旧 AI SDK totalUsage 全步
 *   累加语义，详见 makeUsageAccumulator）
 * - on_chat_model_end：data.output = 聚合 AIMessage，其 tool_calls[].id 为
 *   模型生成的 tool_call id（T3-3 实证：与工具函数 config.toolCall.id 同源）。
 *   工具调用块在此发射（对齐旧引擎 tool-call part 先于执行的时序）；
 *   随后的 on_tool_start 按 (name, args) 匹配挂起项做 run_id → 模型 id 关联
 *   并跳过重复发射——on_tool_start/on_tool_end 事件本身只携带 run_id
 *   （无模型 tool_call id，事件 metadata 亦不含，core tracer 把它记在
 *   run.extra.tool_call_id 不外发），不关联则块与工具执行 chunk 的 id 串不上
 * - on_tool_start：data.input 为工具 args（langgraph ToolNode 经 ToolCall
 *   调用，core Tool.invoke 先解包 input.args 再记 trace 输入；对象 args
 *   原样，字符串 args——MCP DynamicTool 路径——被 tracer 包成 {input:
 *   string}，匹配前解包）；无模型事件先行时（非模型驱动的工具调用/
 *   测试直供事件）回落按旧口径以 run_id 发射
 * - on_tool_end：data.output 经 core _formatToolOutput 包装为 ToolMessage 实例，
 *   真实载荷在 .content → stringifyOutput 解包；Error 对象（计划假想的包装
 *   形态）分流 onToolError；终态 id 优先采信载荷 ToolMessage.tool_call_id
 *   （与模型 tool_call id 同源——挂起项 (name, args) 匹配失败时的旁路关联），
 *   但仅限本流已发射过的 id（陌生 id 不劫走无模型回退场景按 run_id 发射
 *   的终态，否则终态 chunk 与 call chunk 的 id 串不上、消费方静默丢结果），
 *   拿不到再回退 run_id 关联映射
 * - on_tool_error：工具抛错时 core tracer 实发事件，data.error 为 string
 *   （tracer stringifyError = message + "\n\n" + stack，消费方自行截首段）——
 *   与上一条双形态都归一到 onToolError
 * - 中止语义：迭代抛错且 isAborted() 为真时静默吞掉（对齐 chat.service
 *   runChatStream 的 catch 口径：用户主动中止不是错误，已生成内容保留、
 *   不报 onError 也不补 onFinish）；其余错误先补 onFinish(已结算 usage)
 *   再 onError——保险丝触顶等截断场景旧引擎 finish part 带真实
 *   totalUsage，丢弃会让监控 DB 缺 token 统计（终审 T9a）
 */
import type { StreamEvent } from "@langchain/core/tracers/log_stream";

/** Task 9 消费的回调协议（签名即契约，勿改） */
export interface EmitterCallbacks {
  onTextDelta(text: string): void;
  onReasoningDelta(text: string): void;
  onToolCall(call: {
    toolCallId: string;
    toolName: string;
    args: unknown;
  }): void;
  onToolResult(call: { toolCallId: string; output: string }): void;
  onToolError(call: { toolCallId: string; error: string }): void;
  onFinish(usage: { input: number; output: number } | undefined): void;
  onError(error: unknown): void;
}

/** 工具输出归一的截断上限（非字符串载荷 JSON 序列化后；对齐计划口径 500 字符） */
const MAX_TOOL_OUTPUT_LENGTH = 500;

/** usage_metadata 只读子集（流式 chunk 与 on_chat_model_end 聚合消息共用形状） */
interface UsageMetadataShape {
  input_tokens?: number;
  output_tokens?: number;
}

/** on_chat_model_stream 载荷 chunk 的结构化读法（AIMessageChunk 只读子集） */
interface ModelStreamChunk {
  content?: unknown;
  additional_kwargs?: Record<string, unknown> | undefined;
  usage_metadata?: UsageMetadataShape | undefined;
}

const truncatedJson = (value: unknown): string => {
  try {
    const json = JSON.stringify(value) ?? "";
    return json.length > MAX_TOOL_OUTPUT_LENGTH
      ? json.slice(0, MAX_TOOL_OUTPUT_LENGTH)
      : json;
  } catch {
    // 循环引用等不可序列化载荷：String 兜底（core _stringify 同款降级）
    return `${String(value)}`.slice(0, MAX_TOOL_OUTPUT_LENGTH);
  }
};

/** ToolMessage 形状（core 1.2.17 经 ToolCall 调用的 on_tool_end.data.output） */
const isToolMessageLike = (value: unknown): value is { content: unknown } =>
  typeof value === "object" &&
  value !== null &&
  "tool_call_id" in value &&
  "content" in value;

/** on_tool_end 载荷 ToolMessage 自带的模型 tool_call id（与模型发射的
 * tool_calls[].id 同源）；非 ToolMessage 形状或 id 非非空字符串视为缺失 */
const payloadToolCallId = (output: unknown): string | undefined => {
  if (!isToolMessageLike(output)) return undefined;
  const id = (output as { tool_call_id?: unknown }).tool_call_id;
  return typeof id === "string" && id ? id : undefined;
};

const isTextBlock = (part: unknown): part is { text: string } =>
  typeof part === "object" &&
  part !== null &&
  (part as { type?: unknown }).type === "text" &&
  typeof (part as { text?: unknown }).text === "string";

/**
 * 工具输出归一为 string：StringContent 直取 string；ToolMessage 形状取
 * .content 递归；content block 数组拼 text 块；其余 JSON.stringify 截断
 * 500 字符（对齐 chat.service finalizeToolBlock 的 string 输出口径）
 */
function stringifyOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output == null) return "";
  if (output instanceof Error) return output.message;
  if (isToolMessageLike(output)) return stringifyOutput(output.content);
  if (Array.isArray(output)) {
    if (output.every(isTextBlock)) {
      return output.map((part) => part.text).join("");
    }
    return truncatedJson(output);
  }
  return truncatedJson(output);
}

/** 单个流式 chunk → reasoning/text/usage 回调（reasoning 先行，golden A 序） */
function emitModelChunk(chunk: ModelStreamChunk, cb: EmitterCallbacks): void {
  const reasoning = chunk.additional_kwargs?.reasoning_content;
  if (typeof reasoning === "string" && reasoning) {
    cb.onReasoningDelta(reasoning);
  }
  if (typeof chunk.content === "string") {
    if (chunk.content) cb.onTextDelta(chunk.content);
  } else if (Array.isArray(chunk.content)) {
    for (const part of chunk.content) {
      if (isTextBlock(part) && part.text) cb.onTextDelta(part.text);
    }
  }
}

/** on_chat_model_end 载荷聚合消息的 tool_calls 只读子集 */
interface ToolCallShape {
  id?: unknown;
  name?: unknown;
  args?: unknown;
}

const stableJson = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "unserializable";
  }
};

/** core tracer 对字符串 callbackInput 记 {input: string}（对象原样）——
 * 归一还原比对原值 */
function unwrapTracedInput(input: unknown): unknown {
  if (
    typeof input === "object" &&
    input !== null &&
    typeof (input as { input?: unknown }).input === "string"
  ) {
    return (input as { input: string }).input;
  }
  return input;
}

/** 还原后的字符串载荷是否为序列化 ToolCall（{type:"tool_call", id}），
 * 是则返回其模型 tool_call id（工具直调路径的关联键兜底） */
function serializedToolCallId(input: unknown): string | null {
  if (typeof input !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(input) as {
      type?: unknown;
      id?: unknown;
    };
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.type === "tool_call" &&
      typeof parsed.id === "string" &&
      parsed.id
    ) {
      return parsed.id;
    }
  } catch {
    /* 非 JSON 字符串载荷走 args 匹配回落 */
  }
  return null;
}

/** 模型发射的工具调用挂起项：待 on_tool_start 按 (name, args) 认领 */
interface PendingToolCall {
  id: string;
  name: string;
  argsJson: string;
}

/**
 * 多轮 usage 记账（对齐旧 AI SDK finish.totalUsage 全步累加语义）。
 *
 * 同一轮（run_id）usage 上报两处：流式 chunk（OpenAI 末 chunk 单报、
 * anthropic/google 分 chunk 增量报——core AIMessageChunk.concat 对
 * usage_metadata 求和）与 on_chat_model_end 聚合消息（concat 产物，该轮
 * 权威总值）。记账规则：
 * - 流式 chunk 报告按轮累加进轮账（增量口径正确；单报即全值亦然）
 * - on_chat_model_end 到达时以聚合值覆盖轮账后结算入总账（T3-3 回退分支：
 *   仅聚合上报的模型在此生效）；settledRuns 去重保证每轮恰计一次
 * - finish 收尾时轮账仍有余额（退化流缺 end 事件）按已上报值兜底结算；
 *   幂等可双调（runUsage 清空后二调原值返回）——中止路径不调 finish，
 *   错误路径补调一次转发余额（终审 T9a）
 */
function makeUsageAccumulator(): {
  addStreamReport(runId: string, usage: UsageMetadataShape): void;
  settleRun(runId: string, endUsage: UsageMetadataShape | undefined): void;
  finish(): { input: number; output: number } | undefined;
} {
  let total: { input: number; output: number } | undefined;
  const runUsage = new Map<string, { input: number; output: number }>();
  const settledRuns = new Set<string>();
  const hasTokens = (usage: UsageMetadataShape): boolean =>
    Boolean(usage.input_tokens || usage.output_tokens);
  const absorb = (run: { input: number; output: number }): void => {
    total = {
      input: (total?.input ?? 0) + run.input,
      output: (total?.output ?? 0) + run.output,
    };
  };
  return {
    addStreamReport(runId, usage) {
      if (settledRuns.has(runId) || !hasTokens(usage)) return;
      const prev = runUsage.get(runId);
      runUsage.set(runId, {
        input: (prev?.input ?? 0) + (usage.input_tokens ?? 0),
        output: (prev?.output ?? 0) + (usage.output_tokens ?? 0),
      });
    },
    settleRun(runId, endUsage) {
      if (settledRuns.has(runId)) return;
      if (endUsage && hasTokens(endUsage)) {
        runUsage.set(runId, {
          input: endUsage.input_tokens ?? 0,
          output: endUsage.output_tokens ?? 0,
        });
      }
      const run = runUsage.get(runId);
      if (!run) return;
      settledRuns.add(runId);
      runUsage.delete(runId);
      absorb(run);
    },
    finish() {
      for (const run of runUsage.values()) absorb(run);
      runUsage.clear();
      return total;
    },
  };
}

export async function consumeAgentStream(
  eventStream: AsyncIterable<StreamEvent>,
  cb: EmitterCallbacks,
  isAborted: () => boolean,
): Promise<void> {
  const usageAcc = makeUsageAccumulator();
  // run_id（on_tool_* 事件的唯一标识）→ 模型 tool_call id 关联表：
  // 终态回调用模型 id 对齐工具执行 chunk 与 ToolCallBlock 键
  const runIdToCallId = new Map<string, string>();
  // 本流已发射 onToolCall 的 id 集：on_tool_end 载荷 tool_call_id 只在确系
  // 已发射 id 时才优先采信（未发射过的陌生 id 不具备块归属，采信会让终态
  // chunk 对不上任何 call chunk——chat.service 按未知 id 取块会静默丢弃）
  const emittedCallIds = new Set<string>();
  const emitToolCall = (
    call: Parameters<EmitterCallbacks["onToolCall"]>[0],
  ): void => {
    emittedCallIds.add(call.toolCallId);
    cb.onToolCall(call);
  };
  const pending: PendingToolCall[] = [];
  try {
    for await (const ev of eventStream) {
      if (ev.event === "on_chat_model_stream") {
        const chunk = ev.data?.chunk as ModelStreamChunk | undefined;
        if (!chunk) continue;
        emitModelChunk(chunk, cb);
        if (chunk.usage_metadata) {
          usageAcc.addStreamReport(String(ev.run_id), chunk.usage_metadata);
        }
      } else if (ev.event === "on_chat_model_end") {
        // usage 结算：end 聚合为该轮权威总值（覆盖流式累计），settledRuns
        // 保证同轮 stream/end 双报不双计；仅聚合上报的模型（T3-3 回退分支）
        // 在此首次入账
        usageAcc.settleRun(
          String(ev.run_id),
          (ev.data?.output as ModelStreamChunk | undefined)?.usage_metadata,
        );
        const toolCalls = (
          ev.data?.output as { tool_calls?: unknown } | undefined
        )?.tool_calls;
        if (!Array.isArray(toolCalls)) continue;
        for (const call of toolCalls as ToolCallShape[]) {
          if (
            !call ||
            typeof call.id !== "string" ||
            !call.id ||
            typeof call.name !== "string" ||
            !call.name
          ) {
            continue;
          }
          pending.push({
            id: call.id,
            name: call.name,
            argsJson: stableJson(call.args),
          });
          emitToolCall({
            toolCallId: call.id,
            toolName: call.name,
            args: call.args,
          });
        }
      } else if (ev.event === "on_tool_start") {
        const runId = String(ev.run_id);
        const name = String(ev.name);
        // 载荷归一（对象 args 原样；字符串 args 的 {input} 包裹解包），
        // 与模型发射的挂起项按 (name, args) 匹配——命中即登记 run_id →
        // 模型 id 映射并跳过重复发射；序列化 ToolCall 形态按 id 直配兜底
        const unwrapped = unwrapTracedInput(ev.data?.input);
        const serialized = serializedToolCallId(unwrapped);
        const matched = serialized
          ? pending.findIndex((item) => item.id === serialized)
          : pending.findIndex(
              (item) =>
                item.name === name && item.argsJson === stableJson(unwrapped),
            );
        if (matched >= 0) {
          runIdToCallId.set(runId, pending[matched].id);
          pending.splice(matched, 1);
        } else if (serialized) {
          runIdToCallId.set(runId, serialized);
        } else {
          emitToolCall({
            toolCallId: runId,
            toolName: name,
            args: unwrapped,
          });
        }
      } else if (ev.event === "on_tool_end") {
        const output = ev.data?.output;
        if (output instanceof Error) {
          cb.onToolError({
            toolCallId:
              runIdToCallId.get(String(ev.run_id)) ?? String(ev.run_id),
            error: output.message,
          });
        } else {
          // 终态 id 解析：载荷 ToolMessage.tool_call_id（模型 id 同源，挂起项
          // (name, args) 匹配失败——dist 细节——时的旁路关联）仅在已发射时
          // 采信；否则回退 run_id 关联映射，再回退 run_id 本身
          const payloadId = payloadToolCallId(output);
          cb.onToolResult({
            toolCallId:
              payloadId !== undefined && emittedCallIds.has(payloadId)
                ? payloadId
                : (runIdToCallId.get(String(ev.run_id)) ?? String(ev.run_id)),
            output: stringifyOutput(output),
          });
        }
      } else if (ev.event === "on_tool_error") {
        cb.onToolError({
          toolCallId: runIdToCallId.get(String(ev.run_id)) ?? String(ev.run_id),
          error: String(ev.data?.error ?? ""),
        });
      }
    }
    cb.onFinish(usageAcc.finish());
  } catch (error) {
    // 用户中止不是错误：静默保留已生成内容（对齐 runChatStream 中止口径，见 run-chat-stream.ts）
    if (isAborted()) return;
    // 错误路径转发已结算 usage（终审 T9a）：保险丝触顶等截断场景旧引擎
    // finish part 带真实 totalUsage，直接丢弃会让监控 DB 缺 token 统计；
    // finish() 幂等（runUsage 清空后二调原值返回），此处补调即余额兜底
    // 结算；onFinish(undefined) 与旧引擎无 usage 不产块口径一致
    cb.onFinish(usageAcc.finish());
    cb.onError(error);
  }
}

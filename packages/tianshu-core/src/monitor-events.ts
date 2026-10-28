/**
 * 监控埋点（token/工具监控 spec §4；MO 批 2026-10-27 收编 @tianshu/core
 * 自 mirror electron/domains/ai/monitor/monitor-events.ts——mirror 原位
 * re-export）：fire-and-forget 写入、静默吞错（埋点属可观测性，失败绝不
 * 影响主流程）、PrismaLike 缺席（纯函数测试/独立形态）静默跳过——
 * skill-stats 先例同款。
 */
import type { MessageBlock } from "@tianshu/protocol";

export type MonitorScene = "chat" | "graph" | "automation";

export interface LlmCallEventInput {
  userId?: number | null;
  scene: MonitorScene;
  modelId?: number | null;
  sessionId?: number | null;
  graphId?: number | null;
  inputTokens: number;
  outputTokens: number;
  durationMs?: number | null;
}

export interface ToolCallEventInput {
  userId?: number | null;
  scene: MonitorScene;
  toolName: string;
  state: "done" | "denied" | "error";
  durationMs?: number | null;
  sessionId?: number | null;
}

/** prisma delegate 结构子集（注入 stub/真实客户端均可，skill-stats 先例） */
export interface LlmCallPrismaLike {
  llmCallEvent: {
    create(args: {
      data: Omit<LlmCallEventInput, "scene"> & { scene: string };
    }): Promise<unknown>;
  };
}

export interface ToolCallPrismaLike {
  toolCallEvent: {
    create(args: {
      data: Omit<ToolCallEventInput, "scene"> & { scene: string };
    }): Promise<unknown>;
  };
}

/** blocks 内 usage 块提取；缺失（错误轮次/中止）返回 null（spec §4.1 #1） */
export function usageFromBlocks(
  blocks: MessageBlock[],
): { input: number; output: number } | null {
  const usage = blocks.find(
    (b): b is Extract<MessageBlock, { type: "usage" }> => b.type === "usage",
  );
  return usage ? { input: usage.input, output: usage.output } : null;
}

export async function recordLlmCall(
  prisma: LlmCallPrismaLike | undefined,
  event: LlmCallEventInput,
): Promise<void> {
  if (!prisma) {
    return;
  }
  try {
    await prisma.llmCallEvent.create({ data: event });
  } catch {
    // 埋点属可观测性，静默吞错（core 零依赖无 Log——失败绝不影响主流程）
  }
}

export async function recordToolCall(
  prisma: ToolCallPrismaLike | undefined,
  event: ToolCallEventInput,
): Promise<void> {
  if (!prisma) {
    return;
  }
  try {
    await prisma.toolCallEvent.create({ data: event });
  } catch {
    // 同上：静默吞错
  }
}

/** graph trace 行结构子集（TraceEntry 的聚合所需列） */
export interface GraphTraceLike {
  name: string;
  durationMs: number;
  tokens?: { promptTokens: number; completionTokens: number };
  toolCalls?: Array<{ name: string; ok: boolean; durationMs: number }>;
}

/** trace → 监控事件（纯函数，spec §4.1 #4）：带 tokens 节点逐个一行
 * llm 事件（modelId 恒 null：trace 无模型归属），toolCalls 逐条工具事件 */
export function buildGraphMonitorEvents(input: {
  graphId: number;
  userId?: number | null;
  sessionId?: number | null;
  trace: GraphTraceLike[];
}): { llm: LlmCallEventInput[]; tools: ToolCallEventInput[] } {
  const llm: LlmCallEventInput[] = [];
  const tools: ToolCallEventInput[] = [];
  for (const entry of input.trace) {
    if (entry.tokens) {
      llm.push({
        userId: input.userId,
        scene: "graph",
        modelId: null,
        sessionId: input.sessionId,
        graphId: input.graphId,
        inputTokens: entry.tokens.promptTokens,
        outputTokens: entry.tokens.completionTokens,
        durationMs: entry.durationMs,
      });
    }
    for (const call of entry.toolCalls ?? []) {
      tools.push({
        userId: input.userId,
        scene: "graph",
        toolName: call.name,
        state: call.ok ? "done" : "error",
        durationMs: call.durationMs,
        sessionId: input.sessionId,
      });
    }
  }
  return { llm, tools };
}

/** graph 收尾一次性写入（recordLlmCall/recordToolCall 已各自吞错） */
export async function recordGraphMonitorEvents(
  prisma: (LlmCallPrismaLike & ToolCallPrismaLike) | undefined,
  input: Parameters<typeof buildGraphMonitorEvents>[0],
): Promise<void> {
  if (!prisma) {
    return;
  }
  const { llm, tools } = buildGraphMonitorEvents(input);
  await Promise.all([
    ...llm.map((event) => recordLlmCall(prisma, event)),
    ...tools.map((event) => recordToolCall(prisma, event)),
  ]);
}

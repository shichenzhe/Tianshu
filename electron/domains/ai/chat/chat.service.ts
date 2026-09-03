import { ipcMain, type WebContents } from "electron";
import { streamText } from "ai";
import type { LanguageModel } from "ai";
import prisma from "../../../commons/prisma-client";
import { parseBlocks, serializeBlocks, type MessageBlock } from "./blocks";
import { mergeParams, type ChatModelParams } from "./param-merge";
import { truncateHistory } from "./history-truncate";
import { classifyError } from "./error-classify";
import { createLanguageModel } from "../provider/provider-factory";
import { SessionRepository, type AppendMessageParams } from "./session.repo";
import type {
  ChatSendParams,
  ChatStreamChunk,
} from "../../../../src-react/domains/ai/api/chat.api";

type AssistantRow = NonNullable<
  Awaited<ReturnType<typeof prisma.assistant.findFirst>>
>;

export interface ChatStreamOptions {
  model: LanguageModel;
  system?: string;
  /** 历史消息（含本次用户消息；函数内部截断并抽取 text 为 content） */
  history: Array<{ role: "user" | "assistant"; blocks: string }>;
  params: ChatModelParams;
  contextWindow?: number;
  abortSignal?: AbortSignal;
  onChunk?: (chunk: ChatStreamChunk) => void;
}

export interface ChatStreamResult {
  blocks: MessageBlock[];
  errorCode?: string;
  errorMessage?: string;
}

/**
 * 流式执行核心（可注入 model，供单测）
 */
export async function runChatStream(
  options: ChatStreamOptions,
): Promise<ChatStreamResult> {
  let text = "";
  let thinking = "";
  let usage: { input: number; output: number } | undefined;
  let errorCode: string | undefined;
  let errorMessage: string | undefined;

  const messages = truncateHistory(options.history, options.contextWindow).map(
    (m) => ({
      role: m.role,
      content: parseBlocks(m.blocks)
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("\n"),
    }),
  );

  const result = streamText({
    model: options.model,
    system: options.system,
    messages,
    temperature: options.params.temperature,
    topP: options.params.topP,
    maxOutputTokens: options.params.maxTokens,
    abortSignal: options.abortSignal,
  });

  try {
    for await (const part of result.stream) {
      if (part.type === "text-delta") {
        text += part.text;
        options.onChunk?.({ type: "text-delta", text: part.text });
      } else if (part.type === "reasoning-delta") {
        thinking += part.text;
        options.onChunk?.({ type: "reasoning-delta", text: part.text });
      } else if (part.type === "finish") {
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

  const blocks: MessageBlock[] = [];
  if (thinking) {
    blocks.push({ type: "thinking", text: thinking });
  }
  if (text) {
    blocks.push({ type: "text", text });
  }
  if (usage) {
    blocks.push({ type: "usage", input: usage.input, output: usage.output });
  }
  return { blocks, errorCode, errorMessage };
}

export default class ChatService {
  private aborts = new Map<number, AbortController>();

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
   * 通用编排：解析模型/助手 → 合并参数 → 截断历史 → 流式执行 → 持久化
   * （AbortController 由调用方在首个 await 前注册并传入，此处负责 finally 清理）
   */
  private async streamAndPersist(
    sessionId: number,
    abort: AbortController,
    sender?: WebContents,
    overrides?: ChatModelParams,
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
        system: assistantRow?.systemPrompt,
        history,
        contextWindow: modelRow.contextWindow ?? undefined,
        params: merged,
        abortSignal: abort.signal,
        onChunk: (chunk) => this.emit(sender, sessionId, chunk),
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
      }
    } finally {
      this.aborts.delete(sessionId);
    }
  }

  stop(sessionId: number): void {
    this.aborts.get(sessionId)?.abort();
  }
}

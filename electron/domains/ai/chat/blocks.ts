/**
 * 消息 blocks（对齐 UIMessage 形态）
 * tool_call 块由 P1 agent loop 写入；状态词表与 ChatStreamChunk 的
 * tool-update.state 一致（六值），落库块恒为终态（done / denied / error）
 */
import type { ModelMessage } from "ai";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  text: string;
}

export interface UsageBlock {
  type: "usage";
  input: number;
  output: number;
}

export interface ToolCallBlock {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  state:
    "ready" | "awaiting-approval" | "running" | "done" | "denied" | "error";
  output?: unknown;
}

export type MessageBlock =
  TextBlock | ThinkingBlock | UsageBlock | ToolCallBlock;

/**
 * blocks 序列化为 message.blocks 列文本
 */
export function serializeBlocks(blocks: MessageBlock[]): string {
  return JSON.stringify(blocks);
}

/**
 * 按 type 校验块形状，缺必备字段的畸形块丢弃（历史数据容错）
 */
function isValidBlock(block: unknown): block is MessageBlock {
  if (typeof block !== "object" || block === null) {
    return false;
  }
  const b = block as Record<string, unknown>;
  switch (b.type) {
    case "text":
    case "thinking":
      return typeof b.text === "string";
    case "usage":
      return typeof b.input === "number" && typeof b.output === "number";
    case "tool_call":
      return typeof b.toolCallId === "string" && typeof b.toolName === "string";
    default:
      return false;
  }
}

/**
 * 解析 message.blocks；畸形输入返回空数组（历史数据容错）
 */
export function parseBlocks(json: string): MessageBlock[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isValidBlock);
  } catch {
    return [];
  }
}

/**
 * 历史回喂转换（P1）：blocks → SDK ModelMessage 序列。
 * - text 块归并为字符串 content（P0 行为不变；thinking/usage 不回喂）
 * - tool_call 块 → assistant content 内 tool-call 部分，紧随一条
 *   role:"tool" 消息携带 tool-result（续聊时模型可见自己上轮工具使用）
 * 纯函数，供 chat.service 与单测直接使用。
 */
export function blocksToModelMessages(
  blocks: MessageBlock[],
  role: "user" | "assistant" = "assistant",
): ModelMessage[] {
  const messages: ModelMessage[] = [];
  let parts: Array<
    | { type: "text"; text: string }
    | {
        type: "tool-call";
        toolCallId: string;
        toolName: string;
        input: unknown;
      }
  > = [];

  const flush = () => {
    if (parts.length === 0) {
      return;
    }
    const onlyText = parts.every((part) => part.type === "text");
    const content = onlyText
      ? parts.map((part) => (part as { text: string }).text).join("\n")
      : parts;
    messages.push({ role, content } as ModelMessage);
    parts = [];
  };

  for (const block of blocks) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "tool_call") {
      parts.push({
        type: "tool-call",
        toolCallId: block.toolCallId,
        toolName: block.toolName,
        input: block.args,
      });
      // tool-call 终结当前 assistant 消息，随后单独回喂 tool-result
      flush();
      messages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: block.toolCallId,
            toolName: block.toolName,
            output: {
              type: "text",
              value: typeof block.output === "string" ? block.output : "",
            },
          },
        ],
      });
    }
  }
  flush();
  return messages;
}

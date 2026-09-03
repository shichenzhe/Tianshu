/**
 * 消息 blocks（对齐 UIMessage 形态）
 * tool_call 块由 P1 agent loop 写入，此处仅定义类型
 */
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
  state: "input" | "output" | "error";
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

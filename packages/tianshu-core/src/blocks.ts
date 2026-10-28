/**
 * 消息 blocks（对齐 UIMessage 形态）
 * 块类型（TextBlock/ThinkingBlock/UsageBlock/ToolCallBlock/ImageBlock/
 * MessageBlock）已收编 @tianshu/protocol（共享 core 重构 RC-T1）；实现
 * （parseBlocks/serializeBlocks/blocksToModelMessages）随 @tianshu/core
 * 物理搬入本包（RC-T3），mirror 原位 electron/domains/ai/chat/blocks.ts
 * 改 re-export 兼容——老 import 链不变；tool_call 块由 P1 agent loop 写入；
 * 状态词表与 ChatStreamChunk 的 tool-update.state 一致（六值），落库块
 * 恒为终态（done / denied / error）。
 */
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { ImageBlock, MessageBlock } from "@tianshu/protocol";

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
    case "image":
      return typeof b.imagePath === "string" && typeof b.mime === "string";
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
 * 图片读取器：imagePath（相对数据根）→ dataUrl；读不到返回 null
 * （由调用方注入实现——blocks.ts 保持纯 Node 无 electron 依赖，测试可 stub）
 */
export type ImageDataUrlLoader = (imagePath: string) => Promise<string | null>;

/** 多模态图片 part（LangChain image_url 形态） */
type ImageUrlPart = { type: "image_url"; image_url: { url: string } };

/** 单条消息 content 的 part：文本或多模态图片 */
type ModelContentPart = { type: "text"; text: string } | ImageUrlPart;

/**
 * 图片+文本 part 归并为消息 content：纯文本时 join("\n") 归并字符串
 * （旧引擎单字符串形态），混有图片时保持 part 数组（多模态形态）。
 * flush 与 tool_call 分支共用，行为必须一致（终审 M-3 去重）
 */
function mergeTextPreamble(
  imageParts: ImageUrlPart[],
  parts: ModelContentPart[],
): string | ModelContentPart[] {
  const merged = [...imageParts, ...parts];
  const onlyText = merged.every((part) => part.type === "text");
  return onlyText
    ? merged.map((part) => (part as { text: string }).text).join("\n")
    : merged;
}

/**
 * 历史回喂转换（P1）：blocks → LangChain BaseMessage 序列（T3-3 换引擎）。
 * - text 块归并为字符串 content（纯文本时；thinking/usage 不回喂）
 * - image 块（多模态输入）经 loadImage 读盘转 image_url content block
 *   （LangChain 标准多模态形态），且**前置于文本**（Qwen-VL 系列惯例：
 *   视觉输入在指令前，小模型遵循更稳）；loader 缺席或读不到（文件被删）
 *   降级占位文本；assistant 消息不支持图片 block 同降级
 *   （T2 未测家 ollama/gemini 按标准形态传不短路，spec §6 实测记录）
 * - tool_call 块 → AIMessage.tool_calls + 紧随一条 ToolMessage 携带
 *   tool-result（续聊时模型可见自己上轮工具使用）
 * 读盘引入 async（依赖注入保持纯函数可测性），供 chat.service 与单测使用。
 */
export async function blocksToModelMessages(
  blocks: MessageBlock[],
  role: "user" | "assistant" = "assistant",
  loadImage?: ImageDataUrlLoader,
): Promise<BaseMessage[]> {
  const messages: BaseMessage[] = [];
  // 图片 part 单独累积，flush 时前置（多图保持相对序）
  let imageParts: ImageUrlPart[] = [];
  let parts: ModelContentPart[] = [];

  const flush = () => {
    if (imageParts.length === 0 && parts.length === 0) {
      return;
    }
    const content = mergeTextPreamble(imageParts, parts);
    messages.push(
      role === "user"
        ? new HumanMessage({ content })
        : new AIMessage({ content }),
    );
    imageParts = [];
    parts = [];
  };

  const imageFallbackText = (block: ImageBlock): string =>
    `[图片 ${block.name ?? block.imagePath} 已失效]`;

  for (const block of blocks) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      const dataUrl =
        role === "user" && loadImage ? await loadImage(block.imagePath) : null;
      if (dataUrl) {
        imageParts.push({ type: "image_url", image_url: { url: dataUrl } });
      } else {
        parts.push({ type: "text", text: imageFallbackText(block) });
      }
    } else if (block.type === "tool_call") {
      // tool_call 终结当前 assistant 消息（前导文本并入同条消息，
      // 对齐旧引擎 preamble+call 单消息形态），随后单独回喂 tool-result
      const preamble = mergeTextPreamble(imageParts, parts);
      messages.push(
        new AIMessage({
          content: preamble,
          tool_calls: [
            {
              id: block.toolCallId,
              name: block.toolName,
              args: block.args,
              type: "tool_call",
            },
          ],
        }),
      );
      imageParts = [];
      parts = [];
      messages.push(
        new ToolMessage({
          tool_call_id: block.toolCallId,
          name: block.toolName,
          content: typeof block.output === "string" ? block.output : "",
        }),
      );
    }
  }
  flush();
  return messages;
}

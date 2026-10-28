/**
 * 会话末条消息摘要纯函数（P1 未读角标批 spec §1.3）：message 行（blocks
 * JSON 文本）→ SessionLastMessage wire 摘要。基于既有 parseBlocks：
 * - kind 优先级 text > image > tool > empty（text 信息量最大优先，非块
 *   顺序优先）；thinking/usage 块不参与摘要
 * - text：全部 text 块文本 \n 拼接，超 SUMMARY_TEXT_LIMIT 截断加省略号
 * - image：text=""（「[图片]」文案由消费端本地化）
 * - tool：text=首个 tool_call 块的 toolName
 * - empty：有消息但无可摘要块（仅 thinking/usage 或坏 JSON/全畸形块）
 * 零 I/O 纯函数——渲染进程禁引包根入口（Node 侧模块聚合），经子路径
 * @tianshu/core/last-message 消费（plan-view-engine 先例）。
 */
import type { SessionLastMessage } from "@tianshu/protocol";
import { parseBlocks } from "./blocks";

/** text 摘要截断上限（字符数；超出截断加省略号——spec §1.3） */
export const SUMMARY_TEXT_LIMIT = 80;

/** 摘要输入：Prisma message 行的摘要相关列子集 */
export interface LastMessageInput {
  id: number;
  role: string;
  /** message.blocks 列（JSON 数组文本；坏 JSON/非数组由 parseBlocks 归 []） */
  blocks: string;
  /** 库内 Date 或 ISO 字符串；输出统一 ISO 字符串（wire 口径） */
  createdAt: Date | string;
}

/** 全部 text 块 \n 拼接，超上限截断加省略号 */
function joinText(blocks: ReturnType<typeof parseBlocks>): string {
  const joined = blocks
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n");
  return joined.length > SUMMARY_TEXT_LIMIT
    ? `${joined.slice(0, SUMMARY_TEXT_LIMIT)}…`
    : joined;
}

/** message 行 → 末条消息摘要（kind 优先级 text > image > tool > empty） */
export function summarizeLastMessage(
  input: LastMessageInput,
): SessionLastMessage {
  const blocks = parseBlocks(input.blocks);
  const hasText = blocks.some((b) => b.type === "text");
  const kind: SessionLastMessage["kind"] = hasText
    ? "text"
    : blocks.some((b) => b.type === "image")
      ? "image"
      : blocks.some((b) => b.type === "tool_call")
        ? "tool"
        : "empty";
  const text =
    kind === "text"
      ? joinText(blocks)
      : kind === "tool"
        ? (blocks.find((b) => b.type === "tool_call") as { toolName: string })
            .toolName
        : "";
  return {
    id: input.id,
    role: input.role,
    kind,
    text,
    createdAt:
      input.createdAt instanceof Date
        ? input.createdAt.toISOString()
        : input.createdAt,
  };
}

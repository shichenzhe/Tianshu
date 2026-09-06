/**
 * 产物面板文件派生（纯函数）：
 * - 产物文件 = write_file tool_call(state=done) 的 args.path
 * - 工作空间文件 = user 消息 text 块的 [引用文件 x] 行首前缀（注入格式固定）
 * - 流式期间合并 streams 的 tools（running→writing / done→written）
 * - 同 path 跨组去重（取源消息最新者），按 messageId 降序（流式 -1 置顶）
 */
import { parseBlocks } from "../model/blocks";
import type { MessageRecord } from "../../api/session.api";
import type { ToolStreamMap } from "../store/chat.store";

export interface SessionFile {
  path: string;
  group: "artifact" | "workspace";
  status: "written" | "writing";
  messageId: number;
}

/** 行首行尾锚定（消息为多文件前缀逐段拼接，各占一行） */
const REFERENCE_LINE = /^\[引用文件 (.+?)\]$/gm;

/** 流式工具态 → 收录结果；denied/error/args 缺失返回 null */
function streamEntryToFiles(entry: {
  toolName: string;
  args?: unknown;
  state: string;
}): { path: string; status: "written" | "writing" } | null {
  if (entry.toolName !== "write_file") return null;
  const path = (entry.args as { path?: unknown } | undefined)?.path;
  if (typeof path !== "string" || !path.trim()) return null;
  if (entry.state === "done") return { path, status: "written" };
  if (entry.state === "denied" || entry.state === "error") return null;
  return { path, status: "writing" };
}

export function deriveSessionFiles(
  messages: MessageRecord[],
  tools?: ToolStreamMap,
): SessionFile[] {
  const byPath = new Map<string, SessionFile>();
  const add = (file: SessionFile) => {
    const existing = byPath.get(file.path);
    // 流式条目(-1)视为最新，覆盖历史；历史之间取源消息 id 较大者
    if (
      !existing ||
      file.messageId === -1 ||
      (existing.messageId !== -1 && file.messageId >= existing.messageId)
    ) {
      byPath.set(file.path, file);
    }
  };

  for (const message of messages) {
    if (message.role === "system") continue;
    for (const block of parseBlocks(message.blocks)) {
      if (block.type === "tool_call" && block.toolName === "write_file") {
        const parsed = streamEntryToFiles(block);
        if (parsed && block.state === "done") {
          add({
            path: parsed.path,
            group: "artifact",
            status: "written",
            messageId: message.id,
          });
        }
      }
      if (block.type === "text" && message.role === "user") {
        for (const match of block.text.matchAll(REFERENCE_LINE)) {
          add({
            path: match[1],
            group: "workspace",
            status: "written",
            messageId: message.id,
          });
        }
      }
    }
  }

  if (tools) {
    for (const id of tools.order) {
      const entry = tools.map[id];
      if (!entry) continue;
      const parsed = streamEntryToFiles(entry);
      if (parsed) {
        add({
          path: parsed.path,
          group: "artifact",
          status: parsed.status,
          messageId: -1,
        });
      }
    }
  }

  // 流式(-1)置顶；其余按源消息新→旧；同 messageId 按路径字典序稳定输出
  const sortKey = (m: number) => (m === -1 ? Number.MAX_SAFE_INTEGER : m);
  return [...byPath.values()].sort(
    (a, b) =>
      sortKey(b.messageId) - sortKey(a.messageId) ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
}

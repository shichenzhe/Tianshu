/**
 * 产物面板文件派生（纯函数）：
 * - 产物文件 = write_file tool_call(state=done) 的 args.path
 * - 工作空间文件 = user 消息 text 块的 [引用文件 x] 行首前缀（注入格式固定）
 * - 流式期间合并 streams 的 tools（running→writing / done→written）
 * - 同 path 跨组去重（取源消息最新者），按 messageId 降序（流式 -1 置顶）
 */
import { parseBlocks, type MessageBlock } from "../model/blocks";
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

/** 同 path 去重收录：流式条目(-1)覆盖历史；历史之间取源消息 id 较大者 */
function addFile(byPath: Map<string, SessionFile>, file: SessionFile): void {
  const existing = byPath.get(file.path);
  if (
    !existing ||
    file.messageId === -1 ||
    (existing.messageId !== -1 && file.messageId >= existing.messageId)
  ) {
    byPath.set(file.path, file);
  }
}

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

/** 单条消息中 write_file(state=done) 块 → 产物文件条目 */
function collectWriteFiles(
  message: MessageRecord,
  blocks: MessageBlock[],
): SessionFile[] {
  if (message.role === "system") return [];
  const files: SessionFile[] = [];
  for (const block of blocks) {
    if (block.type !== "tool_call" || block.toolName !== "write_file") continue;
    const parsed = streamEntryToFiles(block);
    if (!parsed || block.state !== "done") continue;
    files.push({
      path: parsed.path,
      group: "artifact",
      status: "written",
      messageId: message.id,
    });
  }
  return files;
}

/** 单条消息中 user 文本块的 [引用文件 x] 行 → 工作空间文件条目 */
function collectRefFiles(
  message: MessageRecord,
  blocks: MessageBlock[],
): SessionFile[] {
  if (message.role !== "user") return [];
  const files: SessionFile[] = [];
  for (const block of blocks) {
    if (block.type !== "text") continue;
    for (const match of block.text.matchAll(REFERENCE_LINE)) {
      files.push({
        path: match[1],
        group: "workspace",
        status: "written",
        messageId: message.id,
      });
    }
  }
  return files;
}

/** 单条消息扫描收集：产物 + 工作空间文件 */
function scanMessageFiles(
  message: MessageRecord,
  byPath: Map<string, SessionFile>,
): void {
  const blocks = parseBlocks(message.blocks);
  for (const file of collectWriteFiles(message, blocks)) {
    addFile(byPath, file);
  }
  for (const file of collectRefFiles(message, blocks)) {
    addFile(byPath, file);
  }
}

/** 流式工具合并：write_file running/done → 置顶条目（messageId=-1） */
function mergeStreamTools(
  tools: ToolStreamMap,
  byPath: Map<string, SessionFile>,
): void {
  for (const id of tools.order) {
    const entry = tools.map[id];
    if (!entry) continue;
    const parsed = streamEntryToFiles(entry);
    if (!parsed) continue;
    addFile(byPath, {
      path: parsed.path,
      group: "artifact",
      status: parsed.status,
      messageId: -1,
    });
  }
}

/** 排序：流式(-1)置顶；其余按源消息新→旧；同 messageId 按路径字典序稳定输出 */
function sortByPinned(files: SessionFile[]): SessionFile[] {
  const sortKey = (m: number) => (m === -1 ? Number.MAX_SAFE_INTEGER : m);
  return [...files].sort(
    (a, b) =>
      sortKey(b.messageId) - sortKey(a.messageId) ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
}

export function deriveSessionFiles(
  messages: MessageRecord[],
  tools?: ToolStreamMap,
): SessionFile[] {
  const byPath = new Map<string, SessionFile>();
  for (const message of messages) {
    scanMessageFiles(message, byPath);
  }
  if (tools) {
    mergeStreamTools(tools, byPath);
  }
  return sortByPinned([...byPath.values()]);
}

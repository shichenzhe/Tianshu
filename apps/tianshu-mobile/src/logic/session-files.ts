/**
 * 会话产物文件派生（MR-T6）——桌面
 * src-react/domains/ai/chat/lib/artifacts.ts 移植（spec §3.6）：
 * - 产物文件 = write_file tool_call(state=done) 的 args.path
 * - 工作空间文件 = user 消息 text 块的 [引用文件 x] 行首前缀
 * - 流式合并 live.tools（running→writing / done→written，messageId=-1 置顶）
 * - 同 path 跨组去重（取源消息最新者），按 messageId 降序
 * 适配差异：入参 blocks 已 parse（mobile history 即 parse 产物）；流式
 * 面字段名 toolOrder/tools（RemoteStreamState）。
 */
import type { MessageBlock } from "./blocks";
import type { RemoteStreamState } from "./remote-stream";

export interface SessionFile {
  path: string;
  group: "artifact" | "workspace";
  status: "written" | "writing";
  messageId: number;
}

export interface HistoryMessage {
  id: number;
  role: string;
  blocks: MessageBlock[];
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

/** 工具态 → 收录结果；denied/error/args 缺失返回 null */
function entryToFiles(entry: {
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

/** 单条消息：write_file(done) 产物 + user [引用文件] 行 */
function scanMessage(
  message: HistoryMessage,
  byPath: Map<string, SessionFile>,
): void {
  for (const block of message.blocks) {
    if (block.type !== "tool_call") {
      if (block.type === "text" && message.role === "user") {
        for (const match of block.text.matchAll(REFERENCE_LINE)) {
          addFile(byPath, {
            path: match[1],
            group: "workspace",
            status: "written",
            messageId: message.id,
          });
        }
      }
      continue;
    }
    if (block.state !== "done") continue;
    const parsed = entryToFiles(block);
    if (!parsed) continue;
    addFile(byPath, {
      path: parsed.path,
      group: "artifact",
      status: "written",
      messageId: message.id,
    });
  }
}

/** 流式工具合并：write_file running/done → 置顶条目（messageId=-1） */
function mergeLiveTools(
  live: RemoteStreamState,
  byPath: Map<string, SessionFile>,
): void {
  for (const id of live.toolOrder) {
    const entry = live.tools[id];
    if (!entry) continue;
    const parsed = entryToFiles(entry);
    if (!parsed) continue;
    addFile(byPath, {
      path: parsed.path,
      group: "artifact",
      status: parsed.status,
      messageId: -1,
    });
  }
}

/** 排序：流式(-1)置顶；其余源消息新→旧；同 id 路径字典序稳定 */
function sortByPinned(files: SessionFile[]): SessionFile[] {
  const sortKey = (m: number) => (m === -1 ? Number.MAX_SAFE_INTEGER : m);
  return [...files].sort(
    (a, b) =>
      sortKey(b.messageId) - sortKey(a.messageId) ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
}

export function deriveSessionFiles(
  history: HistoryMessage[],
  live?: RemoteStreamState | null,
): SessionFile[] {
  const byPath = new Map<string, SessionFile>();
  for (const message of history) {
    scanMessage(message, byPath);
  }
  if (live) {
    mergeLiveTools(live, byPath);
  }
  return sortByPinned([...byPath.values()]);
}

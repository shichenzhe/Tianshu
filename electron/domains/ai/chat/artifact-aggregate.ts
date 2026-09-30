/**
 * 全局产物聚合（资料库「本地产物」视图）：跨会话扫描 message.blocks 中
 * write_file tool_call(state=done) 的产物记录，同文件（resolve 后绝对
 * 路径相同）跨会话去重取最新写入。纯 Node 实现（禁止 import electron），
 * vitest 可直接测试——同 workspace-files.ts 约定。
 */
import path from "node:path";

/** 聚合输入的消息行最小形状（repo 拉取时 join session 裁剪传入） */
export interface ArtifactMessageRow {
  id: number;
  sessionId: number;
  /** 所属会话的工作空间 id（相对路径 resolve 的基） */
  workspaceId: number;
  role: string;
  /** MessageBlock[] 的 JSON 列文本 */
  blocks: string;
  createdAt: Date | string;
}

/** 工作空间来源（name 供展示；directoryPath 供相对路径 resolve） */
export interface ArtifactWorkspaceRow {
  name: string;
  directoryPath: string | null;
}

/** 聚合产物条目（已删除文件由 repo 层 stat 过滤，此处不感知） */
export interface AggregatedArtifact {
  /** resolve 后绝对路径（去重 key） */
  path: string;
  /** write_file 原始 path（前端 workspace:readFile/revealFile 消费） */
  relPath: string;
  name: string;
  workspaceId: number;
  workspaceName: string;
  sessionId: number;
  sessionTitle: string;
  /** 源消息写入时间（ISO） */
  writtenAt: string;
}

/** tool_call 块最小形状（畸形块容错：缺字段即跳过） */
interface ToolCallLike {
  type?: unknown;
  toolName?: unknown;
  args?: { path?: unknown } | undefined;
  state?: unknown;
}

function toMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/**
 * 单条消息 → 产物路径列表（write_file + state=done + 非空字符串 path）；
 * system 消息、畸形 JSON/块一律跳过不抛
 */
function extractPaths(row: ArtifactMessageRow): string[] {
  if (row.role === "system") return [];
  let blocks: unknown;
  try {
    blocks = JSON.parse(row.blocks);
  } catch {
    return [];
  }
  if (!Array.isArray(blocks)) return [];
  const paths: string[] = [];
  for (const block of blocks as ToolCallLike[]) {
    const p = block?.args?.path;
    if (
      block?.type === "tool_call" &&
      block.toolName === "write_file" &&
      block.state === "done" &&
      typeof p === "string" &&
      p.trim()
    ) {
      paths.push(p);
    }
  }
  return paths;
}

/**
 * 主聚合：消息（时间序任意）+ 工作空间表 + 会话标题表 → 去重产物列表
 * （写入时间降序）。相对路径以所属工作空间 directoryPath 为基；工作空间
 * 无目录时跳过（绝对路径不受影响）
 */
export function aggregateArtifacts(
  messages: ArtifactMessageRow[],
  workspaces: Map<number, ArtifactWorkspaceRow>,
  sessionTitles: Map<number, string>,
): AggregatedArtifact[] {
  // key = 绝对路径 → 最新条目（时间较后者整体覆盖）
  const byPath = new Map<string, { ms: number; entry: AggregatedArtifact }>();
  for (const row of messages) {
    for (const relPath of extractPaths(row)) {
      const ws = workspaces.get(row.workspaceId);
      const isAbsolute = path.isAbsolute(relPath);
      if (!isAbsolute && !ws?.directoryPath) continue;
      const absPath = isAbsolute
        ? path.resolve(relPath)
        : path.resolve(ws!.directoryPath!, relPath);
      const entry: AggregatedArtifact = {
        path: absPath,
        relPath,
        name: path.basename(absPath),
        workspaceId: row.workspaceId,
        workspaceName: ws?.name ?? "",
        sessionId: row.sessionId,
        sessionTitle: sessionTitles.get(row.sessionId) ?? "",
        writtenAt:
          row.createdAt instanceof Date
            ? row.createdAt.toISOString()
            : new Date(row.createdAt).toISOString(),
      };
      const ms = toMs(row.createdAt);
      const existing = byPath.get(absPath);
      if (!existing || ms >= existing.ms) {
        byPath.set(absPath, { ms, entry });
      }
    }
  }
  return [...byPath.values()]
    .sort((a, b) => b.ms - a.ms)
    .map((item) => item.entry);
}

/**
 * 备份决策纯函数层（SP4 spec §3）：快照命名（内容寻址）、manifest 追加、
 * 配额 LRU 淘汰选择与 orphan 快照判定。无 I/O，Vitest 直测。
 * totalSize 按条目求和——共享快照时保守高估（配额略提前触发，方向安全）。
 */
import { createHash } from "node:crypto";

/** 单文件备份上限（WorkBuddy 同构语义） */
export const BACKUP_FILE_LIMIT = 100 * 1024 * 1024;
/** 目录预估计数上限（达限即停——≥ 阈值即触发，无需精确数） */
export const ESTIMATE_COUNT_LIMIT = 10000;

/** manifest 条目：原路径 + 快照名 + 备份时间戳(ms) + 字节 */
export interface BackupEntry {
  path: string;
  hash: string;
  at: number;
  size: number;
}

/** 快照文件名 = sha256(content) 前 32 hex（内容寻址，同内容天然去重） */
export function snapshotName(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 32);
}

/** manifest 追加（不可变——不去重：同内容多时间点各记一行，LRU 需要最新 at） */
export function appendEntry(
  entries: BackupEntry[],
  entry: BackupEntry,
): BackupEntry[] {
  return [...entries, entry];
}

/** 全局已用字节 = 条目 size 之和 */
export function totalSize(entries: BackupEntry[]): number {
  return entries.reduce((sum, e) => sum + e.size, 0);
}

/** LRU 淘汰选择：按 at 升序累计，返回需删除条目（至总量 ≤ maxBytes） */
export function selectEvictions(
  entries: BackupEntry[],
  maxBytes: number,
): BackupEntry[] {
  if (totalSize(entries) <= maxBytes) return [];
  const evicted: BackupEntry[] = [];
  let size = totalSize(entries);
  for (const e of [...entries].sort((a, b) => a.at - b.at)) {
    if (size <= maxBytes) break;
    evicted.push(e);
    size -= e.size;
  }
  return evicted;
}

/** 淘汰条目中 hash 不再被剩余条目引用的（→ 可删快照文件） */
export function orphanedHashes(
  remaining: BackupEntry[],
  evicted: BackupEntry[],
): string[] {
  const live = new Set(remaining.map((e) => e.hash));
  return [...new Set(evicted.map((e) => e.hash))].filter((h) => !live.has(h));
}

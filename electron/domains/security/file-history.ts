/**
 * 文件历史备份服务（SP4 spec §4）：write_file 覆盖前 / delete_file 永久
 * 删除前的内容寻址快照。目录：rootDir/<sessionId>/{manifest.json, <sha256-32>}。
 * 快照与 manifest 均临时名 + rename 原子落盘；manifest 损坏丢弃重建。
 * 配额 LRU 跨会话全局淘汰（总量按条目 size 求和，共享快照保守高估）。
 * fail-open：一切异常以 { ok:false, reason } 返回，调用方决定审计与是否继续。
 */
import fsp from "node:fs/promises";
import path from "node:path";
import Log from "../../commons/Log";
import {
  appendEntry,
  BACKUP_FILE_LIMIT,
  ESTIMATE_COUNT_LIMIT,
  orphanedHashes,
  selectEvictions,
  snapshotName,
  type BackupEntry,
} from "./backup-policy";

export type BackupFileResult =
  { ok: true; size: number } | { ok: false; reason: string };

/** manifest 读：损坏/缺失返回 []（保守丢弃重建） */
async function readManifest(sessionDir: string): Promise<BackupEntry[]> {
  try {
    const raw = await fsp.readFile(
      path.join(sessionDir, "manifest.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as BackupEntry[]) : [];
  } catch {
    return [];
  }
}

/** 临时名 + rename 原子写（单写者主进程，tmp 名固定无并发） */
async function atomicWrite(file: string, data: string | Buffer): Promise<void> {
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

/**
 * 批量预估（模块级函数，无状态）：walk 计数，达 ESTIMATE_COUNT_LIMIT 即停。
 * 根为文件计 1，不存在计 0。
 */
export async function countFilesForEstimate(root: string): Promise<number> {
  const st = await fsp.stat(root).catch(() => null);
  if (st === null) return 0;
  if (st.isFile()) return 1;
  let count = 0;
  const stack = [root];
  while (stack.length > 0 && count < ESTIMATE_COUNT_LIMIT) {
    const cur = stack.pop() as string;
    const entries = await fsp
      .readdir(cur, { withFileTypes: true })
      .catch(() => []);
    for (const ent of entries) {
      if (count >= ESTIMATE_COUNT_LIMIT) break;
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile()) count += 1;
    }
  }
  return count;
}

/** 跨会话收集非空 manifest（配额范围 = rootDir 全部会话目录） */
async function collectSessions(
  rootDir: string,
): Promise<{ dir: string; entries: BackupEntry[] }[]> {
  const sids = await fsp.readdir(rootDir).catch(() => [] as string[]);
  const perSession: { dir: string; entries: BackupEntry[] }[] = [];
  for (const sid of sids) {
    const dir = path.join(rootDir, sid);
    const entries = await readManifest(dir);
    if (entries.length > 0) perSession.push({ dir, entries });
  }
  return perSession;
}

export class FileHistoryService {
  constructor(
    private readonly rootDir: string,
    private readonly getMaxBytes: () => number,
  ) {}

  /** 覆盖/永久删除前调用：>100MB 或非文件 skip；成功 → 落快照 + manifest + 配额 */
  async backupFile(
    absPath: string,
    sessionId: number,
  ): Promise<BackupFileResult> {
    try {
      const stat = await fsp.stat(absPath);
      if (!stat.isFile()) return { ok: false, reason: "not-file" };
      if (stat.size > BACKUP_FILE_LIMIT) {
        return { ok: false, reason: "oversize" };
      }
      const content = await fsp.readFile(absPath);
      const hash = snapshotName(content);
      const dir = path.join(this.rootDir, String(sessionId));
      await fsp.mkdir(dir, { recursive: true });
      await this.ensureSnapshot(dir, hash, content);
      await this.recordEntry(dir, absPath, hash, stat.size);
      await this.enforceNow();
      return { ok: true, size: stat.size };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      Log.error(`文件备份失败 absPath=${absPath} reason=${reason}`);
      return { ok: false, reason };
    }
  }

  /** 快照落盘（内容寻址：同 hash 已存在即复用，不重复写） */
  private async ensureSnapshot(
    dir: string,
    hash: string,
    content: Buffer,
  ): Promise<void> {
    const snap = path.join(dir, hash);
    const exists = await fsp.stat(snap).then(
      () => true,
      () => false,
    );
    if (!exists) await atomicWrite(snap, content);
  }

  /** manifest 原子追加一行备份条目 */
  private async recordEntry(
    dir: string,
    absPath: string,
    hash: string,
    size: number,
  ): Promise<void> {
    const next = appendEntry(await readManifest(dir), {
      path: absPath,
      hash,
      at: Date.now(),
      size,
    });
    await atomicWrite(path.join(dir, "manifest.json"), JSON.stringify(next));
  }

  /** 配额 LRU：跨会话收集全部 manifest → 淘汰最旧 → 写回剩余 → 删 orphan 快照 */
  async enforceNow(): Promise<void> {
    try {
      const perSession = await collectSessions(this.rootDir);
      const merged = perSession.flatMap((s) => s.entries);
      const evicted = selectEvictions(merged, this.getMaxBytes());
      if (evicted.length === 0) return;
      const evictSet = new Set(evicted);
      const orphans = orphanedHashes(
        merged.filter((e) => !evictSet.has(e)),
        evicted,
      );
      await this.writeBackManifests(perSession, evictSet);
      await this.removeOrphanSnapshots(orphans, perSession);
    } catch (e) {
      Log.error("备份配额清理失败", e);
    }
  }

  /** 写回淘汰后剩余条目（仅条目有变化的会话） */
  private async writeBackManifests(
    perSession: { dir: string; entries: BackupEntry[] }[],
    evictSet: Set<BackupEntry>,
  ): Promise<void> {
    for (const { dir, entries } of perSession) {
      const rest = entries.filter((e) => !evictSet.has(e));
      if (rest.length !== entries.length) {
        await atomicWrite(
          path.join(dir, "manifest.json"),
          JSON.stringify(rest),
        );
      }
    }
  }

  /**
   * 删 orphan 快照：按"该会话 manifest 曾含此 hash"定位会话目录——
   * 共享快照在各会话目录独立成文件，只删本会话内不再引用的那份。
   */
  private async removeOrphanSnapshots(
    orphans: string[],
    perSession: { dir: string; entries: BackupEntry[] }[],
  ): Promise<void> {
    for (const hash of orphans) {
      for (const { dir, entries } of perSession) {
        if (entries.some((e) => e.hash === hash)) {
          await fsp.rm(path.join(dir, hash), { force: true });
        }
      }
    }
  }
}

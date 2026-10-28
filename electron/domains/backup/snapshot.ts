/**
 * 备份快照装配（spec 2026-10-27 §4）：db 在线快照（better-sqlite3 .backup()，
 * 单开连接不打扰运行中 Prisma）+ 资产目录收集 → tar.gz（ustar-tar）→
 * sha256 + BackupCreateRequest meta。快照函数注入化：vitest（node ABI）
 * 不可加载 better-sqlite3，替身注入（保留策略批先例）。
 * 排除项（logs/file-history 等）按构造保证：只收 allowlist 资产目录 +
 * database + .jwt-secret，其余再生产物天然不进档。
 */
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import {
  attachmentsDir,
  databaseDir,
  jwtSecretPath,
  libraryDir,
  projectsDir,
  skillsDir,
  workflowAssetsDir,
} from "../../commons/paths";
import { Constants } from "../../Constants";
import {
  BACKUP_CHUNK_BYTES,
  type BackupCreateRequest,
} from "@tianshu/protocol";
import { packTarGz, type TarEntry } from "./ustar-tar";

/** 资产目录 allowlist（Task 7 恢复消费同一常量） */
export const BACKUP_ASSET_DIRS = [
  "skills",
  "library",
  "attachments",
  "workflow-assets",
  "projects",
] as const;

/** 不收录目录（再生产物，重装可再生；排除靠 allowlist 构造保证，此表仅声明契约） */
export const BACKUP_EXCLUDED_DIRS = ["logs", "file-history"] as const;

/** 存在性检查：坏路径/权限异常按不存在处理，不炸装配流程 */
function existsSyncSafe(target: string): boolean {
  try {
    return existsSync(target);
  } catch {
    return false;
  }
}

/** 流式 sha256（hex）——大档不整读进内存 */
async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  const rs = createReadStream(file);
  try {
    for await (const chunk of rs) hash.update(chunk as Buffer);
  } finally {
    rs.destroy();
  }
  return hash.digest("hex");
}

/** better-sqlite3 连接最小面（仅快照所需 backup/close） */
interface SqliteSnapshotConnection {
  backup: (destPath: string) => Promise<void>;
  close: () => void;
}

/** 快照函数契约（真身/替身同签名；替身可同步） */
export type SnapshotDatabase = (
  dbPath: string,
  destPath: string,
) => void | Promise<void>;

/** createBackupArchive 产物（meta 即上传 server 的 BackupCreateRequest） */
export interface BackupArchiveResult {
  archivePath: string;
  meta: BackupCreateRequest;
  sha256: string;
  fileCount: number;
}

/**
 * better-sqlite3 真身快照（主进程 Electron ABI 可用；vitest 替身注入，
 * 本函数在测试路径永不触达）。动态 require：懒加载保 vitest 收集期不触
 * 原生模块；.backup() 为异步分步拷贝，须 await 完成再 close——否则连接
 * 先毁、快照半途而废。
 */
export async function snapshotDatabaseDefault(
  dbPath: string,
  destPath: string,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- better-sqlite3 原生 ABI 运行时懒加载（rolldown 外部化 + CJS 互操作，同 terminal-ipc 口径）
  const Database = require("better-sqlite3") as new (
    dbPath: string,
    options: { readonly: boolean },
  ) => SqliteSnapshotConnection;
  const db = new Database(dbPath, { readonly: true });
  try {
    await db.backup(destPath);
  } finally {
    db.close();
  }
}

/** 递归收集目录内全部条目（相对 relPath 递推；目录条目 size=0——打包器纪律） */
function walk(absDir: string, rel: string, out: TarEntry[]): void {
  for (const name of readdirSync(absDir)) {
    const abs = path.join(absDir, name);
    const relPath = rel ? `${rel}/${name}` : name;
    const st = statSync(abs);
    if (st.isDirectory()) {
      out.push({ relPath, absPath: abs, size: 0 });
      walk(abs, relPath, out);
    } else {
      out.push({ relPath, absPath: abs, size: st.size });
    }
  }
}

/** 收集档内条目：db 快照件（database/local.db）+ allowlist 资产目录 + .jwt-secret */
function collectEntries(dbSnapshot: string): TarEntry[] {
  const entries: TarEntry[] = [
    {
      relPath: "database/local.db",
      absPath: dbSnapshot,
      size: statSync(dbSnapshot).size,
    },
  ];
  const assetRoots: Record<(typeof BACKUP_ASSET_DIRS)[number], string> = {
    skills: skillsDir(),
    library: libraryDir(),
    attachments: attachmentsDir(),
    "workflow-assets": workflowAssetsDir(),
    projects: projectsDir(),
  };
  for (const dir of BACKUP_ASSET_DIRS) {
    if (existsSyncSafe(assetRoots[dir])) walk(assetRoots[dir], dir, entries);
  }
  const secret = jwtSecretPath();
  if (existsSyncSafe(secret)) {
    entries.push({
      relPath: ".jwt-secret",
      absPath: secret,
      size: statSync(secret).size,
    });
  }
  return entries;
}

/**
 * 装配备份档：db 快照 → 条目收集 → tar.gz 打包 → sha256 + meta。
 * archivePath 落 opts.tempDir 直下（调用方负责传输后清理临时区）。
 */
export async function createBackupArchive(opts: {
  tempDir: string;
  appVersion: string;
  snapshotDatabase?: SnapshotDatabase;
}): Promise<BackupArchiveResult> {
  const snapshot = opts.snapshotDatabase ?? snapshotDatabaseDefault;
  const work = mkdtempSync(path.join(opts.tempDir, "pack-"));
  const dbSnapshot = path.join(work, "local.db.snapshot");
  await snapshot(path.join(databaseDir(), "local.db"), dbSnapshot);
  const entries = collectEntries(dbSnapshot);
  const archivePath = path.join(opts.tempDir, `backup-${Date.now()}.tar.gz`);
  await packTarGz(entries, archivePath);
  const sha256 = await hashFile(archivePath);
  const { size: fileSize } = statSync(archivePath);
  const meta: BackupCreateRequest = {
    appVersion: opts.appVersion,
    schemaVersion: Constants.DATABASE_VERSION,
    fileSize,
    sha256,
    chunkCount: Math.max(1, Math.ceil(fileSize / BACKUP_CHUNK_BYTES)),
  };
  return { archivePath, meta, sha256, fileCount: entries.length };
}

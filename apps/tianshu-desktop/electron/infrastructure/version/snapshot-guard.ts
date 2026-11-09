/**
 * v1 全量快照守卫（数据库重置判定）：发布前 DATABASE_VERSION 恒为 1
 * 且 v1 快照随 schema 演进直接改列不加版——版本号相同不保证结构相同
 * （旧 v1 库重放 IF NOT EXISTS 也不补已存在表的列），靠快照内容指纹
 * （sha256 存 option 表）识别「同版本但快照已变」的旧开发库；另有
 * 版本倒挂（库来自被弃的 v2–v14 增量路线，db_version > 代码版本）。
 * 稳定版发布起（allowReset=false，打包态判定）：两者均只上报原因、
 * 永不重置——保护用户数据优先；开发态（allowReset=true）保持
 * drop 全部业务表重放 v1 的自动重建（开发期数据可弃）。发布后
 * schema 改列走逐版新增 script/vN，不再改 v1 快照，不触发本守卫
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  getAppOptionMap,
  setAppOption,
  type OptionPrismaLike,
} from "../../domains/app-settings/option-store";

/** 快照指纹的 option 存取键 */
export const SNAPSHOT_HASH_OPTION_KEY = "db.v1SnapshotHash";

/** 原生 SQL 通道（prisma $queryRawUnsafe/$executeRawUnsafe 注入可测） */
export interface RawSqlExecutor {
  query(sql: string): Promise<Array<{ name: string }>>;
  execute(sql: string): Promise<number>;
}

/** v1 快照文件内容 sha256 指纹 */
export async function readSnapshotHash(sqlFilePath: string): Promise<string> {
  const content = await readFile(sqlFilePath, "utf8");
  return createHash("sha256").update(content).digest("hex");
}

/** 重置原因（打包态仅上报不执行） */
export type ResetReason = "inversion" | "snapshotMismatch" | "unreadableOption";

/** 重置决策：reset=false 且 reason≠null 即「发现问题但策略禁止重置」 */
export interface ResetDecision {
  reset: boolean;
  reason: ResetReason | null;
}

/**
 * 重置决策：版本倒挂；或版本已达代码版本但快照指纹不符（发布前
 * 改快照不加版的旧库，含 option 旧到指纹键缺失/不可读）。命中时
 * reset 取决于 allowReset——开发态 true 照常重置重建，打包态
 * （稳定版）恒 false 仅上报 reason，全新库/待升级/指纹匹配不触发
 */
export async function resolveResetDecision(
  optionDb: OptionPrismaLike,
  currentVersion: number,
  databaseVersion: number,
  snapshotHash: string,
  allowReset: boolean,
): Promise<ResetDecision> {
  if (currentVersion > databaseVersion) {
    return { reset: allowReset, reason: "inversion" };
  }
  if (currentVersion !== databaseVersion) {
    return { reset: false, reason: null }; // 全新库/待升级：跑完快照自然对齐
  }
  try {
    const map = await getAppOptionMap(optionDb, [SNAPSHOT_HASH_OPTION_KEY]);
    return map.get(SNAPSHOT_HASH_OPTION_KEY) === snapshotHash
      ? { reset: false, reason: null }
      : { reset: allowReset, reason: "snapshotMismatch" };
  } catch {
    // option 结构旧到指纹不可读（如缺 type 列）——同样按不符处理
    return { reset: allowReset, reason: "unreadableOption" };
  }
}

/** 记录快照指纹（建库/升级跑完 v1 后调用） */
export async function recordSnapshotHash(
  optionDb: OptionPrismaLike,
  snapshotHash: string,
): Promise<void> {
  await setAppOption(optionDb, SNAPSHOT_HASH_OPTION_KEY, snapshotHash);
}

/**
 * drop 全部业务表（含 db_version，版本回 0 走全量重建）。
 * relationMode=prisma 无外键约束，drop 顺序不敏感
 */
export async function dropAllTables(raw: RawSqlExecutor): Promise<void> {
  const tables = await raw.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  for (const { name } of tables) {
    await raw.execute(`DROP TABLE IF EXISTS "${name}"`);
  }
}

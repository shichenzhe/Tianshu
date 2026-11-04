/**
 * v1 全量快照守卫（数据库重置判定）：发布前 DATABASE_VERSION 恒为 1
 * 且 v1 快照随 schema 演进直接改列不加版——版本号相同不保证结构相同
 * （旧 v1 库重放 IF NOT EXISTS 也不补已存在表的列），靠快照内容指纹
 * （sha256 存 option 表）识别「同版本但快照已变」的旧开发库；另有
 * 版本倒挂（库来自被弃的 v2–v14 增量路线，db_version > 代码版本）。
 * 两者均判定重置：drop 全部业务表重放 v1（开发期数据可弃；发布后
 * schema 改列走逐版新增 script/vN，不再改 v1 快照，不触发本守卫）
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

/**
 * 是否需要重置重建：版本倒挂；或版本已达代码版本但快照指纹不符
 * （发布前改快照不加版的旧库，含 option 旧到指纹键缺失/不可读）
 */
export async function shouldResetDatabase(
  optionDb: OptionPrismaLike,
  currentVersion: number,
  databaseVersion: number,
  snapshotHash: string,
): Promise<boolean> {
  if (currentVersion > databaseVersion) {
    return true;
  }
  if (currentVersion !== databaseVersion) {
    return false; // 全新库/待升级：跑完快照自然对齐
  }
  try {
    const map = await getAppOptionMap(optionDb, [SNAPSHOT_HASH_OPTION_KEY]);
    return map.get(SNAPSHOT_HASH_OPTION_KEY) !== snapshotHash;
  } catch {
    return true; // option 结构旧到不可读（如缺 type 列）——同样需要重置
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

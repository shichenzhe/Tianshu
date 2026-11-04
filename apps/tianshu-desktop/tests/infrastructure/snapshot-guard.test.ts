/**
 * v1 快照守卫单测：重置判定（倒挂/同版本指纹不符/待升级/指纹匹配）、
 * 指纹落库闭环、drop 全部业务表（保留 sqlite 内部表）、快照文件指纹稳定性
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { OptionPrismaLike } from "../../electron/domains/app-settings/option-store";
import {
  SNAPSHOT_HASH_OPTION_KEY,
  dropAllTables,
  readSnapshotHash,
  recordSnapshotHash,
  shouldResetDatabase,
  type RawSqlExecutor,
} from "../../electron/infrastructure/version/snapshot-guard";

const HASH = "a".repeat(64);

/** option 表内存 stub（type="app" 行为语义） */
function optionStub(
  rows: Map<string, string> = new Map(),
): OptionPrismaLike & { rows: Map<string, string> } {
  return {
    rows,
    findMany: async ({ where }) => {
      if (!where.name || !("in" in where.name)) {
        throw new Error("stub 仅支持 name in 查询");
      }
      return where.name.in
        .filter((name) => rows.has(name))
        .map((name) => ({ name, value: rows.get(name)! }));
    },
    updateMany: async ({ where, data }) => {
      if (!rows.has(where.name)) {
        return { count: 0 };
      }
      rows.set(where.name, data.value);
      return { count: 1 };
    },
    create: async ({ data }) => {
      rows.set(data.name, data.value);
      return {};
    },
  };
}

/** 读取即抛错的 option stub（模拟旧结构不可读） */
const brokenOption: OptionPrismaLike = {
  findMany: async () => {
    throw new Error("no such column: type");
  },
  updateMany: async () => ({ count: 0 }),
  create: async () => ({}),
};

/** node:sqlite 原生通道适配 */
function sqliteRaw(db: DatabaseSync): RawSqlExecutor {
  return {
    query: async (sql) => db.prepare(sql).all() as Array<{ name: string }>,
    execute: async (sql) => {
      db.exec(sql);
      return 0;
    },
  };
}

describe("shouldResetDatabase", () => {
  it("版本倒挂（库来自被弃 v2–v14 增量路线）→ 重置", async () => {
    expect(await shouldResetDatabase(optionStub(), 10, 1, HASH)).toBe(true);
  });

  it("全新库/待升级（0）→ 不重置，跑完快照自然对齐", async () => {
    expect(await shouldResetDatabase(optionStub(), 0, 1, HASH)).toBe(false);
  });

  it("同版本但无指纹记录（旧 v1 库首跑守卫）→ 重置", async () => {
    expect(await shouldResetDatabase(optionStub(), 1, 1, HASH)).toBe(true);
  });

  it("同版本且指纹匹配 → 不重置", async () => {
    const stub = optionStub(new Map([[SNAPSHOT_HASH_OPTION_KEY, HASH]]));
    expect(await shouldResetDatabase(stub, 1, 1, HASH)).toBe(false);
  });

  it("同版本但指纹不符（快照已改列）→ 重置", async () => {
    const stub = optionStub(
      new Map([[SNAPSHOT_HASH_OPTION_KEY, "b".repeat(64)]]),
    );
    expect(await shouldResetDatabase(stub, 1, 1, HASH)).toBe(true);
  });

  it("option 结构旧到指纹不可读 → 重置", async () => {
    expect(await shouldResetDatabase(brokenOption, 1, 1, HASH)).toBe(true);
  });
});

describe("recordSnapshotHash", () => {
  it("落库后同指纹判定不重置（读写闭环）", async () => {
    const stub = optionStub();
    await recordSnapshotHash(stub, HASH);
    expect(await shouldResetDatabase(stub, 1, 1, HASH)).toBe(false);
    expect(await shouldResetDatabase(stub, 1, 1, "c".repeat(64))).toBe(true);
  });
});

describe("dropAllTables", () => {
  it("drop 全部业务表，保留 sqlite 内部表", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE session (id INTEGER PRIMARY KEY)");
    db.exec("CREATE TABLE option (id INTEGER PRIMARY KEY)");
    db.exec("INSERT INTO session (id) VALUES (1)");
    await dropAllTables(sqliteRaw(db));
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>
    ).map((t) => t.name);
    expect(tables.every((name) => name.startsWith("sqlite_"))).toBe(true);
  });
});

describe("readSnapshotHash", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "snapshot-guard-"));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("sha256 hex（64 位），内容变指纹变", async () => {
    const fileA = path.join(dir, "a.sql");
    writeFileSync(fileA, "CREATE TABLE t (id INTEGER);");
    const hashA = await readSnapshotHash(fileA);
    expect(hashA).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(fileA, "CREATE TABLE t (id INTEGER, name TEXT);");
    expect(await readSnapshotHash(fileA)).not.toBe(hashA);
    // 重新写入相同内容 → 指纹还原（幂等基准）
    writeFileSync(fileA, "CREATE TABLE t (id INTEGER);");
    expect(await readSnapshotHash(fileA)).toBe(hashA);
  });
});

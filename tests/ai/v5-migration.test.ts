import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const V5_SQL = readFileSync(
  path.resolve(
    __dirname,
    "../../electron/infrastructure/script/v5/upgrade-table.sql",
  ),
  "utf8",
);

/** 去掉注释标记行后按分号拆分语句（模拟 sql-file-executor 的最小语义） */
function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** v4 起点的 session 表（含 v3 加的 mode 列） */
function createV4SessionTable(db: DatabaseSync) {
  db.exec(
    "CREATE TABLE session (id INTEGER PRIMARY KEY, workspaceId INTEGER NOT NULL, " +
      "assistantId INTEGER, currentModelId INTEGER, title TEXT NOT NULL, mode TEXT, " +
      "createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL, lastMessageAt DATETIME)",
  );
}

describe("v5 迁移脚本幂等", () => {
  it("重复执行两次：pinnedAt/archivedAt 列存在且旧行默认 null", () => {
    const db = new DatabaseSync(":memory:");
    createV4SessionTable(db);
    db.exec(
      "INSERT INTO session (workspaceId, title, createdAt, updatedAt) VALUES (1, '旧任务', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
    );
    for (let round = 0; round < 2; round++) {
      for (const stmt of statements(V5_SQL)) {
        try {
          db.exec(stmt);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!msg.includes("duplicate column")) {
            throw e;
          }
        }
      }
    }
    const cols = db.prepare("PRAGMA table_info(session)").all() as Array<{
      name: string;
    }>;
    expect(cols.map((c) => c.name)).toContain("pinnedAt");
    expect(cols.map((c) => c.name)).toContain("archivedAt");
    const row = db
      .prepare("SELECT pinnedAt, archivedAt FROM session WHERE id = 1")
      .get() as { pinnedAt: unknown; archivedAt: unknown };
    expect(row.pinnedAt).toBeNull();
    expect(row.archivedAt).toBeNull();
    db.close();
  });
});

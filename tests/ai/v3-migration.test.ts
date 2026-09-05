import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const V3_SQL = readFileSync(
  path.resolve(
    __dirname,
    "../../electron/infrastructure/script/v3/upgrade-table.sql",
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

describe("v3 迁移脚本幂等", () => {
  it("重复执行两次：mode 列存在且不抛错", () => {
    const db = new DatabaseSync(":memory:");
    // 含 v2 已有列的 session 表（v2 起点升级到 v3）
    db.exec(
      "CREATE TABLE session (id INTEGER PRIMARY KEY, workspaceId INTEGER NOT NULL, " +
        "assistantId INTEGER, currentModelId INTEGER, title TEXT NOT NULL, " +
        "createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL, lastMessageAt DATETIME)",
    );
    for (let round = 0; round < 2; round++) {
      for (const stmt of statements(V3_SQL)) {
        // 第二轮的 ALTER（duplicate column）应被 --/ignore 吞掉——
        // 测试里以 try/catch 复刻该语义：仅忽略 duplicate column 错误
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
    expect(cols.map((c) => c.name)).toContain("mode");
    db.close();
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const V6_SQL = readFileSync(
  path.resolve(
    __dirname,
    "../../electron/infrastructure/script/v6/upgrade-table.sql",
  ),
  "utf8",
);

/** 去掉注释标记行后按分号拆分语句(模拟 sql-file-executor 的最小语义) */
function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

describe("v6 迁移:skillRecord 表", () => {
  it("建表可插入且 name 唯一约束生效", () => {
    const db = new DatabaseSync(":memory:");
    for (const stmt of statements(V6_SQL)) {
      db.exec(stmt);
    }
    db.exec(
      "INSERT INTO skillRecord (name, source, dir, updatedAt) VALUES ('greeting', 'local', '/tmp/skills/greeting', CURRENT_TIMESTAMP)",
    );
    expect(() =>
      db.exec(
        "INSERT INTO skillRecord (name, source, dir, updatedAt) VALUES ('greeting', 'local', '/tmp/x', CURRENT_TIMESTAMP)",
      ),
    ).toThrow();
    const row = db
      .prepare("SELECT name, enabled, description FROM skillRecord")
      .get() as { name: string; enabled: number; description: unknown };
    expect(row).toEqual({
      name: "greeting",
      enabled: 1,
      description: null,
    });
  });

  it("重复执行幂等(IF NOT EXISTS)", () => {
    const db = new DatabaseSync(":memory:");
    for (let i = 0; i < 2; i += 1) {
      for (const stmt of statements(V6_SQL)) {
        db.exec(stmt);
      }
    }
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'skillRecord'",
        )
        .get(),
    ).toEqual({ n: 1 });
  });
});

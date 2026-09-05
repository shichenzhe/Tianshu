import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const V7_SQL = readFileSync(
  path.resolve(
    __dirname,
    "../../electron/infrastructure/script/v7/upgrade-table.sql",
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

describe("v7 迁移:skillStat 事件表", () => {
  it("建表可插入且同名多事件共存(事件流,无唯一约束)", () => {
    const db = new DatabaseSync(":memory:");
    for (const stmt of statements(V7_SQL)) {
      db.exec(stmt);
    }
    db.exec(
      "INSERT INTO skillStat (name, event) VALUES ('greeting', 'install')",
    );
    db.exec(
      "INSERT INTO skillStat (name, event) VALUES ('greeting', 'enable')",
    );
    db.exec(
      "INSERT INTO skillStat (name, event) VALUES ('demo', 'batch_uninstall')",
    );
    const rows = db
      .prepare("SELECT name, event, createdAt FROM skillStat ORDER BY id")
      .all() as Array<{ name: string; event: string; createdAt: string }>;
    expect(rows.map((r) => [r.name, r.event])).toEqual([
      ["greeting", "install"],
      ["greeting", "enable"],
      ["demo", "batch_uninstall"],
    ]);
    expect(rows.every((r) => r.createdAt !== null)).toBe(true);
  });

  it("重复执行幂等(IF NOT EXISTS)", () => {
    const db = new DatabaseSync(":memory:");
    for (let i = 0; i < 2; i += 1) {
      for (const stmt of statements(V7_SQL)) {
        db.exec(stmt);
      }
    }
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'skillStat'",
        )
        .get(),
    ).toEqual({ n: 1 });
  });
});

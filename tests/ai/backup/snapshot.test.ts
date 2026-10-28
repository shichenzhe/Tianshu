// snapshot 单测：TIANSHU_DATA_ROOT 注入临时数据根（tests/setup.ts 全局
// 隔离同口径）；better-sqlite3 真身以替身注入（node ABI 铁律——保留策略批
// 先例）。import 相对路径形态照 tests/ai/backup/ustar-tar.test.ts（子目录再
// 深一层，须 ../../../electron）；vi.mock electron（virtual）使 appDataHome
// 走 app/ 分组（isPackaged: true）。
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: true } }), { virtual: true });
// paths.ts 的 appDataHome 依赖 electron app.isPackaged——vi.mock 后走 app/ 分组

const { createBackupArchive, BACKUP_ASSET_DIRS } =
  await import("../../../electron/domains/backup/snapshot");

const dataRoot = mkdtempSync(path.join(os.tmpdir(), "snap-"));
process.env.TIANSHU_DATA_ROOT = dataRoot;

describe("snapshot", () => {
  it("db 快照（替身）+ 资产目录收集 + tar.gz 产出与 meta", async () => {
    // 造数据根：app 分组下 database/local.db + skills 一个文件 + .jwt-secret
    const group = path.join(dataRoot, "app");
    mkdirSync(path.join(group, "database"), { recursive: true });
    writeFileSync(path.join(group, "database", "local.db"), "FAKE-DB");
    mkdirSync(path.join(group, "skills", "demo"), { recursive: true });
    writeFileSync(path.join(group, "skills", "demo", "SKILL.md"), "s");
    writeFileSync(path.join(group, ".jwt-secret"), "jwt");
    // 应排除项：logs / file-history
    mkdirSync(path.join(group, "logs"), { recursive: true });
    writeFileSync(path.join(group, "logs", "x.log"), "l");
    mkdirSync(path.join(group, "file-history"), { recursive: true });

    let snapCalled = false;
    const result = await createBackupArchive({
      tempDir: mkdtempSync(path.join(os.tmpdir(), "snapout-")),
      appVersion: "1.2.3",
      snapshotDatabase: (dbPath, destPath) => {
        snapCalled = true;
        expect(dbPath.endsWith("database/local.db")).toBe(true);
        writeFileSync(destPath, "SNAPSHOT-DB");
      },
    });
    expect(snapCalled).toBe(true);
    expect(existsSync(result.archivePath)).toBe(true);
    // tar 清单断言：含 database/skills/.jwt-secret；不含 logs/file-history
    const listing = execSync(`tar -tzf ${result.archivePath}`)
      .toString()
      .trim()
      .split("\n");
    expect(listing.some((l) => l === "database/local.db")).toBe(true);
    expect(listing.some((l) => l.startsWith("skills/"))).toBe(true);
    expect(listing.some((l) => l === ".jwt-secret")).toBe(true);
    expect(listing.some((l) => l.startsWith("logs/"))).toBe(false);
    expect(listing.some((l) => l.startsWith("file-history/"))).toBe(false);
    expect(result.meta.sha256).toBe(result.sha256);
    expect(result.meta.schemaVersion).toBeGreaterThan(0);
    expect(result.meta.chunkCount).toBeGreaterThanOrEqual(1);
    expect(result.meta.appVersion).toBe("1.2.3");
    expect(result.meta.fileSize).toBe(statSync(result.archivePath).size);
    expect(result.fileCount).toBeGreaterThanOrEqual(3);
  });

  it("BACKUP_ASSET_DIRS 契约锁定（Task 7 恢复消费同一常量）", () => {
    expect([...BACKUP_ASSET_DIRS]).toEqual([
      "skills",
      "library",
      "attachments",
      "workflow-assets",
      "projects",
    ]);
  });
});

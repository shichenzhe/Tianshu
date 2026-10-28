/**
 * data-migrate 单测：目录迁移（递归冷拷贝 / 目标非空幂等跳过 / 旧目录
 * 不存在仅确保目标存在）+ 文件迁移（拷贝还原 600 / 目标存在跳过）。
 * 纯 node:fs 依赖，无 electron。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  migrateLegacyDir,
  migrateLegacyFile,
} from "../../electron/commons/data-migrate";

describe("migrateLegacyDir", () => {
  let base: string;

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-migrate-"));
  });
  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("旧目录存在时递归冷拷贝（含子目录结构）", () => {
    const legacy = path.join(base, "legacy1");
    const target = path.join(base, "target1");
    fs.mkdirSync(path.join(legacy, "sub"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "local.db"), "db");
    fs.writeFileSync(path.join(legacy, "local.db-wal"), "wal");
    fs.writeFileSync(path.join(legacy, "sub", "SKILL.md"), "skill");
    migrateLegacyDir(target, legacy);
    expect(fs.readFileSync(path.join(target, "local.db"), "utf8")).toBe("db");
    expect(fs.readFileSync(path.join(target, "sub", "SKILL.md"), "utf8")).toBe(
      "skill",
    );
  });

  it("目标已有内容时幂等跳过（不覆盖）", () => {
    const legacy = path.join(base, "legacy2");
    const target = path.join(base, "target2");
    fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, "local.db"), "old");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "existing.txt"), "new");
    migrateLegacyDir(target, legacy);
    expect(fs.readdirSync(target)).toEqual(["existing.txt"]);
  });

  it("旧目录不存在时仅确保目标目录存在", () => {
    const target = path.join(base, "target3");
    migrateLegacyDir(target, path.join(base, "no-such"));
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readdirSync(target)).toEqual([]);
  });
});

describe("migrateLegacyFile", () => {
  let base: string;

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-migrate-file-"));
  });
  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("旧文件存在时拷贝并还原 600 权限", () => {
    const legacy = path.join(base, ".jwt-secret");
    const target = path.join(base, "nested", ".jwt-secret");
    fs.writeFileSync(legacy, "secret", { mode: 0o600 });
    migrateLegacyFile(target, legacy);
    expect(fs.readFileSync(target, "utf8")).toBe("secret");
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it("目标已存在或旧文件不存在时跳过", () => {
    const legacy = path.join(base, "legacy.bin");
    fs.writeFileSync(legacy, "old");
    const target = path.join(base, "target.bin");
    fs.writeFileSync(target, "new");
    migrateLegacyFile(target, legacy);
    expect(fs.readFileSync(target, "utf8")).toBe("new");
    migrateLegacyFile(
      path.join(base, "fresh.bin"),
      path.join(base, "no-such.bin"),
    );
    expect(fs.existsSync(path.join(base, "fresh.bin"))).toBe(false);
  });
});

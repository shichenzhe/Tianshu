// restore 单测：真实 fs 演练（临时数据根注入）；原子切换 + 中途失败回滚。
// import 相对路径形态照 tests/ai/backup/snapshot.test.ts（../../../electron）；
// vi.mock electron（virtual）使 appDataHome 走 app/ 分组（isPackaged: true）；
// 保护副本同样注入 snapshotDatabase 替身（node ABI 铁律，不触 better-sqlite3）。
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: true } }), { virtual: true });

const dataRoot = mkdtempSync(path.join(os.tmpdir(), "restore-"));
process.env.TIANSHU_DATA_ROOT = dataRoot;

const { restoreArchive, createLocalSafetyCopy, __setFailOnStep } =
  await import("../../../electron/domains/backup/restore");

/** 造一个合法备份包（用 GNU tar 打，双实现互验） */
function makeArchive(): string {
  const src = mkdtempSync(path.join(os.tmpdir(), "arch-"));
  mkdirSync(path.join(src, "database"), { recursive: true });
  writeFileSync(path.join(src, "database", "local.db"), "NEW-DB");
  mkdirSync(path.join(src, "skills", "s1"), { recursive: true });
  writeFileSync(path.join(src, "skills", "s1", "SKILL.md"), "new-skill");
  writeFileSync(path.join(src, ".jwt-secret"), "new-jwt");
  const out = path.join(
    mkdtempSync(path.join(os.tmpdir(), "out-")),
    "b.tar.gz",
  );
  execSync(`cd ${src} && tar -czf ${out} .`);
  return out;
}

/** 数据根下不得残留任何恢复中间目录（staging 暂存与 old 暂存均 .restore- 前缀） */
function expectNoRestoreResidue(): void {
  const residue = readdirSync(dataRoot).filter((name) =>
    name.startsWith(".restore-"),
  );
  expect(residue).toEqual([]);
}

describe("restore", () => {
  it("三步原子切换：新数据就位，旧数据移入暂存后清除", async () => {
    const group = path.join(dataRoot, "app");
    mkdirSync(path.join(group, "database"), { recursive: true });
    writeFileSync(path.join(group, "database", "local.db"), "OLD-DB");
    mkdirSync(path.join(group, "logs"), { recursive: true });
    writeFileSync(path.join(group, "logs", "keep-or-not.log"), "log"); // logs 不在备份范围——原样保留
    await restoreArchive(makeArchive());
    expect(readFileSync(path.join(group, "database", "local.db"), "utf8")).toBe(
      "NEW-DB",
    );
    expect(
      readFileSync(path.join(group, "skills", "s1", "SKILL.md"), "utf8"),
    ).toBe("new-skill");
    expect(readFileSync(path.join(group, ".jwt-secret"), "utf8")).toBe(
      "new-jwt",
    );
    expect(existsSync(path.join(group, "logs", "keep-or-not.log"))).toBe(true); // 范围外不动
  });

  it("备份范围内的旧残留（包中没有的文件）被清除", async () => {
    const group = path.join(dataRoot, "app");
    writeFileSync(path.join(group, "database", "stale.db-journal"), "stale");
    await restoreArchive(makeArchive());
    expect(existsSync(path.join(group, "database", "stale.db-journal"))).toBe(
      false,
    );
  });

  it("坏包（非 tar.gz）：抛错且现有数据零损伤", async () => {
    const group = path.join(dataRoot, "app");
    const before = readFileSync(
      path.join(group, "database", "local.db"),
      "utf8",
    );
    const bad = path.join(
      mkdtempSync(path.join(os.tmpdir(), "out-")),
      "bad.tar.gz",
    );
    writeFileSync(bad, "not-a-tarball");
    await expect(restoreArchive(bad)).rejects.toThrow();
    expect(readFileSync(path.join(group, "database", "local.db"), "utf8")).toBe(
      before,
    );
  });

  it("切换中途失败注入：自动回滚（rename 第二步炸→旧数据还原）", async () => {
    __setFailOnStep(2);
    const group = path.join(dataRoot, "app");
    writeFileSync(path.join(group, "database", "local.db"), "KEEP-DB");
    await expect(restoreArchive(makeArchive())).rejects.toThrow();
    __setFailOnStep(0);
    expect(readFileSync(path.join(group, "database", "local.db"), "utf8")).toBe(
      "KEEP-DB",
    );
  });

  it("保护副本：产出于数据根 backups-local/ 下", async () => {
    const p = await createLocalSafetyCopy(
      mkdtempSync(path.join(os.tmpdir(), "sc-")),
      (_dbPath, destPath) => writeFileSync(destPath, "SAFETY-DB"),
    );
    expect(p.startsWith(path.join(dataRoot, "backups-local"))).toBe(true);
    expect(path.basename(p)).toMatch(/^safety-[\dTZ+-]+\.tar\.gz$/);
    expect(existsSync(p)).toBe(true);
  });

  it("step 3 注入（清暂存步炸）：全切换后整体回滚——旧数据归位、无残目录", async () => {
    const group = path.join(dataRoot, "app");
    writeFileSync(path.join(group, "database", "local.db"), "KEEP-DB");
    writeFileSync(path.join(group, "skills", "s1", "SKILL.md"), "keep-skill");
    writeFileSync(path.join(group, ".jwt-secret"), "keep-jwt");
    __setFailOnStep(3);
    await expect(restoreArchive(makeArchive())).rejects.toThrow();
    __setFailOnStep(0);
    expect(readFileSync(path.join(group, "database", "local.db"), "utf8")).toBe(
      "KEEP-DB",
    );
    expect(
      readFileSync(path.join(group, "skills", "s1", "SKILL.md"), "utf8"),
    ).toBe("keep-skill");
    expect(readFileSync(path.join(group, ".jwt-secret"), "utf8")).toBe(
      "keep-jwt",
    );
    expectNoRestoreResidue();
  });

  it("step 1 注入（首个 staged 目标本地缺位）：零挪动回滚——无直放置残留、无残目录", async () => {
    const group = path.join(dataRoot, "app");
    rmSync(path.join(group, "database"), { recursive: true, force: true }); // 换机缺位：首目标本地不存在
    writeFileSync(path.join(group, "skills", "s1", "SKILL.md"), "stay-skill");
    __setFailOnStep(1);
    await expect(restoreArchive(makeArchive())).rejects.toThrow();
    __setFailOnStep(0);
    expect(existsSync(path.join(group, "database"))).toBe(false); // 注入点无条件生效，直放置不得发生
    expect(
      readFileSync(path.join(group, "skills", "s1", "SKILL.md"), "utf8"),
    ).toBe("stay-skill");
    expect(readFileSync(path.join(group, ".jwt-secret"), "utf8")).toBe(
      "keep-jwt",
    );
    expectNoRestoreResidue();
  });

  it("多项账本回滚：step 2 于第二个目标触发——三项全部恢复原值、无残目录", async () => {
    const group = path.join(dataRoot, "app");
    mkdirSync(path.join(group, "database"), { recursive: true });
    writeFileSync(path.join(group, "database", "local.db"), "OLD-DB");
    writeFileSync(path.join(group, "skills", "s1", "SKILL.md"), "old-skill");
    writeFileSync(path.join(group, ".jwt-secret"), "old-jwt");
    __setFailOnStep(2, 2); // database 整切换完成、skills 挪旧未就位时触发
    await expect(restoreArchive(makeArchive())).rejects.toThrow();
    __setFailOnStep(0);
    expect(readFileSync(path.join(group, "database", "local.db"), "utf8")).toBe(
      "OLD-DB",
    );
    expect(
      readFileSync(path.join(group, "skills", "s1", "SKILL.md"), "utf8"),
    ).toBe("old-skill");
    expect(readFileSync(path.join(group, ".jwt-secret"), "utf8")).toBe(
      "old-jwt",
    );
    expectNoRestoreResidue();
  });
});

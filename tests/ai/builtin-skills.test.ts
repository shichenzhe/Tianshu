/**
 * builtin-skills 单测：内置技能启动自愈安装
 * 纯 Node：临时目录模拟 builtinRoot/skillsRoot + 内存 stub prisma。
 * 核心语义：跳过判定只看目标目录是否存在——禁用记录不阻重装判定，
 * 卸载(目录被删)后重启恢复(重装)。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureBuiltinSkills } from "../../electron/domains/ai/skill/builtin-skills";
import type {
  SkillRecordDbRow,
  SkillRecordPrismaLike,
} from "../../electron/domains/ai/skill/skill-installer";

const SKILL_MD = `---
name: skill-creator
description: 指导创建自定义技能
---

# 技能创作指南

正文内容`;

const DESCRIPTION = "指导创建自定义技能";

interface UpsertArgs {
  where: { name: string };
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}

/** prisma skillRecord 结构子集 stub：内存 Map + upsert 调用记录 */
function createPrismaStub(
  seed: Array<Partial<SkillRecordDbRow> & { name: string }> = [],
) {
  const rows = new Map<string, SkillRecordDbRow>();
  let nextId = 1;
  for (const item of seed) {
    rows.set(item.name, {
      id: item.id ?? nextId++,
      name: item.name,
      slug: item.slug ?? null,
      version: item.version ?? null,
      source: item.source ?? "local",
      dir: item.dir ?? "",
      description: item.description ?? null,
      enabled: item.enabled ?? true,
      installedAt: item.installedAt ?? new Date(0),
    });
  }
  const upsertCalls: UpsertArgs[] = [];
  const prisma: SkillRecordPrismaLike = {
    async findFirst(args) {
      return rows.get(args.where.name) ?? null;
    },
    async upsert(args) {
      upsertCalls.push(args as UpsertArgs);
      const existing = rows.get(args.where.name);
      if (existing) return existing;
      const created: SkillRecordDbRow = {
        ...(args.create as unknown as SkillRecordDbRow),
        id: nextId++,
        enabled: true,
        installedAt: new Date(),
      };
      rows.set(args.where.name, created);
      return created;
    },
    async delete() {
      return undefined;
    },
  };
  return { prisma, upsertCalls };
}

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "mirror-builtin-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 构造含 skill-creator 资源的 builtinRoot */
function makeBuiltinRoot(): string {
  const root = makeTmpDir();
  mkdirSync(path.join(root, "skill-creator"), { recursive: true });
  writeFileSync(path.join(root, "skill-creator", "SKILL.md"), SKILL_MD, "utf8");
  return root;
}

function makeDeps(
  builtinRoot: string,
  seed: Array<Partial<SkillRecordDbRow> & { name: string }> = [],
) {
  const skillsRoot = makeTmpDir();
  const stub = createPrismaStub(seed);
  return {
    deps: { builtinRoot, skillsRoot, prisma: stub.prisma },
    skillsRoot,
    ...stub,
  };
}

describe("ensureBuiltinSkills 自愈安装", () => {
  it("缺失：复制目录 + upsert(source builtin、description 取自 frontmatter)", async () => {
    const builtinRoot = makeBuiltinRoot();
    const { deps, skillsRoot, upsertCalls } = makeDeps(builtinRoot);

    await ensureBuiltinSkills(deps);

    const installed = path.join(skillsRoot, "skill-creator", "SKILL.md");
    expect(existsSync(installed)).toBe(true);
    expect(readFileSync(installed, "utf8")).toBe(SKILL_MD);
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]!.where).toEqual({ name: "skill-creator" });
    expect(upsertCalls[0]!.create).toMatchObject({
      name: "skill-creator",
      source: "builtin",
      dir: path.join(skillsRoot, "skill-creator"),
      description: DESCRIPTION,
    });
    expect(upsertCalls[0]!.update).toMatchObject({
      source: "builtin",
      dir: path.join(skillsRoot, "skill-creator"),
      description: DESCRIPTION,
    });
  });

  it("存在：直接跳过(不复制目录、不 upsert，用户内容原样保留)", async () => {
    // builtinRoot 不含资源：若未先短路，读源/复制会抛错，可反证跳过先于任何动作
    const builtinRoot = makeTmpDir();
    const { deps, skillsRoot, upsertCalls } = makeDeps(builtinRoot);
    const existing = path.join(skillsRoot, "skill-creator");
    mkdirSync(existing, { recursive: true });
    writeFileSync(
      path.join(existing, "SKILL.md"),
      "---\nname: skill-creator\ndescription: 用户手动改过的版本\n---\n",
      "utf8",
    );

    await ensureBuiltinSkills(deps);

    expect(upsertCalls).toHaveLength(0);
    expect(readFileSync(path.join(existing, "SKILL.md"), "utf8")).toContain(
      "用户手动改过的版本",
    );
  });

  it("禁用记录 + 目录在：跳过重装(判定只看目录，不看 enabled)", async () => {
    const builtinRoot = makeBuiltinRoot();
    const { deps, skillsRoot, upsertCalls } = makeDeps(builtinRoot, [
      { name: "skill-creator", source: "builtin", enabled: false },
    ]);
    mkdirSync(path.join(skillsRoot, "skill-creator"), { recursive: true });

    await ensureBuiltinSkills(deps);

    expect(upsertCalls).toHaveLength(0);
  });

  it("卸载残留记录 + 目录缺失：重装(内置语义，重启恢复)", async () => {
    const builtinRoot = makeBuiltinRoot();
    const { deps, skillsRoot, upsertCalls } = makeDeps(builtinRoot, [
      {
        name: "skill-creator",
        source: "builtin",
        enabled: false,
        dir: "/already/gone",
      },
    ]);

    await ensureBuiltinSkills(deps);

    expect(existsSync(path.join(skillsRoot, "skill-creator", "SKILL.md"))).toBe(
      true,
    );
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]!.create).toMatchObject({ source: "builtin" });
  });
});

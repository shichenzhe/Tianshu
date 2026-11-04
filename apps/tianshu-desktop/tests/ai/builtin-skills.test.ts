/**
 * builtin-skills 单测：内置技能启动自愈安装
 * 纯 Node：临时目录模拟 builtinRoot/skillsRoot + 内存 stub prisma。
 * 核心语义：目录在 → 不复制(用户内容原样)但纠 source 为 builtin(存量
 * 记录可能以 local 落库)；目录缺 → 复制重装。禁用记录不阻判定，
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

const WORKFLOW_MD = `---
name: workflow-creator
description: 指导创建工作流
---

# 工作流创作指南

正文内容`;

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
  const dir = mkdtempSync(path.join(tmpdir(), "tianshu-builtin-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 构造含全部内置技能资源的 builtinRoot */
function makeBuiltinRoot(): string {
  const root = makeTmpDir();
  mkdirSync(path.join(root, "skill-creator"), { recursive: true });
  writeFileSync(path.join(root, "skill-creator", "SKILL.md"), SKILL_MD, "utf8");
  mkdirSync(path.join(root, "workflow-creator"), { recursive: true });
  writeFileSync(
    path.join(root, "workflow-creator", "SKILL.md"),
    WORKFLOW_MD,
    "utf8",
  );
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
    expect(upsertCalls).toHaveLength(2);
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

  it("存在:不复制文件(用户内容原样),但纠 source 为 builtin(update 只碰 source)", async () => {
    // builtinRoot 不含资源:若未短路,复制会抛错,可反证"不复制"先于资源访问
    const builtinRoot = makeTmpDir();
    const { deps, skillsRoot, upsertCalls } = makeDeps(builtinRoot, [
      { name: "skill-creator", source: "local", enabled: false },
    ]);
    const existing = path.join(skillsRoot, "skill-creator");
    mkdirSync(existing, { recursive: true });
    writeFileSync(
      path.join(existing, "SKILL.md"),
      "---\nname: skill-creator\ndescription: 用户手动改过的版本\n---\n",
      "utf8",
    );
    const existingWorkflow = path.join(skillsRoot, "workflow-creator");
    mkdirSync(existingWorkflow, { recursive: true });
    writeFileSync(
      path.join(existingWorkflow, "SKILL.md"),
      "---\nname: workflow-creator\ndescription: 用户手动改过的版本\n---\n",
      "utf8",
    );

    await ensureBuiltinSkills(deps);

    // 存量 local 记录(自愈机制上线前落库)被纠正为 builtin,目录内容不动
    expect(upsertCalls).toHaveLength(2);
    const target = upsertCalls.find((c) => c.where.name === "skill-creator")!;
    expect(target.update).toEqual({ source: "builtin" });
    expect(readFileSync(path.join(existing, "SKILL.md"), "utf8")).toContain(
      "用户手动改过的版本",
    );
  });

  it("禁用记录 + 目录在：纠 source 不碰启停态(update 不含 enabled)", async () => {
    const builtinRoot = makeBuiltinRoot();
    const { deps, skillsRoot, upsertCalls } = makeDeps(builtinRoot, [
      { name: "skill-creator", source: "builtin", enabled: false },
    ]);
    mkdirSync(path.join(skillsRoot, "skill-creator"), { recursive: true });
    mkdirSync(path.join(skillsRoot, "workflow-creator"), { recursive: true });

    await ensureBuiltinSkills(deps);

    expect(upsertCalls).toHaveLength(2);
    for (const call of upsertCalls) {
      expect(call.update).toEqual({ source: "builtin" });
    }
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
    expect(upsertCalls).toHaveLength(2);
    expect(upsertCalls[0]!.create).toMatchObject({ source: "builtin" });
  });
});

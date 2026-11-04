/**
 * create_skill 单测(P-D Task 2):纯函数校验链 + 执行落盘/upsert/冲突/清理。
 * 纯 Node:mkdtempSync 临时 skillsRoot + 内存 stub prisma(参照 skill-installer.test.ts)
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// skill-stats recorder 静态 import commons/Log(winston/electron 副作用),
// 模块级 mock 隔离(参照 chat.service.test.ts 的 mock 边界先例)
vi.mock("../../electron/commons/Log", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
import {
  makeCreateSkillTool,
  validateCreateSkillParams,
} from "../../electron/domains/ai/agent/create-skill";
import type {
  SkillRecordDbRow,
  SkillRecordPrismaLike,
} from "../../electron/domains/ai/skill/skill-installer";
import type { SkillStatPrismaLike } from "../../electron/domains/ai/skill/skill-stats";

const KB = 1024;

const SKILL_MD = (name: string, description = "示例技能") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n正文内容`;

/** 合法入参基线(SKILL.md + 一个子目录附属文件) */
function validArgs(name = "demo-skill") {
  return {
    name,
    description: "示例技能",
    files: [
      { path: "SKILL.md", content: SKILL_MD(name) },
      { path: "references/guide.md", content: "# 指南" },
    ],
  };
}

/** prisma skillRecord 结构子集 stub:只记录 upsert 调用(create_skill 不读不删) */
function createPrismaStub() {
  const upsertCalls: Parameters<SkillRecordPrismaLike["upsert"]>[0][] = [];
  const prisma: SkillRecordPrismaLike = {
    async findFirst() {
      return null;
    },
    async upsert(args) {
      upsertCalls.push(args);
      const row: SkillRecordDbRow = {
        id: upsertCalls.length,
        name: args.where.name,
        slug: args.create.slug,
        version: args.create.version,
        source: args.create.source,
        dir: args.create.dir,
        description: args.create.description,
        enabled: true,
        installedAt: new Date(),
      };
      return row;
    },
    async delete() {
      return null;
    },
  };
  return { prisma, upsertCalls };
}

let skillsRoot: string;

beforeEach(() => {
  skillsRoot = mkdtempSync(path.join(tmpdir(), "create-skill-"));
});
afterEach(() => rmSync(skillsRoot, { recursive: true, force: true }));

describe("validateCreateSkillParams 纯函数", () => {
  it("合法参数通过,返回 name/description/files", () => {
    const args = validArgs();
    const check = validateCreateSkillParams(args);
    expect(check).toEqual({ ok: true, ...args });
  });

  it("Windows 风格路径归一为 posix 再返回", () => {
    const check = validateCreateSkillParams({
      ...validArgs(),
      files: [
        { path: "SKILL.md", content: SKILL_MD("demo-skill") },
        { path: "references\\guide.md", content: "# 指南" },
      ],
    });
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.files[1]!.path).toBe("references/guide.md");
    }
  });

  it("name 非 kebab-case 拒绝(空格/下划线/大写/前导连字符)", () => {
    for (const name of ["My Skill", "my_skill", "Demo", "-demo", "演示"]) {
      const check = validateCreateSkillParams({
        ...validArgs(),
        name,
        files: [{ path: "SKILL.md", content: SKILL_MD(name) }],
      });
      expect(check).toMatchObject({ ok: false });
      if (!check.ok) expect(check.reason).toContain("kebab-case");
    }
  });

  it("files 缺 SKILL.md 拒绝", () => {
    const check = validateCreateSkillParams({
      ...validArgs(),
      files: [{ path: "README.md", content: "无技能元数据" }],
    });
    expect(check).toMatchObject({ ok: false });
    if (!check.ok) expect(check.reason).toContain("SKILL.md");
  });

  it("SKILL.md 内容不过 validateSkillMd 拒绝(缺 description)", () => {
    const check = validateCreateSkillParams({
      ...validArgs(),
      files: [
        { path: "SKILL.md", content: "---\nname: demo-skill\n---\n正文" },
      ],
    });
    expect(check).toMatchObject({ ok: false });
    if (!check.ok) expect(check.reason).toContain("description");
  });

  it("SKILL.md frontmatter name 与参数 name 不一致拒绝", () => {
    const check = validateCreateSkillParams({
      ...validArgs(),
      files: [{ path: "SKILL.md", content: SKILL_MD("other-name") }],
    });
    expect(check).toMatchObject({ ok: false });
    if (!check.ok) expect(check.reason).toContain("一致");
  });

  it("危险 path 拒绝(../、绝对路径、盘符)", () => {
    for (const badPath of [
      "../evil.txt",
      "/etc/passwd",
      "C:\\Windows\\evil",
      "a/../../evil.txt",
      "a/..",
    ]) {
      const check = validateCreateSkillParams({
        ...validArgs(),
        files: [
          { path: "SKILL.md", content: SKILL_MD("demo-skill") },
          { path: badPath, content: "x" },
        ],
      });
      expect(check).toMatchObject({ ok: false });
      if (!check.ok) expect(check.reason).toContain(badPath);
    }
  });

  it("空 path 拒绝", () => {
    const check = validateCreateSkillParams({
      ...validArgs(),
      files: [
        { path: "SKILL.md", content: SKILL_MD("demo-skill") },
        { path: "  ", content: "x" },
      ],
    });
    expect(check).toMatchObject({ ok: false });
    if (!check.ok) expect(check.reason).toContain("路径");
  });

  it("条目数超过 20 拒绝", () => {
    const files = [
      { path: "SKILL.md", content: SKILL_MD("demo-skill") },
      ...Array.from({ length: 20 }, (_, i) => ({
        path: `f${i}.md`,
        content: "x",
      })),
    ];
    const check = validateCreateSkillParams({ ...validArgs(), files });
    expect(check).toMatchObject({ ok: false });
    if (!check.ok) expect(check.reason).toContain("20");
  });

  it("单文件超过 256KB 拒绝", () => {
    const check = validateCreateSkillParams({
      ...validArgs(),
      files: [
        { path: "SKILL.md", content: SKILL_MD("demo-skill") },
        { path: "big.bin", content: "a".repeat(256 * KB + 1) },
      ],
    });
    expect(check).toMatchObject({ ok: false });
    if (!check.ok) expect(check.reason).toContain("单文件");
  });

  it("总量超过 1MB 拒绝(单文件均未超限)", () => {
    const files = [
      { path: "SKILL.md", content: SKILL_MD("demo-skill") },
      ...Array.from({ length: 5 }, (_, i) => ({
        path: `f${i}.bin`,
        content: "a".repeat(250 * KB),
      })),
    ];
    const check = validateCreateSkillParams({ ...validArgs(), files });
    expect(check).toMatchObject({ ok: false });
    if (!check.ok) expect(check.reason).toContain("总量");
  });

  it("zod 层拒绝(缺 description/description 超长/空 files/结构错)", () => {
    expect(
      validateCreateSkillParams({
        name: "demo-skill",
        files: [{ path: "SKILL.md", content: SKILL_MD("demo-skill") }],
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateCreateSkillParams({
        ...validArgs(),
        description: "x".repeat(201),
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateCreateSkillParams({ ...validArgs(), files: [] }),
    ).toMatchObject({ ok: false });
    expect(validateCreateSkillParams("not-an-object")).toMatchObject({
      ok: false,
    });
  });
});

describe("makeCreateSkillTool", () => {
  it("元信息:name/kind", () => {
    const { prisma } = createPrismaStub();
    const tool = makeCreateSkillTool({ skillsRoot, prisma });
    expect(tool.name).toBe("create_skill");
    expect(tool.kind).toBe("write");
  });

  it("成功:落盘到 skillsRoot/<name> 并 upsert(source local),返回成功文案", async () => {
    const { prisma, upsertCalls } = createPrismaStub();
    const tool = makeCreateSkillTool({ skillsRoot, prisma });
    const args = validArgs();
    const out = await tool.execute(
      { workspacePath: skillsRoot, sessionId: 1 },
      args,
    );
    expect(out).toBe("已创建技能 demo-skill,可在技能页管理,下次对话即可使用");
    expect(
      readFileSync(path.join(skillsRoot, "demo-skill", "SKILL.md"), "utf8"),
    ).toBe(args.files[0]!.content);
    expect(
      readFileSync(
        path.join(skillsRoot, "demo-skill", "references", "guide.md"),
        "utf8",
      ),
    ).toBe("# 指南");
    expect(upsertCalls.length).toBe(1);
    expect(upsertCalls[0]).toMatchObject({
      where: { name: "demo-skill" },
      create: {
        name: "demo-skill",
        slug: null,
        version: null,
        source: "local",
        dir: path.join(skillsRoot, "demo-skill"),
        description: "示例技能",
      },
    });
  });

  it("同名目录已存在:返回指定错误串,不落盘不写库", async () => {
    mkdirSync(path.join(skillsRoot, "demo-skill"), { recursive: true });
    const { prisma, upsertCalls } = createPrismaStub();
    const tool = makeCreateSkillTool({ skillsRoot, prisma });
    const out = await tool.execute(
      { workspacePath: skillsRoot, sessionId: 1 },
      validArgs(),
    );
    expect(out).toBe("错误: 技能已存在,请先在技能页卸载后重试");
    expect(upsertCalls.length).toBe(0);
  });

  it("坏参数:错误串回喂且不建目录", async () => {
    const { prisma, upsertCalls } = createPrismaStub();
    const tool = makeCreateSkillTool({ skillsRoot, prisma });
    const out = await tool.execute(
      { workspacePath: skillsRoot, sessionId: 1 },
      { ...validArgs(), files: [{ path: "README.md", content: "x" }] },
    );
    expect(out.startsWith("错误:")).toBe(true);
    expect(out).toContain("SKILL.md");
    expect(existsSync(path.join(skillsRoot, "demo-skill"))).toBe(false);
    expect(upsertCalls.length).toBe(0);
  });

  it("写盘中途失败:清理半成品目录,不写库,返回错误串", async () => {
    const { prisma, upsertCalls } = createPrismaStub();
    const tool = makeCreateSkillTool({ skillsRoot, prisma });
    // "a" 先落为文件,随后 "a/b.txt" 的父目录创建抛 ENOTDIR → 中途失败
    const out = await tool.execute(
      { workspacePath: skillsRoot, sessionId: 1 },
      {
        ...validArgs(),
        files: [
          { path: "SKILL.md", content: SKILL_MD("demo-skill") },
          { path: "a", content: "file-then-dir" },
          { path: "a/b.txt", content: "y" },
        ],
      },
    );
    expect(out.startsWith("错误:")).toBe(true);
    expect(existsSync(path.join(skillsRoot, "demo-skill"))).toBe(false);
    expect(upsertCalls.length).toBe(0);
  });
});

describe("P-E 埋点(create 事件)", () => {
  it("创建成功 → 记 {name, create};埋点抛错不影响工具结果", async () => {
    const create = vi.fn().mockResolvedValue({});
    const { prisma } = createPrismaStub();
    const tool = makeCreateSkillTool({
      skillsRoot,
      prisma,
      statRecord: { create } as SkillStatPrismaLike,
    });
    const out = await tool.execute(
      { workspacePath: skillsRoot, sessionId: 1 },
      validArgs(),
    );
    expect(out).toContain("已创建技能 demo-skill");
    await vi.waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        data: { name: "demo-skill", event: "create" },
      }),
    );

    // swallow:埋点失败(表锁)不改变 create_skill 成功语义(换新目录防同名冲突)
    const failing = vi.fn().mockRejectedValue(new Error("table locked"));
    const ok = await makeCreateSkillTool({
      skillsRoot: mkdtempSync(path.join(tmpdir(), "create-skill-2")),
      prisma: createPrismaStub().prisma,
      statRecord: { create: failing } as SkillStatPrismaLike,
    }).execute({ workspacePath: skillsRoot, sessionId: 1 }, validArgs());
    expect(ok).toContain("已创建技能 demo-skill");
  });

  it("statRecord 缺席(既有测试形态)→ 不记录也不报错", async () => {
    const { prisma, upsertCalls } = createPrismaStub();
    const tool = makeCreateSkillTool({ skillsRoot, prisma });
    const out = await tool.execute(
      { workspacePath: skillsRoot, sessionId: 1 },
      validArgs(),
    );
    expect(out).toContain("已创建技能 demo-skill");
    expect(upsertCalls.length).toBe(1);
  });
});

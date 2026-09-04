/**
 * skill-loader 单测：临时目录矩阵（参照 file-tools.test.ts 模式）
 */
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadSkills,
  parseFrontmatter,
} from "../../electron/domains/ai/agent/skill-loader";

let root: string;
let userDir: string;
let wsDir: string;

/** 在 base 下建一个含 SKILL.md 的 skill 条目目录 */
const makeSkill = (base: string, entry: string, content: string) => {
  mkdirSync(path.join(base, entry), { recursive: true });
  writeFileSync(path.join(base, entry, "SKILL.md"), content);
};

const SKILL = (name: string, description: string, body = "技能正文") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "skills-"));
  userDir = path.join(root, "user-skills");
  wsDir = path.join(root, "ws-skills");
  mkdirSync(userDir);
  mkdirSync(wsDir);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("loadSkills 两级加载", () => {
  it("同名时用户级优先，工作区级其余 skill 保留", () => {
    makeSkill(userDir, "greeting", SKILL("greeting", "用户级问候"));
    makeSkill(wsDir, "greeting", SKILL("greeting", "工作区级问候"));
    makeSkill(wsDir, "ws-only", SKILL("ws-only", "仅工作区"));

    const skills = loadSkills([
      { dir: userDir, source: "user" },
      { dir: wsDir, source: "workspace" },
    ]);

    expect(skills.map((s) => s.name)).toEqual(["greeting", "ws-only"]);
    const greeting = skills.find((s) => s.name === "greeting")!;
    expect(greeting.description).toBe("用户级问候");
    expect(greeting.source).toBe("user");
    expect(skills.find((s) => s.name === "ws-only")!.source).toBe("workspace");
  });

  it("SkillInfo 含 name/description/dir/bodyPath/source 且 bodyPath 可读", () => {
    makeSkill(userDir, "demo", SKILL("demo", "示例", "第一行正文"));
    const [skill] = loadSkills([{ dir: userDir, source: "user" }]);

    expect(skill).toBeDefined();
    expect(skill!.name).toBe("demo");
    expect(skill!.description).toBe("示例");
    expect(skill!.dir).toBe(path.join(userDir, "demo"));
    expect(skill!.bodyPath).toBe(path.join(userDir, "demo", "SKILL.md"));
  });

  it("无 frontmatter 的 SKILL.md 跳过", () => {
    makeSkill(userDir, "raw", "没有 frontmatter 的普通正文");
    expect(loadSkills([{ dir: userDir, source: "user" }])).toEqual([]);
  });

  it("缺 description 的 SKILL.md 跳过", () => {
    makeSkill(userDir, "only-name", "---\nname: only-name\n---\n正文");
    expect(loadSkills([{ dir: userDir, source: "user" }])).toEqual([]);
  });

  it("缺 name 的 SKILL.md 跳过", () => {
    makeSkill(userDir, "no-name", "---\ndescription: 只有描述\n---\n正文");
    expect(loadSkills([{ dir: userDir, source: "user" }])).toEqual([]);
  });

  it("无 SKILL.md 的目录项与散落文件忽略", () => {
    mkdirSync(path.join(userDir, "empty-entry"));
    writeFileSync(path.join(userDir, "stray.md"), "---\nname: x\n---\n");
    makeSkill(userDir, "real", SKILL("real", "真实技能"));

    const skills = loadSkills([{ dir: userDir, source: "user" }]);
    expect(skills.map((s) => s.name)).toEqual(["real"]);
  });

  it("frontmatter name 与目录名不一致时以 frontmatter 为准（含空格保留原样）", () => {
    makeSkill(userDir, "01-greet", SKILL("hello world", "目录名仅作定位"));

    const skills = loadSkills([{ dir: userDir, source: "user" }]);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe("hello world");
    expect(skills[0]!.dir).toBe(path.join(userDir, "01-greet"));
  });

  it("非法目录（不存在/是文件）静默跳过，合法目录不受影响", () => {
    makeSkill(userDir, "ok", SKILL("ok", "合法"));
    const fileAsDir = path.join(root, "a-file.txt");
    writeFileSync(fileAsDir, "x");

    const skills = loadSkills([
      { dir: path.join(root, "not-exist"), source: "user" },
      { dir: fileAsDir, source: "user" },
      { dir: userDir, source: "workspace" },
    ]);
    expect(skills.map((s) => s.name)).toEqual(["ok"]);
    expect(skills[0]!.source).toBe("workspace");
  });

  it("空 dirs 数组返回空列表", () => {
    expect(loadSkills([])).toEqual([]);
  });
});

describe("parseFrontmatter", () => {
  it("标准块提取 name 与 description", () => {
    expect(
      parseFrontmatter("---\nname: demo\ndescription: 示例\n---\n正文"),
    ).toEqual({ name: "demo", description: "示例" });
  });

  it("无包裹块返回空字段", () => {
    expect(parseFrontmatter("普通文本\nname: 不算数")).toEqual({});
  });

  it("无结束 --- 的残缺块返回空字段", () => {
    expect(parseFrontmatter("---\nname: a\n")).toEqual({});
  });

  it("多字段块只取所需两字段", () => {
    const raw =
      "---\nname: a\nversion: 1.0\ndescription: b\nlicense: MIT\n---\nbody";
    expect(parseFrontmatter(raw)).toEqual({ name: "a", description: "b" });
  });

  it("值中可含冒号，键后空格可选", () => {
    expect(parseFrontmatter("---\nname:a\n---\n")).toEqual({
      name: "a",
      description: undefined,
    });
    expect(parseFrontmatter("---\nname: a: b\n---\n")).toMatchObject({
      name: "a: b",
    });
  });

  it("空值不匹配（需非空内容）", () => {
    expect(parseFrontmatter("---\nname:\ndescription:\n---\n")).toEqual({});
  });

  it("包裹块外的同名行不参与解析", () => {
    const raw = "---\nname: real\n---\n正文\ndescription: 块外不算";
    expect(parseFrontmatter(raw)).toEqual({
      name: "real",
      description: undefined,
    });
  });
});

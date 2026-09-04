/**
 * read_skill 内置工具单测：临时目录造 SKILL.md（参照 skill-loader.test.ts 模式）
 */
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSkills } from "../../electron/domains/ai/agent/skill-loader";
import type { SkillInfo } from "../../electron/domains/ai/agent/skill-loader";
import { makeReadSkillTool } from "../../electron/domains/ai/agent/read-skill";

let root: string;
let userDir: string;
let skills: SkillInfo[];

const SKILL = (name: string, description: string, body = "技能正文") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

const makeSkill = (base: string, entry: string, content: string) => {
  mkdirSync(path.join(base, entry), { recursive: true });
  writeFileSync(path.join(base, entry, "SKILL.md"), content);
};

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "read-skill-"));
  userDir = path.join(root, "user-skills");
  mkdirSync(userDir);
  makeSkill(
    userDir,
    "greeting",
    SKILL("greeting", "问候", "你好，我是问候技能"),
  );
  makeSkill(userDir, "deploy", SKILL("deploy", "部署"));
  skills = loadSkills([{ dir: userDir, source: "user" }]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("read_skill 元信息", () => {
  it("name/description/kind 符合规范", () => {
    const tool = makeReadSkillTool(skills);
    expect(tool.name).toBe("read_skill");
    expect(tool.description).toBe(
      "读取指定技能的完整使用指引（SKILL.md 正文）",
    );
    expect(tool.kind).toBe("read");
  });
});

describe("read_skill execute", () => {
  it("存在名返回 SKILL.md 全文（含 frontmatter）", async () => {
    const tool = makeReadSkillTool(skills);
    const out = await tool.execute(
      { workspacePath: root, sessionId: 1 },
      {
        name: "greeting",
      },
    );
    expect(out).toBe(SKILL("greeting", "问候", "你好，我是问候技能"));
  });

  it("未知名返回错误串且不触发任何文件读取（无 throw）", async () => {
    const tool = makeReadSkillTool(skills);
    await expect(
      tool.execute({ workspacePath: root, sessionId: 1 }, { name: "no-such" }),
    ).resolves.toBe("错误: 技能不存在");
    // 表内查不到即返回：即使所有 bodyPath 均不可读，也只报"不存在"而非"读取失败"
    const broken = makeReadSkillTool([
      {
        name: "ghost",
        description: "占位",
        dir: root,
        bodyPath: path.join(root, "missing", "SKILL.md"),
        source: "user",
      },
    ]);
    await expect(
      broken.execute({ workspacePath: root, sessionId: 1 }, { name: "ghost" }),
    ).resolves.toBe("错误: 技能文件读取失败");
    await expect(
      broken.execute({ workspacePath: root, sessionId: 1 }, { name: "other" }),
    ).resolves.toBe("错误: 技能不存在");
  });

  it("路径穿越式 name 不拼路径，只查表返回不存在", async () => {
    const tool = makeReadSkillTool(skills);
    await expect(
      tool.execute(
        { workspacePath: root, sessionId: 1 },
        {
          name: "../outside/secret",
        },
      ),
    ).resolves.toBe("错误: 技能不存在");
  });

  it("文件总字节超过 256KB 时按字节截断至上限并追加尾部标记", async () => {
    // 正文 + frontmatter 整体超限；frontmatter 用纯 ASCII 保证断言可精确预测
    const big = "a".repeat(300 * 1024);
    makeSkill(userDir, "big", SKILL("big", "big-file", big));
    const all = loadSkills([{ dir: userDir, source: "user" }]);
    const tool = makeReadSkillTool(all);
    const out = await tool.execute(
      { workspacePath: root, sessionId: 1 },
      {
        name: "big",
      },
    );
    const full = SKILL("big", "big-file", big);
    expect(out).toBe(
      Buffer.from(full, "utf8")
        .subarray(0, 256 * 1024)
        .toString("utf8") + "\n…（已截断）",
    );
  });

  it("文件总字节恰好 256KB 不截断", async () => {
    const prefix = "---\nname: exact\ndescription: exact-limit\n---\n";
    const body = "b".repeat(256 * 1024 - Buffer.byteLength(prefix) - 1);
    makeSkill(userDir, "exact", prefix + body + "\n");
    const all = loadSkills([{ dir: userDir, source: "user" }]);
    const tool = makeReadSkillTool(all);
    const out = await tool.execute(
      { workspacePath: root, sessionId: 1 },
      {
        name: "exact",
      },
    );
    expect(out).toBe(prefix + body + "\n");
  });

  it("bodyPath 读取失败（不存在）返回错误串", async () => {
    const ghost: SkillInfo = {
      name: "ghost",
      description: "占位",
      dir: root,
      bodyPath: path.join(root, "no-such-dir", "SKILL.md"),
      source: "user",
    };
    const tool = makeReadSkillTool([ghost]);
    await expect(
      tool.execute({ workspacePath: root, sessionId: 1 }, { name: "ghost" }),
    ).resolves.toBe("错误: 技能文件读取失败");
  });
});

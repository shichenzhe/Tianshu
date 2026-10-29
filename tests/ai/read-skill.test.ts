/**
 * read_skill 内置工具单测：临时目录造 SKILL.md（参照 skill-loader.test.ts 模式）
 */
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
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
      "读取技能使用指引：传技能名读 SKILL.md 正文；可传 path 读技能包内文件（如 references/jira.md）",
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

  it("传入全量启用集即可读任意启用技能（项目挂载集是预设，不收窄工具）", async () => {
    // 模拟项目会话预设语义：即使挂载预设只含 greeting，工具收全量集
    const tool = makeReadSkillTool(skills);
    await expect(
      tool.execute({ workspacePath: root, sessionId: 1 }, { name: "deploy" }),
    ).resolves.toBe(SKILL("deploy", "部署"));
    await expect(
      tool.execute({ workspacePath: root, sessionId: 1 }, { name: "no-such" }),
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

describe("read_skill path 子文件读取（技能包内 references 等）", () => {
  let refDir: string;

  beforeEach(() => {
    refDir = path.join(userDir, "greeting", "references");
    mkdirSync(refDir, { recursive: true });
    writeFileSync(path.join(refDir, "jira.md"), "# jira 命令详解\n");
  });

  it("传 path 返回包内子文件内容", async () => {
    const tool = makeReadSkillTool(skills);
    await expect(
      tool.execute(
        { workspacePath: root, sessionId: 1 },
        { name: "greeting", path: "references/jira.md" },
      ),
    ).resolves.toBe("# jira 命令详解\n");
  });

  it("path 穿越出技能目录返回越界错误", async () => {
    const tool = makeReadSkillTool(skills);
    await expect(
      tool.execute(
        { workspacePath: root, sessionId: 1 },
        { name: "greeting", path: "../outside.md" },
      ),
    ).resolves.toBe("错误: 路径超出技能目录");
  });

  it("path 为绝对路径时拒绝", async () => {
    const tool = makeReadSkillTool(skills);
    await expect(
      tool.execute(
        { workspacePath: root, sessionId: 1 },
        { name: "greeting", path: path.join(root, "outside.md") },
      ),
    ).resolves.toBe("错误: 路径超出技能目录");
  });

  it("path 指向不存在文件返回读取失败", async () => {
    const tool = makeReadSkillTool(skills);
    await expect(
      tool.execute(
        { workspacePath: root, sessionId: 1 },
        { name: "greeting", path: "references/no-such.md" },
      ),
    ).resolves.toBe("错误: 技能文件读取失败");
  });

  it("path 指向目录返回读取失败", async () => {
    const tool = makeReadSkillTool(skills);
    await expect(
      tool.execute(
        { workspacePath: root, sessionId: 1 },
        { name: "greeting", path: "references" },
      ),
    ).resolves.toBe("错误: 技能文件读取失败");
  });

  it("包内 symlink 指向包外被 realpath 二次校验拒绝", async () => {
    writeFileSync(path.join(root, "secret.md"), "机密");
    symlinkSync(path.join(root, "secret.md"), path.join(refDir, "link.md"));
    const tool = makeReadSkillTool(skills);
    await expect(
      tool.execute(
        { workspacePath: root, sessionId: 1 },
        { name: "greeting", path: "references/link.md" },
      ),
    ).resolves.toBe("错误: 路径超出技能目录");
  });

  it("子文件超过 256KB 按字节截断并追加尾部标记", async () => {
    writeFileSync(path.join(refDir, "big.md"), "a".repeat(300 * 1024));
    const tool = makeReadSkillTool(skills);
    const out = await tool.execute(
      { workspacePath: root, sessionId: 1 },
      { name: "greeting", path: "references/big.md" },
    );
    expect(out).toBe("a".repeat(256 * 1024) + "\n…（已截断）");
  });

  it("子文件含 NUL 二进制内容返回不支持读取", async () => {
    writeFileSync(
      path.join(refDir, "bin.md"),
      Buffer.from([0x61, 0x00, 0x62]),
    );
    const tool = makeReadSkillTool(skills);
    await expect(
      tool.execute(
        { workspacePath: root, sessionId: 1 },
        { name: "greeting", path: "references/bin.md" },
      ),
    ).resolves.toBe("错误: 文件含二进制内容（NUL），不支持读取");
  });

  it("子文件成功读取触发 onRead；越界与读败不触发", async () => {
    let fired = 0;
    const tool = makeReadSkillTool(skills, () => {
      fired++;
    });
    await tool.execute(
      { workspacePath: root, sessionId: 1 },
      { name: "greeting", path: "references/jira.md" },
    );
    await tool.execute(
      { workspacePath: root, sessionId: 1 },
      { name: "greeting", path: "../outside.md" },
    );
    await tool.execute(
      { workspacePath: root, sessionId: 1 },
      { name: "greeting", path: "references/no-such.md" },
    );
    expect(fired).toBe(1);
  });
});

describe("read_skill onRead 钩子（读取即意图信号，工作流组开门依据）", () => {
  it("成功读取后以 (ctx, skill) 触发，返回串以空行追加在正文尾", async () => {
    const calls: Array<{ sessionId: number; name: string }> = [];
    const tool = makeReadSkillTool(skills, (ctx, skill) => {
      calls.push({ sessionId: ctx.sessionId, name: skill.name });
      return "（系统注：测试尾注）";
    });
    const out = await tool.execute(
      { workspacePath: root, sessionId: 7 },
      { name: "greeting" },
    );
    expect(out).toBe(
      SKILL("greeting", "问候", "你好，我是问候技能") +
        "\n\n（系统注：测试尾注）",
    );
    expect(calls).toEqual([{ sessionId: 7, name: "greeting" }]);
  });

  it("onRead 缺席或返回 void：正文原样（既有调用方零改动）", async () => {
    const plain = makeReadSkillTool(skills);
    await expect(
      plain.execute(
        { workspacePath: root, sessionId: 1 },
        { name: "greeting" },
      ),
    ).resolves.toBe(SKILL("greeting", "问候", "你好，我是问候技能"));
    const silent = makeReadSkillTool(skills, () => undefined);
    await expect(
      silent.execute({ workspacePath: root, sessionId: 1 }, { name: "deploy" }),
    ).resolves.toBe(SKILL("deploy", "部署"));
  });

  it("技能不存在/文件读取失败不触发钩子（仅成功读取构成意图）", async () => {
    let fired = 0;
    const tool = makeReadSkillTool(skills, () => {
      fired++;
    });
    await tool.execute(
      { workspacePath: root, sessionId: 1 },
      { name: "no-such" },
    );
    const broken = makeReadSkillTool(
      [
        {
          name: "ghost",
          description: "占位",
          dir: root,
          bodyPath: path.join(root, "missing", "SKILL.md"),
          source: "user",
        },
      ],
      () => {
        fired++;
      },
    );
    await broken.execute(
      { workspacePath: root, sessionId: 1 },
      { name: "ghost" },
    );
    expect(fired).toBe(0);
  });

  it("超限截断路径同样触发钩子，尾注落在截断标记之后", async () => {
    const big = "a".repeat(300 * 1024);
    makeSkill(userDir, "big2", SKILL("big2", "big-file", big));
    const all = loadSkills([{ dir: userDir, source: "user" }]);
    const tool = makeReadSkillTool(all, () => "（系统注：截断尾注）");
    const out = await tool.execute(
      { workspacePath: root, sessionId: 1 },
      { name: "big2" },
    );
    expect(out.endsWith("\n…（已截断）\n\n（系统注：截断尾注）")).toBe(true);
  });
});

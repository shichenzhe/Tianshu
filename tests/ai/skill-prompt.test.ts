/**
 * buildSystemPrompt 单测：技能清单渐进披露注入（spec §2 模板逐字）
 */
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../../electron/domains/ai/agent/skill-prompt";
import type { SkillInfo } from "../../electron/domains/ai/agent/skill-loader";

/** 最小 SkillInfo 构造（本函数只消费 name/description 两字段） */
const skill = (name: string, description: string): SkillInfo => ({
  name,
  description,
  dir: `/tmp/skills/${name}`,
  bodyPath: `/tmp/skills/${name}/SKILL.md`,
  source: "user",
});

describe("buildSystemPrompt", () => {
  it("无 skills 时原样返回 base", () => {
    expect(buildSystemPrompt("你是助手", [])).toBe("你是助手");
  });

  it("无 skills 且 base 为 undefined 时返回 undefined", () => {
    expect(buildSystemPrompt(undefined, [])).toBeUndefined();
  });

  it("base undefined + skills → 仅技能段（无前缀空行）", () => {
    expect(buildSystemPrompt(undefined, [skill("greeting", "问候")])).toBe(
      "你可以使用以下技能（调用 read_skill 工具并传入技能名可获取完整使用指引）：\n- greeting: 问候",
    );
  });

  it("base 存在 → base + 空行 + 技能段，含全部 name: description 行", () => {
    expect(
      buildSystemPrompt("你是助手", [
        skill("greeting", "问候"),
        skill("web-search", "联网搜索"),
      ]),
    ).toBe(
      "你是助手\n\n" +
        "你可以使用以下技能（调用 read_skill 工具并传入技能名可获取完整使用指引）：\n" +
        "- greeting: 问候\n" +
        "- web-search: 联网搜索",
    );
  });

  it("换行与空行拼接精确（快照锚定模板）", () => {
    expect(
      buildSystemPrompt("BASE", [skill("a", "描述 A"), skill("b", "描述 B")]),
    ).toMatchInlineSnapshot(`
      "BASE

      你可以使用以下技能（调用 read_skill 工具并传入技能名可获取完整使用指引）：
      - a: 描述 A
      - b: 描述 B"
    `);
  });
});

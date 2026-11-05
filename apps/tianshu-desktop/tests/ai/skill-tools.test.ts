/**
 * per-skill 工具声明（skills-tools-mcp §6-1）：SKILL.md frontmatter 可选
 * `tools` 字段——挂载该技能时附加注入对应工具组（「技能即开关」泛化，
 * WORKFLOW_CREATOR_SKILL_NAME 三信号先例）。覆盖：loader 解析 →
 * tool-groups 挂载信号 → filterToolsBySession 注入门。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  loadSkills,
  parseFrontmatter,
} from "../../electron/domains/ai/agent/skill-loader";
import {
  filterToolsBySession,
  skillDeclaredGroups,
  type ToolGroupGate,
} from "../../electron/domains/ai/agent/tool-groups";
import { SKILL_TOOL_GROUPS } from "@tianshu/protocol";

const def = (name: string) => ({ name });
const names = (defs: Array<{ name: string }>) => defs.map((d) => d.name);
const gate = (o: Partial<ToolGroupGate> = {}): ToolGroupGate => ({
  scenario: null,
  assistantBound: false,
  workflowCreatorEnabled: false,
  ...o,
});

describe("parseFrontmatter（tools 字段）", () => {
  it("逗号分隔解析：tools: workflow → ['workflow']", () => {
    expect(
      parseFrontmatter("---\nname: a\ndescription: d\ntools: workflow\n---\n")
        .tools,
    ).toEqual(["workflow"]);
  });

  it("空格/中文逗号混合分隔：workflow, expert 双组", () => {
    expect(
      parseFrontmatter("---\nname: a\ndescription: d\ntools: workflow， expert\n---\n")
        .tools,
    ).toEqual(["workflow", "expert"]);
  });

  it("无 tools 字段/空值为 undefined（增量兼容——存量 SKILL.md 零影响）", () => {
    expect(parseFrontmatter("---\nname: a\ndescription: d\n---\n").tools).toBe(
      undefined,
    );
    expect(parseFrontmatter("---\nname: a\ndescription: d\ntools:\n---\n").tools).toBe(
      undefined,
    );
  });

  it("未知组名原样保留（值域过滤在门控层收口——loader 保持零依赖）", () => {
    expect(
      parseFrontmatter("---\nname: a\ndescription: d\ntools: bogus workflow\n---\n")
        .tools,
    ).toEqual(["bogus", "workflow"]);
  });
});

describe("loadSkills（tools 随 SkillInfo 透出）", () => {
  const makeSkill = (root: string, dirName: string, raw: string) => {
    const skillDir = path.join(root, dirName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), raw);
  };

  it("tools 进入 SkillInfo；未声明技能不带该列", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "skill-tools-"));
    try {
      makeSkill(
        root,
        "with-tools",
        "---\nname: with-tools\ndescription: d\ntools: workflow\n---\n正文",
      );
      makeSkill(
        root,
        "plain",
        "---\nname: plain\ndescription: d\n---\n正文",
      );
      const skills = loadSkills([{ dir: root, source: "user" }]);
      const withTools = skills.find((s) => s.name === "with-tools");
      const plain = skills.find((s) => s.name === "plain");
      expect(withTools?.tools).toEqual(["workflow"]);
      expect(plain?.tools).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("skillDeclaredGroups + filterToolsBySession（挂载信号源）", () => {
  const spectrum = () =>
    [
      "read",
      "write",
      "bash",
      "workflow_write",
      "run_workflow",
      "show_table",
      "create_expert",
      "update_expert",
      "mcp__srv__tool",
    ].map(def);

  it("声明集并集：多技能声明去重合并，未知组名过滤（协议值域单源）", () => {
    const groups = skillDeclaredGroups([
      { name: "a", tools: ["workflow", "bogus"] },
      { name: "b", tools: ["workflow", "expert"] },
      { name: "c" },
    ]);
    expect([...groups].sort()).toEqual(["expert", "workflow"]);
    for (const group of groups) {
      expect(SKILL_TOOL_GROUPS).toContain(group);
    }
  });

  it("workflow 声明挂载工作流+展示组（daily 场景同挂——技能即开关）", () => {
    const kept = names(
      filterToolsBySession(
        spectrum(),
        gate({ scenario: "daily", skillGroups: new Set(["workflow"]) }),
      ),
    );
    expect(kept).toContain("workflow_write");
    expect(kept).toContain("run_workflow");
    expect(kept).toContain("show_table");
  });

  it("expert 声明挂载专家组（未绑专家/非 experts 场景同挂）", () => {
    const kept = names(
      filterToolsBySession(spectrum(), gate({ skillGroups: new Set(["expert"]) })),
    );
    expect(kept).toContain("create_expert");
    expect(kept).toContain("update_expert");
    // 工作流组不受 expert 声明影响
    expect(kept).not.toContain("workflow_write");
  });

  it("无声明会话行为不变：daily 空门控不带门控组（零漂移）", () => {
    const kept = names(filterToolsBySession(spectrum(), gate({ scenario: "daily" })));
    expect(kept).not.toContain("workflow_write");
    expect(kept).not.toContain("create_expert");
    expect(kept).toContain("mcp__srv__tool");
  });
});

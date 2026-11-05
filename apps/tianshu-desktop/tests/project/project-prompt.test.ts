import { describe, expect, it } from "vitest";
import { buildProjectSystemBase } from "../../electron/domains/project/project-prompt";

describe("buildProjectSystemBase", () => {
  it("项目指令在前，专家 prompt 依序拼接（\n\n 分隔）", () => {
    const result = buildProjectSystemBase({
      projectName: "p",
      systemPrompt: "你是项目管理专家",
      boundAssistantPrompts: ["专家A", "专家B"],
      boundSkillNames: [],
      boundConnectorNames: [],
    });
    expect(result).toBe("你是项目管理专家\n\n专家A\n\n专家B");
  });

  it("全部为空 → undefined", () => {
    expect(
      buildProjectSystemBase({
        projectName: "p",
        systemPrompt: null,
        boundAssistantPrompts: [],
        boundSkillNames: [],
        boundConnectorNames: [],
      }),
    ).toBeUndefined();
  });

  it("无项目指令但有专家 → 仅专家拼接", () => {
    const result = buildProjectSystemBase({
      projectName: "p",
      systemPrompt: null,
      boundAssistantPrompts: ["A"],
      boundSkillNames: [],
      boundConnectorNames: [],
    });
    expect(result).toBe("A");
  });

  it("有挂载能力时附加可用能力软约束声明段", () => {
    const result = buildProjectSystemBase({
      projectName: "p",
      systemPrompt: "指令",
      boundAssistantPrompts: [],
      boundSkillNames: ["技能1"],
      boundConnectorNames: ["连接器1"],
    });
    expect(result).toContain("技能1");
    expect(result).toContain("连接器1");
  });

  it("memoryMarkdown 非空 → 「项目记忆」段拼在指令之后、能力声明之前（批8 P0）", () => {
    const result = buildProjectSystemBase({
      projectName: "p",
      systemPrompt: "指令",
      boundAssistantPrompts: [],
      boundSkillNames: ["技能1"],
      boundConnectorNames: [],
      memoryMarkdown: "## [2026-11-05 06:30] 交接\n已敲定方案",
    });
    expect(result?.startsWith("指令")).toBe(true);
    expect(result).toContain("项目记忆");
    expect(result).toContain("## [2026-11-05 06:30] 交接\n已敲定方案");
    expect(result!.indexOf("项目记忆")).toBeLessThan(
      result!.indexOf("【项目预设能力】"),
    );
  });

  it("仅记忆无指令/能力 → 记忆段独立成 base；memoryMarkdown null → 无记忆段", () => {
    const onlyMemory = buildProjectSystemBase({
      projectName: "p",
      systemPrompt: null,
      boundAssistantPrompts: [],
      boundSkillNames: [],
      boundConnectorNames: [],
      memoryMarkdown: "## [2026-11-05 06:30] 交接\n决议",
    });
    expect(onlyMemory).toContain("项目记忆");
    expect(onlyMemory).toContain("决议");

    const noMemory = buildProjectSystemBase({
      projectName: "p",
      systemPrompt: "指令",
      boundAssistantPrompts: [],
      boundSkillNames: [],
      boundConnectorNames: [],
      memoryMarkdown: null,
    });
    expect(noMemory).toBe("指令");
  });
});

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
});

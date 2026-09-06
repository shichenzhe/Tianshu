import { describe, expect, it } from "vitest";
import { computeUsageBreakdown } from "../../electron/domains/ai/chat/context-usage";
import { buildSystemPrompt } from "../../electron/domains/ai/agent/skill-prompt";
import type { SkillInfo } from "../../electron/domains/ai/agent/skill-loader";
import type { ToolDefinition } from "../../electron/domains/ai/agent/file-tools";

const def = (name: string): ToolDefinition =>
  ({
    name,
    description: `${name} tool`,
    parameters: [],
  }) as unknown as ToolDefinition;

const msg = (text: string) => ({
  role: "user" as const,
  blocks: JSON.stringify([{ type: "text", text }]),
});

const skills: SkillInfo[] = [
  {
    name: "demo-skill",
    description: "演示技能描述",
    dir: "/skills/demo-skill",
    bodyPath: "/skills/demo-skill/SKILL.md",
    source: "user",
  },
];

describe("上下文用量拆解", () => {
  it("五类拆分：system 去技能段、tools/mcp 按前缀、messages 全量", () => {
    // 技能段用真实 buildSystemPrompt 输出拼接，与 SKILL_SECTION_HEADER 文案解耦
    const skillsSection = buildSystemPrompt(undefined, skills) ?? "";
    const wholeSystem = `基础人设\n\n${skillsSection}`;
    const result = computeUsageBreakdown({
      systemWithSummary: wholeSystem,
      skills,
      toolDefinitions: [def("read_file"), def("mcp__github__issue")],
      history: [msg("a"), msg("b")],
      contextWindow: 131072,
      params: {},
    });
    expect(result.system).toBeGreaterThan(0);
    expect(result.skills).toBeGreaterThan(0);
    expect(result.system + result.skills).toBe(
      Math.ceil(wholeSystem.length / 2),
    );
    expect(result.tools).toBeGreaterThan(0);
    expect(result.mcp).toBeGreaterThan(0);
    expect(result.messages).toBe(2);
    expect(result.total).toBe(
      result.system +
        result.skills +
        result.tools +
        result.mcp +
        result.messages,
    );
  });

  it("无技能无 MCP 时对应项为 0 且 system 为全量", () => {
    const result = computeUsageBreakdown({
      systemWithSummary: "人设",
      skills: [],
      toolDefinitions: [def("read_file")],
      history: [msg("a")],
      contextWindow: 8192,
      params: {},
    });
    expect(result.skills).toBe(0);
    expect(result.mcp).toBe(0);
    expect(result.system).toBe(Math.ceil("人设".length / 2));
  });

  it("超窗时 messages 按截断后（含 reserve）计算而非全量", () => {
    const longHistory = Array.from({ length: 20 }, () => msg("t".repeat(200)));
    const result = computeUsageBreakdown({
      systemWithSummary: undefined,
      skills: [],
      toolDefinitions: [],
      history: longHistory,
      // budget = max(1, 500 - 0) → total 2000 超窗 → 滞回截到 400
      contextWindow: 500,
      params: {},
    });
    expect(result.messages).toBeLessThan(2000);
    expect(result.messages).toBeGreaterThan(0);
  });

  it("contextWindow 未配置时返回 null 分母且不截断", () => {
    const history = Array.from({ length: 50 }, () => msg("t".repeat(200)));
    const result = computeUsageBreakdown({
      systemWithSummary: "x",
      skills: [],
      toolDefinitions: [],
      history,
      contextWindow: null,
      params: {},
    });
    expect(result.contextWindow).toBeNull();
    expect(result.messages).toBe(5000);
  });
});

import { describe, expect, it } from "vitest";
import {
  buildTeamLeadSystem,
  parseTeamMembers,
  type TeamMember,
} from "../../electron/domains/ai/chat/expert-team";

const member: TeamMember = {
  id: "macro-analyst",
  name: "顾大局",
  profession: "宏观分析师",
  systemPrompt: "你是宏观分析师…",
};

describe("parseTeamMembers", () => {
  it("合法 JSON 解析；坏 JSON/非数组/缺字段成员回退剔除", () => {
    expect(parseTeamMembers(JSON.stringify([member]))).toEqual([member]);
    expect(parseTeamMembers("{bad")).toEqual([]);
    expect(parseTeamMembers('["x"]')).toEqual([]);
    expect(
      parseTeamMembers(
        JSON.stringify([{ ...member, systemPrompt: undefined }]),
      ),
    ).toEqual([]);
  });
  it("null/空串返回空数组", () => {
    expect(parseTeamMembers(null)).toEqual([]);
    expect(parseTeamMembers("")).toEqual([]);
  });
});

describe("buildTeamLeadSystem", () => {
  const members: TeamMember[] = [
    {
      id: "macro-analyst",
      name: "顾大局",
      profession: "宏观分析师",
      systemPrompt: "A",
    },
    {
      id: "risk-officer",
      name: "严守仓",
      profession: "风控官",
      systemPrompt: "B",
    },
  ];
  it("四段齐备：主理人原文/成员清单/铁律/工具说明", () => {
    const text = buildTeamLeadSystem({
      leadPrompt: "你是交易团主理人。",
      members,
    });
    expect(text).toContain("你是交易团主理人。");
    expect(text).toContain("macro-analyst｜顾大局（宏观分析师）");
    expect(text).toContain("risk-officer｜严守仓（风控官）");
    expect(text).toContain("严禁"); // 代写红线
    expect(text).toContain("context"); // 阶段传递
    expect(text).toContain("并行"); // 同阶段并行调度指引
    expect(text).toContain("同一次回复"); // 并行调用时机
    expect(text).toContain("dispatch");
  });
  it("空成员返回 null；withDispatch=false 时无铁律与工具说明", () => {
    expect(buildTeamLeadSystem({ leadPrompt: "x", members: [] })).toBeNull();
    const noDispatch = buildTeamLeadSystem({
      leadPrompt: "x",
      members,
      withDispatch: false,
    });
    expect(noDispatch).not.toContain("dispatch");
    expect(noDispatch).toContain("macro-analyst"); // 成员清单仍在（展示语义）
  });
});

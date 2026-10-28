/**
 * recommend_experts 工具单测（专家 2.0 Task 4）：纯 Node 工具，vitest 直测
 * （widget-tool/create-expert 先例）；ctx 不会被触达（无副作用渲染工具）。
 */
import { describe, expect, it } from "vitest";
import {
  makeRecommendExpertTool,
  RECOMMEND_TOOL_NAME,
} from "../../electron/domains/ai/agent/recommend-expert-tool";

describe("makeRecommendExpertTool", () => {
  it("合法 slug 输出确认文本含推荐数", async () => {
    const tool = makeRecommendExpertTool();
    const out = await tool.execute(
      {} as never,
      {
        candidates: ["code-review-expert", "sales-coach"],
        reason: "代码审查任务",
      } as never,
    );
    expect(out).toContain("2");
  });

  it("未知 slug 剔除；全无效返回错误文案", async () => {
    const tool = makeRecommendExpertTool();
    const out = await tool.execute(
      {} as never,
      {
        candidates: ["nope-1", "nope-2"],
        reason: "x",
      } as never,
    );
    expect(out).toContain("错误");
  });

  it("混合候选：未知 slug 剔除，合法候选保留渲染", async () => {
    const tool = makeRecommendExpertTool();
    const out = await tool.execute(
      {} as never,
      {
        candidates: ["code-review-expert", "nope"],
        reason: "x",
      } as never,
    );
    expect(out).toContain("1");
    expect(out).not.toContain("错误");
  });

  it("kind 为 read（免审批）", () => {
    expect(makeRecommendExpertTool().kind).toBe("read");
  });

  it("工具名与前端约定的常量一致", () => {
    expect(RECOMMEND_TOOL_NAME).toBe("recommend_experts");
    expect(makeRecommendExpertTool().name).toBe(RECOMMEND_TOOL_NAME);
  });
});

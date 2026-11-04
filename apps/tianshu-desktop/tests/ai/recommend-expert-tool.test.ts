/**
 * 专家推荐工具组单测（专家 2.0 Task 4 + 2026-11-01 目录出 system 批）：
 * 纯 Node 工具，vitest 直测（widget-tool/create-expert 先例）；ctx 不会
 * 被触达（无副作用：list_experts 返回目录文本，recommend_expert 渲染层
 * 消费 args）。list_experts 承接原 buildExpertCatalogPrompt 的目录文案
 * 断言（目录段删除后唯一目录出口）。
 */
import { describe, expect, it } from "vitest";
import { MARKET_EXPERTS } from "../../src-react/domains/ai/experts/data/marketplace";
import {
  EXPERT_RECOMMEND_TOOL_NAMES,
  LIST_TOOL_NAME,
  makeListExpertsTool,
  makeRecommendExpertTool,
  RECOMMEND_TOOL_NAME,
} from "../../electron/domains/ai/agent/recommend-expert-tool";

describe("makeListExpertsTool", () => {
  it("无参调用返回全量目录：条目数与 MARKET_EXPERTS 一致，含行格式", async () => {
    const tool = makeListExpertsTool();
    const out = await tool.execute({} as never, {} as never);
    expect(out).toContain("【专家目录】");
    // 每个市场专家各占一行（承接原目录段文案断言）
    expect(out.split("\n")).toEqual(
      expect.arrayContaining(
        MARKET_EXPERTS.map(
          (e) => `- ${e.slug}｜${e.name}（${e.subtitle}）`,
        ).map((line) => expect.stringContaining(line)),
      ),
    );
    const item = MARKET_EXPERTS.find((e) => e.slug === "code-review-expert");
    expect(item).toBeDefined();
    expect(out).toContain(`- ${item!.slug}｜${item!.name}（${item!.subtitle}）`);
  });

  it("description 含信号规则与两跳指引，不含目录本体", () => {
    const tool = makeListExpertsTool();
    expect(tool.description).toContain("未绑定专家");
    expect(tool.description).toContain("recommend_expert");
    expect(tool.description).not.toContain("【专家目录】");
  });

  it("kind 为 read（免审批）；工具名与常量一致", () => {
    const tool = makeListExpertsTool();
    expect(tool.kind).toBe("read");
    expect(tool.name).toBe(LIST_TOOL_NAME);
    expect(LIST_TOOL_NAME).toBe("list_experts");
  });
});

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

  it("未知 slug 剔除；全无效返回错误文案（回指 list_experts）", async () => {
    const tool = makeRecommendExpertTool();
    const out = await tool.execute(
      {} as never,
      {
        candidates: ["nope-1", "nope-2"],
        reason: "x",
      } as never,
    );
    expect(out).toContain("错误");
    expect(out).toContain("list_experts");
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

  it("工具名与前端约定的常量一致；名集含两跳组", () => {
    expect(RECOMMEND_TOOL_NAME).toBe("recommend_expert");
    expect(makeRecommendExpertTool().name).toBe(RECOMMEND_TOOL_NAME);
    expect(EXPERT_RECOMMEND_TOOL_NAMES.has(LIST_TOOL_NAME)).toBe(true);
    expect(EXPERT_RECOMMEND_TOOL_NAMES.has(RECOMMEND_TOOL_NAME)).toBe(true);
  });
});

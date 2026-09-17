import { describe, expect, it } from "vitest";
import { buildScenarioSystem } from "@/../electron/domains/ai/chat/scenario-prompt";

describe("buildScenarioSystem", () => {
  it("null/undefined/空串原样返回 base", () => {
    expect(buildScenarioSystem(null, "B")).toBe("B");
    expect(buildScenarioSystem(undefined, "B")).toBe("B");
    expect(buildScenarioSystem("", "B")).toBe("B");
  });
  it("base 为空时仅返回场景段", () => {
    expect(buildScenarioSystem("coding", undefined)).toContain("代码开发");
  });
  it("已知场景拼接场景段（空行分隔）", () => {
    const out = buildScenarioSystem("daily", "B");
    expect(out?.startsWith("B\n\n")).toBe(true);
    expect(out?.length).toBeGreaterThan(3);
  });
  it("未知场景值原样返回 base（防脏数据放大）", () => {
    expect(buildScenarioSystem("hacking", "B")).toBe("B");
  });
});

/**
 * 新建任务场景纯逻辑单测:场景 key 白名单、预设胶囊配置与场景技能过滤
 */
import { describe, expect, it } from "vitest";
import {
  SCENARIO_CHIPS,
  filterScenarioSkills,
  isScenarioKey,
} from "@/domains/ai/new-task/lib/scenario";

describe("scenario 纯逻辑", () => {
  it("isScenarioKey 白名单", () => {
    expect(isScenarioKey("daily")).toBe(true);
    expect(isScenarioKey("nope")).toBe(false);
  });
  it("三场景各有预设胶囊", () => {
    for (const key of ["daily", "coding", "design"] as const) {
      expect(SCENARIO_CHIPS[key].length).toBeGreaterThanOrEqual(3);
    }
  });
  it("filterScenarioSkills 取已启用且打标场景的技能", () => {
    const skills = [
      { name: "a", enabled: true, scenarios: ["daily"] },
      { name: "b", enabled: false, scenarios: ["daily"] },
      { name: "c", enabled: true, scenarios: ["coding"] },
      { name: "d", enabled: true, scenarios: null },
    ];
    expect(filterScenarioSkills(skills, "daily").map((s) => s.name)).toEqual([
      "a",
    ]);
  });
});

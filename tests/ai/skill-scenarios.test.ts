import { describe, expect, it, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ invoke: invokeMock }));

import { SkillApi } from "@/domains/ai/skills/api/skill.api";

describe("SkillApi.setScenarios", () => {
  beforeEach(() => invokeMock.mockReset());

  it("调 skill:setScenarios 传对象参数", async () => {
    invokeMock.mockResolvedValue(null);
    await SkillApi.setScenarios("demo", ["daily", "coding"]);
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith("skill:setScenarios", {
      name: "demo",
      scenarios: ["daily", "coding"],
    });
  });
});

describe("SkillApi.importSkill 场景打标透传（导入弹窗当场打标）", () => {
  beforeEach(() => invokeMock.mockReset());

  it("真装透传 scenarios（含空数组=显式不打标）；未传不带该键", async () => {
    invokeMock.mockResolvedValue({ status: "installed", record: {} });
    await SkillApi.importSkill({
      path: "/tmp/s.zip",
      scenarios: ["daily"],
    });
    expect(invokeMock).toHaveBeenCalledWith("skill:import", {
      path: "/tmp/s.zip",
      scenarios: ["daily"],
    });
    await SkillApi.importSkill({ path: "/tmp/s.zip", scenarios: [] });
    expect(invokeMock).toHaveBeenLastCalledWith("skill:import", {
      path: "/tmp/s.zip",
      scenarios: [],
    });
    await SkillApi.importSkill({ path: "/tmp/s.zip" });
    expect(invokeMock).toHaveBeenLastCalledWith("skill:import", {
      path: "/tmp/s.zip",
    });
  });
});

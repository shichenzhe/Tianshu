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

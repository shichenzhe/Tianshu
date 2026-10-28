import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillHubSkillDto } from "@tianshu/protocol";

const storeMock = vi.hoisted(() => ({
  marketItems: [] as SkillHubSkillDto[],
  searchMarket: vi.fn(),
}));

vi.mock("../store/skills.store", () => ({
  useSkillsStore: { getState: () => storeMock },
}));

import { loadSkillDetail, resolveSkillDetail } from "./skill-detail";

const SKILL: SkillHubSkillDto = {
  slug: "grammar",
  name: "语法检查",
  description: "Grammar check",
  description_zh: "语法检查",
  iconUrl: null,
  category: "writing",
  version: "1.0.0",
  downloads: 100,
  stars: 5,
  score: 9.5,
  source: "skillhub",
};

describe("resolveSkillDetail", () => {
  it("marketItems 命中 slug 返回 found", () => {
    expect(resolveSkillDetail([SKILL], "grammar")).toEqual({
      kind: "found",
      skill: SKILL,
    });
  });

  it("未命中返回 fallback（深链/被筛选替换）", () => {
    expect(resolveSkillDetail([SKILL], "other")).toEqual({ kind: "fallback" });
    expect(resolveSkillDetail([], "grammar")).toEqual({ kind: "fallback" });
  });

  it("slug 非法（null/空串）返回 missing", () => {
    expect(resolveSkillDetail([SKILL], null)).toEqual({ kind: "missing" });
    expect(resolveSkillDetail([SKILL], "")).toEqual({ kind: "missing" });
  });
});

describe("loadSkillDetail", () => {
  beforeEach(() => {
    storeMock.marketItems = [];
    storeMock.searchMarket.mockReset();
  });

  it("直找命中不发 searchMarket", async () => {
    storeMock.marketItems = [SKILL];
    const result = await loadSkillDetail("grammar");
    expect(result).toEqual({ kind: "found", skill: SKILL });
    expect(storeMock.searchMarket).not.toHaveBeenCalled();
  });

  it("fallback 回捞命中：searchMarket({keyword: slug}, true) 后返回 found", async () => {
    storeMock.searchMarket.mockImplementation(async () => {
      storeMock.marketItems = [SKILL];
    });
    const result = await loadSkillDetail("grammar");
    expect(storeMock.searchMarket).toHaveBeenCalledWith(
      { keyword: "grammar" },
      true,
    );
    expect(result).toEqual({ kind: "found", skill: SKILL });
  });

  it("回捞仍无收敛为 missing（不存在/已下架占位）", async () => {
    storeMock.searchMarket.mockResolvedValue(undefined);
    const result = await loadSkillDetail("ghost");
    expect(result).toEqual({ kind: "missing" });
  });

  it("slug 非法短路：不回捞、missing", async () => {
    const result = await loadSkillDetail(null);
    expect(result).toEqual({ kind: "missing" });
    expect(storeMock.searchMarket).not.toHaveBeenCalled();
  });
});

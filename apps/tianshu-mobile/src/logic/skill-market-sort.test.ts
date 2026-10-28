import { describe, expect, it } from "vitest";
import type { SkillHubSkillDto } from "@tianshu/protocol";

import { sortMarketItems } from "./skill-market-sort";

function row(
  slug: string,
  over: Partial<SkillHubSkillDto> = {},
): SkillHubSkillDto {
  return {
    slug,
    name: slug,
    description: "",
    description_zh: "",
    iconUrl: null,
    category: "c",
    version: "1",
    downloads: 0,
    stars: 0,
    score: 0,
    source: "s",
    ...over,
  };
}

describe("sortMarketItems", () => {
  it("综合按 score desc、热门按 downloads desc", () => {
    const items = [
      row("a", { score: 90, downloads: 10 }),
      row("b", { score: 95, downloads: 3 }),
      row("c", { score: 80, downloads: 99 }),
    ];
    expect(sortMarketItems(items, "comprehensive").map((i) => i.slug)).toEqual([
      "b",
      "a",
      "c",
    ]);
    expect(sortMarketItems(items, "hot").map((i) => i.slug)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("最新按 createdAt desc 且缺 createdAt 行沉底、同键稳定", () => {
    const items = [
      row("no-time"),
      row("older", { createdAt: 100 }),
      row("newer", { createdAt: 200 }),
      row("no-time-2"),
    ];
    expect(sortMarketItems(items, "newest").map((i) => i.slug)).toEqual([
      "newer",
      "older",
      "no-time",
      "no-time-2",
    ]);
  });

  it("copy+sort 不变更输入数组", () => {
    const items = [row("a", { score: 1 }), row("b", { score: 2 })];
    const before = items.map((i) => i.slug);
    sortMarketItems(items, "comprehensive");
    expect(items.map((i) => i.slug)).toEqual(before);
  });
});

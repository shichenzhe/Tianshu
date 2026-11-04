/**
 * 市场过滤/排序纯函数单测：关键词(name/subtitle/description/tags 命中、
 * 大小写不敏感)、type/分类/场景过滤、三种排序与稳定性、组合叠加
 */
import { describe, expect, it } from "vitest";

import {
  filterExperts,
  sortExperts,
  type ExpertMarketItem,
} from "../../src-react/domains/ai/experts/lib/market-filter";

const item = (overrides: Partial<ExpertMarketItem>): ExpertMarketItem => ({
  slug: "a",
  name: "微信小程序开发者",
  subtitle: "小程序达人",
  description: "精通微信小程序开发框架和生态",
  icon: "🤖",
  systemPrompt: "p",
  category: "tech",
  tags: ["小程序开发", "全栈开发"],
  type: "expert",
  score: 90,
  downloads: 100,
  createdAt: "2026-08-01",
  ...overrides,
});

const ITEMS = [
  item({
    slug: "a",
    name: "Alpha",
    score: 90,
    downloads: 100,
    createdAt: "2026-08-01",
  }),
  item({
    slug: "b",
    name: "Beta",
    subtitle: "trader",
    score: 80,
    downloads: 300,
    createdAt: "2026-09-01",
    type: "team",
  }),
  item({
    slug: "c",
    description: "GODOT engine",
    category: "product",
    score: 85,
    downloads: 200,
    createdAt: "2026-07-01",
  }),
];

describe("filterExperts", () => {
  it("空过滤条件返回全量", () => {
    expect(filterExperts(ITEMS, {})).toHaveLength(3);
  });

  it("关键词命中 name/subtitle/description/tags，大小写不敏感", () => {
    expect(filterExperts(ITEMS, { keyword: "alpha" })).toHaveLength(1);
    expect(filterExperts(ITEMS, { keyword: "TRADER" })).toHaveLength(1);
    expect(filterExperts(ITEMS, { keyword: "godot" })).toHaveLength(1);
    // fixture 默认 name/description/tags 三条共享，"小程序开发"经
    // tags 与默认 name/description 命中全部 3 条（tags 参与检索）
    expect(filterExperts(ITEMS, { keyword: "小程序开发" })).toHaveLength(3);
    expect(filterExperts(ITEMS, { keyword: "不存在" })).toHaveLength(0);
  });

  it("type 筛选专家团", () => {
    const teams = filterExperts(ITEMS, { type: "team" });
    expect(teams).toHaveLength(1);
    expect(teams[0].slug).toBe("b");
  });

  it("分类过滤", () => {
    expect(filterExperts(ITEMS, { category: "product" })[0].slug).toBe("c");
  });

  it("场景 slug 集合过滤", () => {
    const slugs = new Set(["a", "b"]);
    expect(filterExperts(ITEMS, { scenarioSlugs: slugs })).toHaveLength(2);
  });

  it("组合叠加（交集）", () => {
    expect(
      filterExperts(ITEMS, { type: "expert", keyword: "alpha" }),
    ).toHaveLength(1);
    expect(
      filterExperts(ITEMS, { type: "team", keyword: "alpha" }),
    ).toHaveLength(0);
  });
});

describe("sortExperts", () => {
  it("comprehensive 按 score 降序", () => {
    expect(sortExperts(ITEMS, "comprehensive").map((i) => i.slug)).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  it("hot 按 downloads 降序", () => {
    expect(sortExperts(ITEMS, "hot").map((i) => i.slug)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("newest 按 createdAt 降序", () => {
    expect(sortExperts(ITEMS, "newest").map((i) => i.slug)).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("相等键保持稳定（不重排）", () => {
    const same = [item({ slug: "x", score: 1 }), item({ slug: "y", score: 1 })];
    expect(sortExperts(same, "comprehensive").map((i) => i.slug)).toEqual([
      "x",
      "y",
    ]);
  });
});

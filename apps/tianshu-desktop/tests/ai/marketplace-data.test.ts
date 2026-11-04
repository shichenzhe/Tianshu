import { describe, expect, it } from "vitest";
import {
  EXPERT_CATEGORIES,
  MARKET_EXPERTS,
} from "../../src-react/domains/ai/experts/data/marketplace";

const CATEGORY_KEYS = new Set(EXPERT_CATEGORIES.map((c) => c.key));

describe("marketplace 数据规范", () => {
  it("12 分类 key 与 WorkBuddy 对齐", () => {
    expect(EXPERT_CATEGORIES.map((c) => c.key)).toEqual([
      "01-ProductDesign",
      "02-Engineering",
      "03-GameSpatial",
      "04-DataAI",
      "05-MarketingGrowth",
      "06-ContentCreative",
      "07-SalesCommerce",
      "08-FinanceInvestment",
      "09-OperationsHR",
      "10-ProjectQuality",
      "11-SecurityCompliance",
      "12-IndustryConsultant",
    ]);
  });

  it("全条目 category 落在 12 分类内且 type 为枚举", () => {
    for (const item of MARKET_EXPERTS) {
      expect(CATEGORY_KEYS.has(item.category), item.slug).toBe(true);
      expect(["expert", "team"]).toContain(item.type);
    }
  });

  it("全条目 quickPrompts 1-3 条且非空、每条 ≤200 字", () => {
    for (const item of MARKET_EXPERTS) {
      const prompts = item.quickPrompts ?? [];
      expect(prompts.length, item.slug).toBeGreaterThanOrEqual(1);
      expect(prompts.length, item.slug).toBeLessThanOrEqual(3);
      for (const p of prompts) {
        expect(p.trim().length, item.slug).toBeGreaterThan(0);
        expect(p.length, item.slug).toBeLessThanOrEqual(200);
      }
    }
  });

  it("skillNames 若存在须在 1-3 条内", () => {
    for (const item of MARKET_EXPERTS) {
      const skills = item.skillNames ?? [];
      expect(skills.length, item.slug).toBeLessThanOrEqual(3);
    }
  });

  it("team 条目 members 规范（必有、1-13 员、id 唯一 kebab-case、字段非空）", () => {
    for (const item of MARKET_EXPERTS.filter((e) => e.type === "team")) {
      const members = item.members ?? [];
      expect(members.length, item.slug).toBeGreaterThanOrEqual(1);
      expect(members.length, item.slug).toBeLessThanOrEqual(13);
      const ids = members.map((m) => m.id);
      expect(new Set(ids).size, item.slug).toBe(ids.length);
      for (const m of members) {
        expect(m.id, item.slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
        expect(m.name.length, item.slug).toBeGreaterThan(0);
        expect(m.systemPrompt.length, item.slug).toBeGreaterThanOrEqual(80);
      }
    }
  });

  it("team 成员 systemPrompt 非空且成文（WorkBuddy 原文结构多样）", () => {
    // WorkBuddy agents/*.md 原文照搬：五段式标签不再是硬结构（部分成员为
    // markdown 章节式），仅保留下限守卫（≥80 字）防空壳数据
    for (const item of MARKET_EXPERTS.filter((e) => e.type === "team")) {
      for (const m of item.members ?? []) {
        expect(
          m.systemPrompt.trim().length,
          `${item.slug}/${m.id}`,
        ).toBeGreaterThanOrEqual(80);
      }
    }
  });
});

/**
 * 专家目录运行时辅助纯函数单测（专家 2.0 Task 4）：
 * mergeExpertSkills 并入语义 = skills ∪ (allSkills ∩ skillNames)，保持
 * skills 原序、新增项按 skillNames 序追加；buildExpertCatalogPrompt 目录
 * 段文案。无 fs/electron 依赖，vitest 直测（skill-prompt 先例）。
 */
import { describe, expect, it } from "vitest";
import { MARKET_EXPERTS } from "../../src-react/domains/ai/experts/data/marketplace";
import {
  buildExpertCatalogPrompt,
  mergeExpertSkills,
  parseJsonStringArray,
} from "../../electron/domains/ai/chat/expert-catalog";
import type { SkillInfo } from "../../electron/domains/ai/agent/skill-loader";

/** 完整 SkillInfo 夹具（brief 字面量缺 dir/bodyPath/source，补全以过类型） */
const skill = (name: string): SkillInfo => ({
  name,
  description: `d-${name}`,
  dir: `/skills/${name}`,
  bodyPath: `/skills/${name}/SKILL.md`,
  source: "user",
});

describe("mergeExpertSkills", () => {
  const skills = [skill("a"), skill("b")];

  it("专家技能并入去重", () => {
    expect(
      mergeExpertSkills(skills, ["b", "c"], [skill("a"), skill("b")]).map(
        (s) => s.name,
      ),
    ).toEqual(["a", "b"]);
  });

  it("undefined/空数组原样返回", () => {
    expect(mergeExpertSkills(skills, undefined, [])).toBe(skills);
    expect(mergeExpertSkills(skills, [], [])).toBe(skills);
  });

  it("三情形：未启用但附带→从全集补入；既启用又附带→不重复；已卸载→静略", () => {
    // 启用集 [a, c]；全集 [a, b, c]（b 已安装未启用；gone 不在全集=已卸载）
    const enabled = [skill("a"), skill("c")];
    const all = [skill("a"), skill("b"), skill("c")];
    const merged = mergeExpertSkills(enabled, ["b", "c", "gone"], all);
    // enabled 原序保持，新增项（b）按 skillNames 序追加，c 不重复、gone 静略
    expect(merged.map((s) => s.name)).toEqual(["a", "c", "b"]);
  });

  it("新增多项按 skillNames 序追加", () => {
    const enabled = [skill("a")];
    const all = [skill("x"), skill("y"), skill("z"), skill("a")];
    const merged = mergeExpertSkills(enabled, ["z", "y", "x"], all);
    expect(merged.map((s) => s.name)).toEqual(["a", "z", "y", "x"]);
  });
});

describe("buildExpertCatalogPrompt", () => {
  it("含目录条目与工具使用规则", () => {
    const text = buildExpertCatalogPrompt(MARKET_EXPERTS);
    expect(text).toContain("recommend_expert");
    expect(text).toContain("code-review-expert");
    expect(text).toContain("最多一次");
  });

  it("目录条目含 slug/名称/一句话描述", () => {
    const text = buildExpertCatalogPrompt(MARKET_EXPERTS);
    const item = MARKET_EXPERTS.find((e) => e.slug === "code-review-expert");
    expect(item).toBeDefined();
    expect(text).toContain(
      `- ${item!.slug}｜${item!.name}（${item!.subtitle}）`,
    );
  });
});

describe("parseJsonStringArray", () => {
  it("合法 JSON 字符串数组解析；非字符串项剔除", () => {
    expect(parseJsonStringArray('["a", "b"]')).toEqual(["a", "b"]);
    expect(parseJsonStringArray('["a", 1, null, "b"]')).toEqual(["a", "b"]);
  });

  it("null/坏 JSON/非数组 → 空数组不抛错（展示字段回退）", () => {
    expect(parseJsonStringArray(null)).toEqual([]);
    expect(parseJsonStringArray("not json")).toEqual([]);
    expect(parseJsonStringArray('{"a":1}')).toEqual([]);
  });
});

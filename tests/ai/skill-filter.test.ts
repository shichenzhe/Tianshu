import { describe, expect, it } from "vitest";

import { filterSkillRecords } from "../../src-react/domains/ai/skills/lib/skill-filter";
import type { SkillRecord } from "../../src-react/domains/ai/skills/api/skill.api";

const base: SkillRecord = {
  id: 1,
  name: "TencentDocs",
  slug: "tencent-docs",
  version: null,
  source: "local",
  dir: "/ud/skills/tencent-docs",
  description: "腾讯文档操作",
  enabled: true,
  installedAt: "2026-09-05T00:00:00.000Z",
};

describe("filterSkillRecords 技能本地搜索", () => {
  it("空关键字原样返回", () => {
    expect(filterSkillRecords([base], "")).toEqual([base]);
    expect(filterSkillRecords([base], "   ")).toEqual([base]);
  });

  it("按 name/slug/description 不区分大小写匹配", () => {
    const records = [
      base,
      { ...base, id: 2, name: "zip", slug: null, description: "压缩" },
    ];
    expect(filterSkillRecords(records, "tencent")).toHaveLength(1);
    expect(filterSkillRecords(records, "DOCS")).toHaveLength(1);
    expect(filterSkillRecords(records, "压缩")).toEqual([records[1]]);
  });

  it("无命中返回空数组", () => {
    expect(filterSkillRecords([base], "不存在")).toEqual([]);
  });
});

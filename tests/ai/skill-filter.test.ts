import { describe, expect, it } from "vitest";

import {
  filterSkillRecords,
  partitionSkillRecords,
} from "../../src-react/domains/ai/skills/lib/skill-filter";
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

describe("partitionSkillRecords 用户/系统技能分区", () => {
  const builtin: SkillRecord = {
    ...base,
    id: 9,
    name: "skill-creator",
    slug: null,
    source: "builtin",
  };

  it("按 source builtin 划分两组", () => {
    const records = [
      builtin,
      { ...base, id: 2, name: "zip", slug: null, description: "压缩" },
    ];
    const { user, system } = partitionSkillRecords(records);
    expect(user.map((r) => r.name)).toEqual(["zip"]);
    expect(system.map((r) => r.name)).toEqual(["skill-creator"]);
  });

  it("全内置时 user 为空(用户组空态判定依据)", () => {
    const { user, system } = partitionSkillRecords([
      builtin,
      { ...builtin, name: "workflow-creator" },
    ]);
    expect(user).toEqual([]);
    expect(system).toHaveLength(2);
  });

  it("无内置技能时 system 为空(系统组整组不渲染)", () => {
    const records = [base, { ...base, id: 2, name: "zip", slug: null }];
    const { user, system } = partitionSkillRecords(records);
    expect(user).toHaveLength(2);
    expect(system).toEqual([]);
  });
});

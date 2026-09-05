import { describe, expect, it } from "vitest";

import {
  filterDisabledSkills,
  isInsideDir,
  syncSkillRecords,
} from "../../electron/domains/ai/skill/skill-sync";

describe("syncSkillRecords 目录↔DB 对账", () => {
  it("目录有、DB 无 → 新增(local 源)", () => {
    const plan = syncSkillRecords(
      [
        {
          name: "greeting",
          description: "打招呼",
          dir: "/ud/skills/greeting",
        },
      ],
      [],
    );
    expect(plan).toEqual({
      toInsert: [
        {
          name: "greeting",
          source: "local",
          dir: "/ud/skills/greeting",
          description: "打招呼",
        },
      ],
      toDeleteIds: [],
      toUpdate: [],
    });
  });

  it("DB 有、目录无 → 删除(孤儿清理)", () => {
    const plan = syncSkillRecords(
      [],
      [
        {
          id: 7,
          name: "gone",
          source: "local",
          dir: "/ud/skills/gone",
          version: null,
          description: null,
        },
      ],
    );
    expect(plan.toDeleteIds).toEqual([7]);
    expect(plan.toInsert).toEqual([]);
  });

  it("双方都有且 dir/description 一致 → 无操作(保留 enabled 等状态)", () => {
    const plan = syncSkillRecords(
      [{ name: "a", description: "d", dir: "/ud/skills/a" }],
      [
        {
          id: 1,
          name: "a",
          source: "market",
          dir: "/ud/skills/a",
          version: "1.0.0",
          description: "d",
        },
      ],
    );
    expect(plan).toEqual({ toInsert: [], toDeleteIds: [], toUpdate: [] });
  });

  it("双方都有但 description 变化 → 刷新 dir/description,不动 version/source", () => {
    const plan = syncSkillRecords(
      [{ name: "a", description: "新描述", dir: "/ud/skills/a" }],
      [
        {
          id: 1,
          name: "a",
          source: "market",
          dir: "/ud/skills/a",
          version: "1.0.0",
          description: "旧描述",
        },
      ],
    );
    expect(plan.toUpdate).toEqual([
      { id: 1, dir: "/ud/skills/a", description: "新描述" },
    ]);
  });

  it("混合场景:各分支互不影响", () => {
    const plan = syncSkillRecords(
      [
        { name: "keep", description: "k", dir: "/ud/skills/keep" },
        { name: "new", description: "n", dir: "/ud/skills/new" },
        { name: "moved", description: "m", dir: "/ud/skills/moved2" },
      ],
      [
        {
          id: 1,
          name: "keep",
          source: "local",
          dir: "/ud/skills/keep",
          version: null,
          description: "k",
        },
        {
          id: 2,
          name: "orphan",
          source: "local",
          dir: "/ud/skills/orphan",
          version: null,
          description: "o",
        },
        {
          id: 3,
          name: "moved",
          source: "local",
          dir: "/ud/skills/moved1",
          version: null,
          description: "m",
        },
      ],
    );
    expect(plan.toInsert).toEqual([
      { name: "new", source: "local", dir: "/ud/skills/new", description: "n" },
    ]);
    expect(plan.toDeleteIds).toEqual([2]);
    expect(plan.toUpdate).toEqual([
      { id: 3, dir: "/ud/skills/moved2", description: "m" },
    ]);
  });
});

describe("filterDisabledSkills 禁用过滤", () => {
  const skills = [
    { name: "a", source: "user" },
    { name: "b", source: "user" },
    { name: "c", source: "workspace" },
  ];

  it("仅过滤 user 级禁用项", () => {
    expect(filterDisabledSkills(skills, new Set(["b"]))).toEqual([
      { name: "a", source: "user" },
      { name: "c", source: "workspace" },
    ]);
  });

  it("禁用的 workspace 同名技能不受影响;空禁用集原样返回", () => {
    expect(filterDisabledSkills(skills, new Set(["c"]))).toEqual(skills);
    expect(filterDisabledSkills(skills, new Set())).toEqual(skills);
  });
});

describe("isInsideDir 路径防越界", () => {
  it("子目录在根内", () => {
    expect(isInsideDir("/ud/skills/a", "/ud/skills")).toBe(true);
  });
  it("同前缀字符串但不在根内(../ 逃逸与兄弟目录)", () => {
    expect(isInsideDir("/ud/skills-evil/a", "/ud/skills")).toBe(false);
    expect(isInsideDir("/ud/skills/../etc", "/ud/skills")).toBe(false);
  });
  it("与根相等不算在内(防整根误删)", () => {
    expect(isInsideDir("/ud/skills", "/ud/skills")).toBe(false);
  });
});

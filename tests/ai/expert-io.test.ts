import { describe, expect, it } from "vitest";
import {
  dedupeName,
  parseExpertJson,
  serializeExpert,
} from "../../electron/domains/ai/chat/assistant.repo";

const record = {
  id: 3,
  name: "架构师",
  icon: "🏛️",
  systemPrompt: "P",
  description: "D",
  profession: "软件架构师",
  categoryId: "02-Engineering",
  tags: ["架构"],
  quickPrompts: ["帮我评审"],
  skillNames: ["code-review"],
  builtin: false,
  sourceSlug: "x",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as never;

describe("serializeExpert", () => {
  it("剔除 id/builtin/sourceSlug/时间戳，保留 8 个内容字段", () => {
    const json = serializeExpert(record);
    expect(json).toEqual({
      kind: "tianshu-expert",
      version: 1,
      name: "架构师",
      icon: "🏛️",
      systemPrompt: "P",
      description: "D",
      profession: "软件架构师",
      categoryId: "02-Engineering",
      tags: ["架构"],
      quickPrompts: ["帮我评审"],
      skillNames: ["code-review"],
    });
  });
});

describe("parseExpertJson", () => {
  it("合法 JSON 解析成功", () => {
    const r = parseExpertJson(JSON.stringify(serializeExpert(record)));
    expect(r.ok).toBe(true);
  });
  it("坏 JSON / 缺 name / kind 不符拒绝", () => {
    expect(parseExpertJson("{bad").ok).toBe(false);
    expect(
      parseExpertJson(JSON.stringify({ kind: "tianshu-expert", version: 1 }))
        .ok,
    ).toBe(false);
    expect(
      parseExpertJson(
        JSON.stringify({ ...serializeExpert(record), kind: "other" }),
      ).ok,
    ).toBe(false);
  });
});

const teamRecord = {
  ...record,
  expertType: "team",
  members: [
    {
      id: "risk-officer",
      name: "严守仓",
      profession: "风控官",
      systemPrompt: "P",
    },
  ],
} as never;

describe("serializeExpert / parseExpertJson（专家团字段）", () => {
  const member = (id: string) => ({
    id,
    name: "员",
    profession: "分析师",
    systemPrompt: "P",
  });

  it("team 记录导出含 expertType/members（round-trip 可回读）", () => {
    const json = serializeExpert(teamRecord);
    expect(json.expertType).toBe("team");
    expect(json.members).toEqual([
      {
        id: "risk-officer",
        name: "严守仓",
        profession: "风控官",
        systemPrompt: "P",
      },
    ]);
    expect(parseExpertJson(JSON.stringify(json)).ok).toBe(true);
  });

  it("agent 记录缺省不落 team 键", () => {
    const json = serializeExpert(record);
    expect("expertType" in json).toBe(false);
    expect("members" in json).toBe(false);
  });

  it("parse 拒重复 id 成员", () => {
    const r = parseExpertJson(
      JSON.stringify({
        ...serializeExpert(record),
        expertType: "team",
        members: [member("a"), member("a")],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("重复");
    }
  });

  it("parse 拒非法 id（非 kebab-case）与超 13 名成员", () => {
    expect(
      parseExpertJson(
        JSON.stringify({
          ...serializeExpert(record),
          members: [member("Bad_Id")],
        }),
      ).ok,
    ).toBe(false);
    expect(
      parseExpertJson(
        JSON.stringify({
          ...serializeExpert(record),
          members: Array.from({ length: 14 }, (_, i) => member(`m-${i}`)),
        }),
      ).ok,
    ).toBe(false);
  });
});

describe("dedupeName（导入重名后缀，终审顺手修）", () => {
  /** 名单查重闭包（生产侧为 DB findFirst 封装，此处直测纯函数） */
  const nameExistsOf = (existing: string[]) => async (candidate: string) =>
    existing.includes(candidate);

  it("原名不冲突：原样返回", async () => {
    expect(await dedupeName("架构师", nameExistsOf([]))).toBe("架构师");
    expect(await dedupeName("架构师", nameExistsOf(["其他"]))).toBe("架构师");
  });
  it("「架构师」已存在 → 架构师-2", async () => {
    expect(await dedupeName("架构师", nameExistsOf(["架构师"]))).toBe(
      "架构师-2",
    );
  });
  it("「架构师」/「架构师-2」都存在 → 架构师-3", async () => {
    expect(
      await dedupeName("架构师", nameExistsOf(["架构师", "架构师-2"])),
    ).toBe("架构师-3");
  });
});

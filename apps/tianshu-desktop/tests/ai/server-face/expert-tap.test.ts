// A2 专家批（spec 2026-10-26 §3）：expert-tap 用例——写面三态/builtin 拒/
// 归属不泄露/detail 全量透出/市场概要无 systemPrompt/marketDetail by slug。
// 体验精修批（spec §1.2 增补）：marketList 排序三档字段直透 + categoryTitleKey
// 经 EXPERT_CATEGORIES 映射（未知分类缺省不出键）；save sourceSlug 建/改两路透传。
// 内存仓储替身（AssistantRepository 结构子集）直测，错误码经 code 属性钉。
import { describe, expect, it } from "vitest";

import { createExpertsFace } from "../../../electron/domains/server-face/expert-tap";
import { toMarketSummary } from "../../../electron/domains/server-face/expert-tap";
import type { ExpertRepoSubset } from "../../../electron/domains/server-face/expert-tap";
import type { AssistantRecord } from "../../../src-react/domains/ai/api/assistant.api";
import {
  EXPERT_CATEGORIES,
  MARKET_EXPERTS,
  type ExpertMarketItem,
} from "@tianshu/core/expert-market";

const UID = 7;
const NOW = "2026-10-26T00:00:00.000Z";

function record(overrides: Partial<AssistantRecord> = {}): AssistantRecord {
  return {
    id: 1,
    name: "专家甲",
    icon: "🎨",
    systemPrompt: "prompt-full",
    builtin: false,
    description: "desc",
    tags: ["a"],
    sourceSlug: "slug-a",
    profession: "职业",
    quickPrompts: ["q1"],
    categoryId: "01-ProductDesign",
    skillNames: ["skill-a"],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** 内存仓储替身：行带 userId，update 记录收到的载荷供三态断言 */
class ExpertRepoDouble {
  rows: Array<AssistantRecord & { userId: number }>;
  lastUpdate: unknown = null;
  lastCreate: unknown = null;

  constructor(rows: Array<AssistantRecord & { userId: number }> = []) {
    this.rows = rows;
  }

  async list(userId: number): Promise<AssistantRecord[]> {
    return this.rows.filter((row) => row.userId === userId);
  }

  async getOwned(id: number, userId: number): Promise<AssistantRecord | null> {
    return (
      this.rows.find((row) => row.id === id && row.userId === userId) ?? null
    );
  }

  async create(p: Record<string, unknown>): Promise<AssistantRecord> {
    this.lastCreate = p;
    const row = { ...record(), userId: UID, ...p } as AssistantRecord & {
      userId: number;
    };
    this.rows.push(row);
    return row;
  }

  async update(p: { id: number }): Promise<AssistantRecord> {
    this.lastUpdate = p;
    const row = this.rows.find((r) => r.id === p.id);
    if (!row) throw new Error("ASSISTANT_NOT_FOUND");
    return row;
  }

  async delete(id: number, userId: number): Promise<void> {
    const row = this.rows.find((r) => r.id === id && r.userId === userId);
    if (!row) throw new Error("ASSISTANT_NOT_FOUND");
    if (row.builtin) throw new Error("ASSISTANT_BUILTIN");
    this.rows = this.rows.filter((r) => r.id !== id);
  }

  // A2 尾：importFromJson 内容面替身（dedupeName/技能过滤由 repo 真身承担，
  // 替身只记录载荷并落行——与文件导入同语义断言透传面）
  async importFromJson(
    data: Record<string, unknown>,
  ): Promise<AssistantRecord> {
    this.lastCreate = data;
    const row = {
      ...record(),
      ...data,
      id: this.rows.length + 1,
      userId: UID,
    } as AssistantRecord & { userId: number };
    this.rows.push(row);
    return row;
  }
}

function makeFace(
  rows: Array<AssistantRecord & { userId: number }> = [
    { ...record(), userId: UID },
  ],
) {
  const repo = new ExpertRepoDouble(rows);
  const face = createExpertsFace(repo as unknown as ExpertRepoSubset);
  return { face, repo };
}

describe("expert-tap（A2 专家批）", () => {
  it("detail 归属校验后全量透出（systemPrompt/调参/专家团）", async () => {
    const { face } = makeFace([
      {
        ...record({
          temperature: 0.5,
          members: [
            {
              id: "m1",
              name: "成员",
              profession: "P",
              systemPrompt: "member-prompt",
            },
          ],
          expertType: "team",
        }),
        userId: UID,
      },
    ]);
    const detail = await face.detail(UID, 1);
    expect(detail.systemPrompt).toBe("prompt-full");
    expect(detail.temperature).toBe(0.5);
    expect(detail.members?.[0]).toMatchObject({ id: "m1" });
    expect(detail.expertType).toBe("team");
  });

  it("detail 他人所有与不存在同报 ASSISTANT_NOT_FOUND（不泄露存在性）", async () => {
    const { face } = makeFace([{ ...record(), userId: 99 }]);
    for (const id of [1, 404]) {
      try {
        await face.detail(UID, id);
        expect.unreachable();
      } catch (error) {
        expect((error as { code: string }).code).toBe("ASSISTANT_NOT_FOUND");
      }
    }
  });

  it("save 更新三态：undefined 保留/null 清空（载荷原样透传）", async () => {
    const { face, repo } = makeFace();
    await face.save(UID, {
      id: 1,
      name: "改名",
      icon: null,
      temperature: null,
      description: undefined,
    });
    expect(repo.lastUpdate).toMatchObject({
      id: 1,
      name: "改名",
      icon: null,
      temperature: null,
      description: undefined,
    });
  });

  it("save 不传 members/expertType 即保留原值（undefined 键缺失）", async () => {
    const { face, repo } = makeFace();
    await face.save(UID, { id: 1, name: "x" });
    const payload = repo.lastUpdate as Record<string, unknown>;
    expect("members" in payload).toBe(false);
    expect("expertType" in payload).toBe(false);
  });

  it("save 不传 id 走新建；缺 name/systemPrompt 拒 ASSISTANT_INVALID", async () => {
    const { face, repo } = makeFace([]);
    await face.save(UID, { name: "新建", systemPrompt: "sp" });
    expect(repo.lastCreate).toMatchObject({ name: "新建", systemPrompt: "sp" });
    try {
      await face.save(UID, { name: "只有名" });
      expect.unreachable();
    } catch (error) {
      expect((error as { code: string }).code).toBe("ASSISTANT_INVALID");
    }
  });

  it("save 团队模板：expertType team 透传 members", async () => {
    const { face, repo } = makeFace([]);
    const members = [
      { id: "m1", name: "n", profession: "p", systemPrompt: "sp" },
    ];
    await face.save(UID, {
      name: "团",
      systemPrompt: "lead",
      expertType: "team",
      members,
    });
    expect(repo.lastCreate).toMatchObject({ expertType: "team", members });
  });

  it("builtin 拒改名（ASSISTANT_BUILTIN）；同名不改名放行", async () => {
    const { face, repo } = makeFace([
      { ...record({ builtin: true }), userId: UID },
    ]);
    try {
      await face.save(UID, { id: 1, name: "新名" });
      expect.unreachable();
    } catch (error) {
      expect((error as { code: string }).code).toBe("ASSISTANT_BUILTIN");
    }
    await face.save(UID, { id: 1, name: "专家甲", systemPrompt: "sp" });
    expect(repo.lastUpdate).toMatchObject({ id: 1 });
  });

  it("delete builtin 拒（ASSISTANT_BUILTIN）；他人所有 NOT_FOUND", async () => {
    const { face } = makeFace([{ ...record({ builtin: true }), userId: UID }]);
    try {
      await face.remove(UID, 1);
      expect.unreachable();
    } catch (error) {
      expect((error as { code: string }).code).toBe("ASSISTANT_BUILTIN");
    }
    try {
      await face.remove(UID, 99);
      expect.unreachable();
    } catch (error) {
      expect((error as { code: string }).code).toBe("ASSISTANT_NOT_FOUND");
    }
  });

  it("marketList 概要不带 systemPrompt，含团标记/职业/分类", async () => {
    const { face } = makeFace();
    const list = await face.marketList();
    const first = list[0];
    expect(first).toMatchObject({
      slug: expect.any(String),
      name: expect.any(String),
      description: expect.any(String),
      profession: expect.any(String),
      categoryId: expect.any(String),
    });
    expect(first.isTeam).toBe(false);
    expect("systemPrompt" in first).toBe(false);
    // 全量无 prompt 泄漏
    expect(JSON.stringify(list)).not.toContain("You are");
  });

  it("marketDetail by slug 回全文；未知 slug 报 EXPERT_MARKET_NOT_FOUND", async () => {
    const { face } = makeFace();
    const list = await face.marketList();
    const detail = await face.marketDetail(list[0].slug);
    expect(detail.systemPrompt.length).toBeGreaterThan(0);
    expect(detail.slug).toBe(list[0].slug);
    try {
      await face.marketDetail("no-such-slug");
      expect.unreachable();
    } catch (error) {
      expect((error as { code: string }).code).toBe("EXPERT_MARKET_NOT_FOUND");
    }
  });
});

describe("expert-tap（体验精修批 spec §1.2 增补）", () => {
  it("marketList 排序三档字段直透（score/downloads/createdAt）", async () => {
    const { face } = makeFace();
    const list = await face.marketList();
    for (const item of list) {
      expect(typeof item.score).toBe("number");
      expect(typeof item.downloads).toBe("number");
      expect(typeof item.createdAt).toBe("string");
    }
    const source = MARKET_EXPERTS.find((e) => e.slug === list[0].slug);
    expect(list[0].score).toBe(source?.score);
    expect(list[0].downloads).toBe(source?.downloads);
    expect(list[0].createdAt).toBe(source?.createdAt);
  });

  it("marketList categoryTitleKey 经 EXPERT_CATEGORIES 映射（全量覆盖 12 分类）", async () => {
    const { face } = makeFace();
    const list = await face.marketList();
    const byKey = new Map(
      EXPERT_CATEGORIES.map((c) => [c.key, c.labelKey] as const),
    );
    for (const item of list) {
      expect(item.categoryTitleKey).toBe(byKey.get(item.categoryId));
    }
  });

  it("未知分类缺省不出 categoryTitleKey 键（JSON 无 undefined 泄漏）", () => {
    const item: ExpertMarketItem = {
      ...MARKET_EXPERTS[0],
      slug: "unknown-cat-expert",
      category: "99-NoSuchCategory",
    };
    const summary = toMarketSummary(item);
    expect("categoryTitleKey" in summary).toBe(false);
    expect(JSON.parse(JSON.stringify(summary))).not.toHaveProperty(
      "categoryTitleKey",
    );
  });

  it("save 新建透传 sourceSlug；不传则键缺省", async () => {
    const { face, repo } = makeFace([]);
    await face.save(UID, {
      name: "市场装",
      systemPrompt: "sp",
      sourceSlug: "senior-developer",
    });
    expect(repo.lastCreate).toMatchObject({ sourceSlug: "senior-developer" });
    await face.save(UID, { name: "自定义", systemPrompt: "sp" });
    expect("sourceSlug" in (repo.lastCreate as object)).toBe(false);
  });

  it("save 更新透传 sourceSlug（null 清空语义原样达 repo）", async () => {
    const { face, repo } = makeFace();
    await face.save(UID, { id: 1, sourceSlug: "frontend-developer" });
    expect(repo.lastUpdate).toMatchObject({ sourceSlug: "frontend-developer" });
    await face.save(UID, { id: 1, name: "x", sourceSlug: null });
    expect(repo.lastUpdate).toMatchObject({ id: 1, sourceSlug: null });
  });
});

describe("expert-tap（A2 尾导入导出批）", () => {
  const exportJson = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      kind: "tianshu-expert",
      version: 1,
      name: "翻译专家",
      systemPrompt: "你是翻译",
      ...overrides,
    });

  it("export 归属校验后产 JSON 文本（kind/version 钉死，无 id/时间戳泄漏）", async () => {
    const { face } = makeFace();
    const { json } = await face.export(UID, 1);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      kind: "tianshu-expert",
      version: 1,
      name: "专家甲",
      systemPrompt: "prompt-full",
    });
    expect(json).not.toContain("builtin");
    expect(json).not.toContain("createdAt");
    expect(json).not.toContain('"id"');
  });

  it("export 他人所有与不存在同报 ASSISTANT_NOT_FOUND", async () => {
    const { face } = makeFace([{ ...record(), userId: 99 }]);
    for (const id of [1, 404]) {
      try {
        await face.export(UID, id);
        expect.unreachable();
      } catch (error) {
        expect((error as { code: string }).code).toBe("ASSISTANT_NOT_FOUND");
      }
    }
  });

  it("import 合法 JSON 走 importFromJson 并回传新建 id/name", async () => {
    const { face, repo } = makeFace([]);
    const result = await face.import(UID, { json: exportJson() });
    expect(repo.lastCreate).toMatchObject({
      name: "翻译专家",
      systemPrompt: "你是翻译",
    });
    expect(result).toEqual({ id: 1, name: "翻译专家" });
  });

  it("import 成员团 JSON 透传 members/expertType", async () => {
    const { face, repo } = makeFace([]);
    const members = [
      { id: "m1", name: "n", profession: "p", systemPrompt: "sp" },
    ];
    await face.import(UID, {
      json: exportJson({ expertType: "team", members }),
    });
    expect(repo.lastCreate).toMatchObject({ expertType: "team", members });
  });

  it("import 坏 JSON / kind 不符 / 缺 name 拒 ASSISTANT_INVALID（带原因）", async () => {
    const { face } = makeFace([]);
    for (const json of [
      "not-json{",
      JSON.stringify({
        kind: "other",
        version: 1,
        name: "x",
        systemPrompt: "s",
      }),
      JSON.stringify({ kind: "tianshu-expert", version: 1, systemPrompt: "s" }),
    ]) {
      try {
        await face.import(UID, { json });
        expect.unreachable();
      } catch (error) {
        expect((error as { code: string }).code).toBe("ASSISTANT_INVALID");
        expect((error as Error).message.length).toBeGreaterThan(0);
      }
    }
  });
});

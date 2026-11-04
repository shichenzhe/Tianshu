/**
 * create/update_expert 工具单测（专家 2.0 Task 3）：deps 注入 prisma 子集
 * mock（create-skill/plan-tools 先例），断言全部来自 brief；两工具的
 * listInstalledSkillNames 清单注入均为必填（update 与 create 对齐，
 * Task 9 收紧），测试注入已安装清单/空清单区分保留与剔除
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeCreateExpertTool,
  makeUpdateExpertTool,
  validateCreateExpertParams,
} from "../../electron/domains/ai/agent/create-expert";

const baseArgs = {
  name: "架构师",
  profession: "软件架构师",
  systemPrompt: "你是架构师…",
  description: "系统设计与技术决策",
  tags: ["架构", "系统设计"],
  quickPrompts: ["帮我设计系统架构"],
};

function ctx() {
  return { sessionId: 1, userId: 1 } as never;
}

describe("validateCreateExpertParams", () => {
  it("合法参数通过并归一", () => {
    const r = validateCreateExpertParams(baseArgs);
    expect(r.ok).toBe(true);
  });
  it("quickPrompts 超 3 条拒绝", () => {
    const r = validateCreateExpertParams({
      ...baseArgs,
      quickPrompts: ["1", "2", "3", "4"],
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("3");
  });
  it("name 超 30 字拒绝", () => {
    const r = validateCreateExpertParams({
      ...baseArgs,
      name: "名".repeat(31),
    });
    expect(r.ok).toBe(false);
  });
  it("icon 非 emoji 拒绝，emoji 通过（含多码点）；裸数字不构成 emoji", () => {
    const bad = validateCreateExpertParams({ ...baseArgs, icon: "abc" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.reason).toContain("emoji");
    }
    expect(validateCreateExpertParams({ ...baseArgs, icon: "🤖" }).ok).toBe(
      true,
    );
    expect(validateCreateExpertParams({ ...baseArgs, icon: "✍️" }).ok).toBe(
      true,
    );
    // 数字是键帽基字符（Emoji_Component）但无表意符号——裸数字拒绝
    const digits = validateCreateExpertParams({ ...baseArgs, icon: "123" });
    expect(digits.ok).toBe(false);
    if (!digits.ok) {
      expect(digits.reason).toContain("emoji");
    }
  });
});

describe("makeCreateExpertTool", () => {
  const prisma = {
    create: vi.fn().mockResolvedValue({ id: 9 }),
    update: vi.fn(),
    findFirst: vi.fn(),
  };
  beforeEach(() => vi.clearAllMocks());

  it("落库透传新字段并序列化", async () => {
    const tool = makeCreateExpertTool({
      prisma,
      listInstalledSkillNames: async () => ["code-review"],
    });
    await tool.execute(ctx(), {
      ...baseArgs,
      skillNames: ["code-review"],
    } as never);
    expect(prisma.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "架构师",
          profession: "软件架构师",
          tags: '["架构","系统设计"]',
          quickPrompts: '["帮我设计系统架构"]',
          skillNames: '["code-review"]',
        }),
      }),
    );
  });

  it("未安装技能名被剔除并在结果文案提示", async () => {
    const tool = makeCreateExpertTool({
      prisma,
      listInstalledSkillNames: async () => [],
    });
    const out = await tool.execute(ctx(), {
      ...baseArgs,
      skillNames: ["nope"],
    } as never);
    expect(out).toContain("nope");
    expect(prisma.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ skillNames: undefined }),
      }),
    );
  });

  /** deps 构造 helper（专家团用例）：按已安装技能清单注入 */
  const depsWith = (installed: string[]) => ({
    prisma,
    listInstalledSkillNames: async () => installed,
  });

  it("team 创建：members 校验链（非法 id/重复 id/超 13/agent 带 members 报错）", async () => {
    const tool = makeCreateExpertTool(depsWith(["code-review"]));
    const base = { name: "交易团", systemPrompt: "主理人…" } as never;
    // 合法 team
    expect(
      await tool.execute(ctx(), {
        ...base,
        expertType: "team",
        members: [
          {
            id: "risk-officer",
            name: "严守仓",
            profession: "风控官",
            systemPrompt: "P",
          },
        ],
      } as never),
    ).not.toContain("错误");
    // 非法 id
    expect(
      await tool.execute(ctx(), {
        ...base,
        expertType: "team",
        members: [
          { id: "Bad_Id", name: "x", profession: "y", systemPrompt: "P" },
        ],
      } as never),
    ).toContain("kebab-case");
    // 重复 id
    expect(
      await tool.execute(ctx(), {
        ...base,
        expertType: "team",
        members: [
          { id: "a", name: "x", profession: "y", systemPrompt: "P" },
          { id: "a", name: "z", profession: "w", systemPrompt: "Q" },
        ],
      } as never),
    ).toContain("重复");
    // team 缺 members
    expect(
      await tool.execute(ctx(), { ...base, expertType: "team" } as never),
    ).toContain("错误");
    // agent 带 members
    expect(
      await tool.execute(ctx(), {
        ...base,
        members: [{ id: "a", name: "x", profession: "y", systemPrompt: "P" }],
      } as never),
    ).toContain("错误");
    // 超 13 名成员
    const tooMany = Array.from({ length: 14 }, (_, i) => ({
      id: `m-${i}`,
      name: `员${i}`,
      profession: "分析师",
      systemPrompt: "P",
    }));
    expect(
      await tool.execute(ctx(), {
        ...base,
        expertType: "team",
        members: tooMany,
      } as never),
    ).toContain("13");
  });

  it("team 创建落库：expertType 透传、members 序列化；agent 归一不写列", async () => {
    const tool = makeCreateExpertTool(depsWith([]));
    const members = [
      {
        id: "risk-officer",
        name: "严守仓",
        profession: "风控官",
        systemPrompt: "P",
      },
    ];
    await tool.execute(ctx(), {
      name: "交易团",
      systemPrompt: "主理人…",
      expertType: "team",
      members,
    } as never);
    expect(prisma.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          expertType: "team",
          members: JSON.stringify(members),
        }),
      }),
    );
    // 缺省（agent）不写 expertType/members 列
    await tool.execute(ctx(), { name: "单体", systemPrompt: "P" } as never);
    expect(prisma.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          expertType: undefined,
          members: undefined,
        }),
      }),
    );
  });
});

describe("makeUpdateExpertTool", () => {
  const row = { id: 5, userId: 1, name: "架构师" };
  const prisma = {
    create: vi.fn(),
    update: vi.fn().mockResolvedValue({ id: 5 }),
    findFirst: vi.fn().mockResolvedValue(row),
  };
  beforeEach(() => vi.clearAllMocks());

  it("按名称定位并差量更新", async () => {
    const tool = makeUpdateExpertTool({
      prisma,
      listInstalledSkillNames: async () => [],
    });
    await tool.execute(ctx(), {
      name: "架构师",
      profession: "首席架构师",
    } as never);
    expect(prisma.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { name: "架构师", userId: 1 } }),
    );
    expect(prisma.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 5 },
        data: expect.objectContaining({ profession: "首席架构师" }),
      }),
    );
  });

  it("未安装技能名被剔除并在结果文案提示（全剔 = 清空列）", async () => {
    const tool = makeUpdateExpertTool({
      prisma,
      listInstalledSkillNames: async () => ["code-review"],
    });
    const out = await tool.execute(ctx(), {
      name: "架构师",
      skillNames: ["nope", "code-review"],
    } as never);
    expect(out).toContain("nope");
    expect(prisma.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 5 },
        data: expect.objectContaining({ skillNames: '["code-review"]' }),
      }),
    );
  });

  it("team 更新：members 传即整体覆盖；agent 带 members 报错；转 agent 清列", async () => {
    const tool = makeUpdateExpertTool({
      prisma,
      listInstalledSkillNames: async () => [],
    });
    const members = [
      {
        id: "risk-officer",
        name: "严守仓",
        profession: "风控官",
        systemPrompt: "P",
      },
    ];
    await tool.execute(ctx(), {
      name: "架构师",
      expertType: "team",
      members,
    } as never);
    expect(prisma.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 5 },
        data: expect.objectContaining({
          expertType: "team",
          members: JSON.stringify(members),
        }),
      }),
    );
    // agent 带 members：报错且不落库
    prisma.update.mockClear();
    const out = await tool.execute(ctx(), {
      name: "架构师",
      expertType: "agent",
      members,
    } as never);
    expect(out).toContain("错误");
    expect(prisma.update).not.toHaveBeenCalled();
    // 转 agent：expertType/members 连带清空
    await tool.execute(ctx(), { name: "架构师", expertType: "agent" } as never);
    expect(prisma.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ expertType: null, members: null }),
      }),
    );
  });

  it("定位失败返回错误文案不抛异常", async () => {
    prisma.findFirst.mockResolvedValueOnce(null);
    const tool = makeUpdateExpertTool({
      prisma,
      listInstalledSkillNames: async () => [],
    });
    const out = await tool.execute(ctx(), { name: "不存在" } as never);
    expect(out).toContain("错误");
    expect(prisma.update).not.toHaveBeenCalled();
  });
});

/**
 * assistant.repo 单测：新字段透传(tags JSON 序列化/description/sourceSlug)、
 * 去播种回归、builtin 删除限制回归。IPC/DB 副作用 mock 三件套隔离
 * （同 automation-repo.test.ts）。
 */
import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock("../../electron/commons/Log", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    assistant: {
      count: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

import { AssistantRepository } from "../../electron/domains/ai/chat/assistant.repo";
import prisma from "../../electron/commons/prisma-client";

const UID = 1;
const repo = new AssistantRepository();

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  name: "通用助手",
  icon: "🤖",
  systemPrompt: "prompt",
  temperature: null,
  topP: null,
  maxTokens: null,
  builtin: false,
  description: null,
  tags: null,
  sourceSlug: null,
  profession: null,
  quickPrompts: null,
  categoryId: null,
  skillNames: null,
  expertType: null,
  members: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  userId: UID,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("list（去播种回归）", () => {
  it("空用户不再播种，直接返回空数组", async () => {
    (prisma.assistant.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
      [],
    );
    const result = await repo.list(UID);
    expect(result).toEqual([]);
    expect(prisma.assistant.count).not.toHaveBeenCalled();
  });

  it("toRecord 解析 tags JSON 字符串为数组", async () => {
    (prisma.assistant.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      row({ tags: '["a","b"]' }),
    ]);
    const result = await repo.list(UID);
    expect(result[0].tags).toEqual(["a", "b"]);
  });

  it("toRecord 对坏 JSON tags 回退空数组不抛错", async () => {
    (prisma.assistant.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      row({ tags: "{broken" }),
    ]);
    const result = await repo.list(UID);
    expect(result[0].tags).toEqual([]);
  });

  it("toRecord 解析 quickPrompts/skillNames 坏 JSON 回退空数组", async () => {
    (prisma.assistant.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      row({ id: 2, quickPrompts: "{bad", skillNames: "{bad" }),
    ]);
    const list = await repo.list(1);
    const badRow = list.find((r) => r.id === 2); // stub 行 quickPrompts 存 "{bad"
    expect(badRow?.quickPrompts).toEqual([]);
    expect(badRow?.skillNames).toEqual([]);
  });
});

describe("create（新字段透传）", () => {
  it("tags 序列化为 JSON 字符串，description/sourceSlug 落库", async () => {
    (prisma.assistant.create as ReturnType<typeof vi.fn>).mockResolvedValue(
      row({
        description: "d",
        tags: '["x"]',
        sourceSlug: "general",
      }),
    );
    await repo.create(
      {
        name: "通用助手",
        systemPrompt: "prompt",
        description: "d",
        tags: ["x"],
        sourceSlug: "general",
      },
      UID,
    );
    expect(prisma.assistant.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        description: "d",
        tags: '["x"]',
        sourceSlug: "general",
      }),
    });
  });

  it("create 序列化 quickPrompts/skillNames 为 JSON 字符串并透传新字段", async () => {
    (prisma.assistant.create as Mock).mockResolvedValue(row());
    await repo.create(
      {
        name: "E",
        systemPrompt: "P",
        profession: "架构师",
        categoryId: "02-Engineering",
        quickPrompts: ["帮我评审"],
        skillNames: ["code-review"],
      } as never,
      1,
    );
    expect(prisma.assistant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          profession: "架构师",
          categoryId: "02-Engineering",
          quickPrompts: '["帮我评审"]',
          skillNames: '["code-review"]',
        }),
      }),
    );
  });
});

describe("update（可空清空语义）", () => {
  it("tags null 清空、undefined 不出现在 data", async () => {
    (prisma.assistant.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      row(),
    );
    (prisma.assistant.update as ReturnType<typeof vi.fn>).mockResolvedValue(
      row(),
    );
    await repo.update({ id: 1, name: "n", tags: null }, UID);
    const data = (prisma.assistant.update as ReturnType<typeof vi.fn>).mock
      .calls[0][0].data;
    expect(data.tags).toBeNull();
    await repo.update({ id: 1, description: "new" }, UID);
    const data2 = (prisma.assistant.update as ReturnType<typeof vi.fn>).mock
      .calls[1][0].data;
    expect("tags" in data2).toBe(false);
    expect(data2.description).toBe("new");
  });

  it("update null 清空 / undefined 不改 / 数组序列化", async () => {
    (prisma.assistant.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      row(),
    );
    (prisma.assistant.update as ReturnType<typeof vi.fn>).mockResolvedValue(
      row(),
    );
    await repo.update(
      {
        id: 1,
        profession: null,
        quickPrompts: ["a"],
        skillNames: null,
      } as never,
      1,
    );
    const data = (prisma.assistant.update as Mock).mock.calls[0][0].data;
    expect(data.profession).toBeNull();
    expect(data.quickPrompts).toBe('["a"]');
    expect(data.skillNames).toBeNull();
    expect("categoryId" in data).toBe(false);
  });
});

describe("expertType/members（专家团列）", () => {
  const member = {
    id: "m1",
    name: "甲",
    profession: "分析师",
    systemPrompt: "P",
  };

  it("toRecord 解析 members；expertType 仅 team 透传其余归一 undefined", async () => {
    (prisma.assistant.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      row({ expertType: "team", members: JSON.stringify([member]) }),
      row({ id: 2, expertType: "agent", members: "{bad" }),
    ]);
    const list = await repo.list(UID);
    expect(list[0].expertType).toBe("team");
    expect(list[0].members).toEqual([member]);
    expect(list[1].expertType).toBeUndefined();
    expect(list[1].members).toEqual([]);
  });

  it("create/update 透传 expertType 与 members 序列化", async () => {
    (prisma.assistant.create as Mock).mockResolvedValue(row());
    await repo.create(
      {
        name: "交易团",
        systemPrompt: "主理人…",
        expertType: "team",
        members: [member],
      } as never,
      1,
    );
    const data = (prisma.assistant.create as Mock).mock.calls[0][0].data;
    expect(data.expertType).toBe("team");
    expect(JSON.parse(data.members)).toEqual([member]);

    (prisma.assistant.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      row(),
    );
    (prisma.assistant.update as ReturnType<typeof vi.fn>).mockResolvedValue(
      row(),
    );
    await repo.update({ id: 1, members: null } as never, 1);
    const updateData = (prisma.assistant.update as Mock).mock.calls[0][0].data;
    expect(updateData.members).toBeNull();
    await repo.update({ id: 1, name: "n" } as never, 1);
    const untouched = (prisma.assistant.update as Mock).mock.calls[1][0].data;
    expect("expertType" in untouched).toBe(false);
    expect("members" in untouched).toBe(false);
  });

  it("members 载荷校验（T5-I2）：create 空成员名拒绝且不落库", async () => {
    await expect(
      repo.create(
        {
          name: "交易团",
          systemPrompt: "P",
          expertType: "team",
          members: [
            { ...member, name: "" }, // 空名过不了 teamMemberSchema min(1)
          ],
        } as never,
        UID,
      ),
    ).rejects.toThrow("专家团成员不合法");
    expect(prisma.assistant.create).not.toHaveBeenCalled();
  });

  it("members 载荷校验：id 超 64 字符拒绝（对齐 dispatch 参数上限）", async () => {
    await expect(
      repo.create(
        {
          name: "团",
          systemPrompt: "P",
          expertType: "team",
          members: [{ ...member, id: "a".repeat(65) }],
        } as never,
        UID,
      ),
    ).rejects.toThrow("专家团成员不合法");
    // 64 字符边界放行
    await repo.create(
      {
        name: "团",
        systemPrompt: "P",
        expertType: "team",
        members: [{ ...member, id: "a".repeat(64) }],
      } as never,
      UID,
    );
    expect(prisma.assistant.create).toHaveBeenCalledTimes(1);
  });

  it("members 载荷校验（T5-I2）：update 重复成员 id 拒绝且不落库", async () => {
    (prisma.assistant.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      row({ expertType: "team" }),
    );
    await expect(
      repo.update(
        {
          id: 1,
          expertType: "team",
          members: [member, { ...member, name: "乙" }], // 同 id 两员
        } as never,
        UID,
      ),
    ).rejects.toThrow("成员 id 重复: m1");
    expect(prisma.assistant.update).not.toHaveBeenCalled();
  });

  it("members 载荷校验：超 13 员拒绝（集合规则与工具链同一函数）", async () => {
    const many = Array.from({ length: 14 }, (_, i) => ({
      ...member,
      id: `m${i + 1}`,
      name: `员${i + 1}`,
    }));
    await expect(
      repo.create(
        {
          name: "团",
          systemPrompt: "P",
          expertType: "team",
          members: many,
        } as never,
        UID,
      ),
    ).rejects.toThrow("专家团成员最多 13 名");
  });

  it("update expertType 带值透传（T1 遗留补断言）", async () => {
    (prisma.assistant.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      row(),
    );
    (prisma.assistant.update as ReturnType<typeof vi.fn>).mockResolvedValue(
      row(),
    );
    await repo.update({ id: 1, expertType: "team" } as never, UID);
    const data = (prisma.assistant.update as Mock).mock.calls[0][0].data;
    expect(data.expertType).toBe("team");
  });

  it("expertType=agent 双归一：create 不写列 / update 清列（Fix round 1）", async () => {
    // create/import 同走 create：agent 归一 undefined（列契约只存 "team"|NULL）
    (prisma.assistant.create as Mock).mockResolvedValue(row());
    await repo.create(
      { name: "单专家", systemPrompt: "P", expertType: "agent" } as never,
      1,
    );
    const data = (prisma.assistant.create as Mock).mock.calls[0][0].data;
    expect(data.expertType).toBeUndefined();

    // update 显式 agent = team 转回单专家的清列通道（与工具侧同口径）
    (prisma.assistant.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      row({ expertType: "team" }),
    );
    (prisma.assistant.update as ReturnType<typeof vi.fn>).mockResolvedValue(
      row(),
    );
    await repo.update({ id: 1, expertType: "agent" } as never, UID);
    const updateData = (prisma.assistant.update as Mock).mock.calls[0][0].data;
    expect(updateData.expertType).toBeNull();
  });
});

describe("delete（builtin 限制回归）", () => {
  it("builtin 行拒绝删除", async () => {
    (prisma.assistant.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      row({ builtin: true }),
    );
    await expect(repo.delete(1, UID)).rejects.toThrow("ASSISTANT_BUILTIN");
    expect(prisma.assistant.delete).not.toHaveBeenCalled();
  });

  it("非本人/不存在行拒绝 ASSISTANT_NOT_FOUND（requireOwned 收敛共享）", async () => {
    (prisma.assistant.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      null,
    );
    await expect(repo.delete(1, UID)).rejects.toThrow("ASSISTANT_NOT_FOUND");
    expect(prisma.assistant.delete).not.toHaveBeenCalled();
  });
});

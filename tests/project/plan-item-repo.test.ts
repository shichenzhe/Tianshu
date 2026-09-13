/**
 * 计划事项仓储单测（项目模块三期 spec §3.2）：
 * create 空 title/非法枚举拒绝与 sortOrder=同状态列 max+1（本地任务 null 项目独立计数）、
 * list/listMine 双视图聚合谓词与排序、update 局部更新（未传键缺席）与 NOT_FOUND、
 * move 拖拽落点、delete、toRecord JSON 列容错（畸形 → 空数组/空对象）。
 * 依赖经 vi.mock 替换（electron ipcMain / prisma client），沿用 project-repo.test.ts 模式。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
}));

// prisma stub：各测试按需覆写实现（vi.hoisted 使其在 vi.mock 工厂执行前初始化）
const prismaStub = vi.hoisted(() => ({
  planItem: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

vi.mock("../../electron/commons/prisma-client", () => ({
  default: prismaStub,
}));

import PlanItemRepository from "../../electron/domains/project/plan-item.repo";
import { PLAN_ITEM_NOT_FOUND } from "../../electron/domains/project/plan-item.entity";

const repo = new PlanItemRepository();

const now = new Date("2026-09-13T00:00:00Z");
const projectRow = {
  id: 1,
  projectId: 11,
  title: "事项A",
  status: "in_progress",
  priority: "P0",
  assigneeId: 1,
  tags: JSON.stringify(["前端", "联调"]),
  customFields: JSON.stringify({ 工作量: 3 }),
  sortOrder: 2,
  createdById: 1,
  createdAt: now,
  updatedAt: now,
};

describe("PlanItemRepository.create", () => {
  beforeEach(() => vi.clearAllMocks());

  it("title 空串或纯空白 → 抛「标题不能为空」，不落库", async () => {
    await expect(repo.create({ createdById: 1, title: "" })).rejects.toThrow(
      "标题不能为空",
    );
    await expect(repo.create({ createdById: 1, title: "   " })).rejects.toThrow(
      "标题不能为空",
    );
    expect(prismaStub.planItem.create).not.toHaveBeenCalled();
  });

  it("非法 status → 抛「无效的状态」，不落库", async () => {
    await expect(
      repo.create({ createdById: 1, title: "t", status: "doing" as never }),
    ).rejects.toThrow("无效的状态");
    expect(prismaStub.planItem.create).not.toHaveBeenCalled();
  });

  it("非法 priority → 抛「无效的优先级」，不落库", async () => {
    await expect(
      repo.create({ createdById: 1, title: "t", priority: "P9" as never }),
    ).rejects.toThrow("无效的优先级");
    expect(prismaStub.planItem.create).not.toHaveBeenCalled();
  });

  it("正常创建（全参）→ title 去首尾空白、tags/customFields JSON 序列化落库、sortOrder=同列 max+1", async () => {
    prismaStub.planItem.findFirst.mockResolvedValue({ sortOrder: 5 });
    prismaStub.planItem.create.mockResolvedValue(projectRow);

    await repo.create({
      createdById: 1,
      title: "  事项A  ",
      projectId: 11,
      status: "in_progress",
      priority: "P0",
      assigneeId: 1,
      tags: ["前端", "联调"],
      customFields: { 工作量: 3 },
    });

    expect(prismaStub.planItem.findFirst).toHaveBeenCalledWith({
      where: { projectId: 11, status: "in_progress" },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });
    expect(prismaStub.planItem.create).toHaveBeenCalledWith({
      data: {
        title: "事项A",
        projectId: 11,
        status: "in_progress",
        priority: "P0",
        assigneeId: 1,
        tags: JSON.stringify(["前端", "联调"]),
        customFields: JSON.stringify({ 工作量: 3 }),
        sortOrder: 6,
        createdById: 1,
      },
    });
  });

  it("本地任务（projectId 缺省）→ 同列计数按 projectId null 匹配，无同列行 sortOrder=1", async () => {
    prismaStub.planItem.findFirst.mockResolvedValue(null);
    prismaStub.planItem.create.mockResolvedValue({
      ...projectRow,
      projectId: null,
      tags: null,
      customFields: null,
      sortOrder: 1,
    });

    const record = await repo.create({ createdById: 1, title: "本地任务" });

    expect(prismaStub.planItem.findFirst).toHaveBeenCalledWith({
      where: { projectId: null, status: "not_started" },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });
    expect(prismaStub.planItem.create).toHaveBeenCalledWith({
      data: {
        title: "本地任务",
        projectId: null,
        status: "not_started",
        priority: "P1",
        assigneeId: null,
        tags: undefined,
        customFields: undefined,
        sortOrder: 1,
        createdById: 1,
      },
    });
    expect(record.projectId).toBeNull();
    expect(record.tags).toEqual([]);
    expect(record.customFields).toEqual({});
  });
});

describe("PlanItemRepository.list", () => {
  beforeEach(() => vi.clearAllMocks());

  it("按项目过滤，sortOrder asc + updatedAt desc，行转记录（JSON 解析 + DateTime→ISO）", async () => {
    prismaStub.planItem.findMany.mockResolvedValue([projectRow]);

    const records = await repo.list(11);

    expect(prismaStub.planItem.findMany).toHaveBeenCalledWith({
      where: { projectId: 11 },
      orderBy: [{ sortOrder: "asc" }, { updatedAt: "desc" }],
    });
    expect(records).toEqual([
      {
        id: 1,
        projectId: 11,
        title: "事项A",
        status: "in_progress",
        priority: "P0",
        assigneeId: 1,
        tags: ["前端", "联调"],
        customFields: { 工作量: 3 },
        sortOrder: 2,
        createdById: 1,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    ]);
  });
});

describe("PlanItemRepository.listMine", () => {
  beforeEach(() => vi.clearAllMocks());

  it("个人聚合：指派给我 OR 我创建（含本地/项目行），updatedAt desc", async () => {
    prismaStub.planItem.findMany.mockResolvedValue([]);

    await repo.listMine(7);

    expect(prismaStub.planItem.findMany).toHaveBeenCalledWith({
      where: { OR: [{ assigneeId: 7 }, { createdById: 7 }] },
      orderBy: { updatedAt: "desc" },
    });
  });
});

describe("PlanItemRepository.update", () => {
  beforeEach(() => vi.clearAllMocks());

  it("局部更新 → data 只含传入键（未传字段不覆盖）", async () => {
    prismaStub.planItem.findUnique.mockResolvedValue(projectRow);

    await repo.update({ id: 1, title: "新标题", priority: "P2" });

    expect(prismaStub.planItem.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { title: "新标题", priority: "P2" },
    });
  });

  it("assigneeId null → 显式清空处理人；tags/customFields 序列化落库", async () => {
    prismaStub.planItem.findUnique.mockResolvedValue(projectRow);

    await repo.update({
      id: 1,
      assigneeId: null,
      tags: ["新标签"],
      customFields: { 工作量: 5 },
    });

    expect(prismaStub.planItem.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: {
        assigneeId: null,
        tags: JSON.stringify(["新标签"]),
        customFields: JSON.stringify({ 工作量: 5 }),
      },
    });
  });

  it("title trim 后为空 → 抛「标题不能为空」", async () => {
    prismaStub.planItem.findUnique.mockResolvedValue(projectRow);
    await expect(repo.update({ id: 1, title: "  " })).rejects.toThrow(
      "标题不能为空",
    );
    expect(prismaStub.planItem.update).not.toHaveBeenCalled();
  });

  it("非法枚举 → 抛中文错误，不落库", async () => {
    prismaStub.planItem.findUnique.mockResolvedValue(projectRow);
    await expect(
      repo.update({ id: 1, status: "cancelled" as never }),
    ).rejects.toThrow("无效的状态");
    await expect(
      repo.update({ id: 1, priority: "P3" as never }),
    ).rejects.toThrow("无效的优先级");
    expect(prismaStub.planItem.update).not.toHaveBeenCalled();
  });

  it("id 不存在 → 抛 PLAN_ITEM_NOT_FOUND", async () => {
    prismaStub.planItem.findUnique.mockResolvedValue(null);
    await expect(repo.update({ id: 99, title: "x" })).rejects.toThrow(
      PLAN_ITEM_NOT_FOUND,
    );
    expect(prismaStub.planItem.update).not.toHaveBeenCalled();
  });
});

describe("PlanItemRepository.move", () => {
  beforeEach(() => vi.clearAllMocks());

  it("拖拽落点 → 更新 status + 列内新序 sortOrder", async () => {
    prismaStub.planItem.findUnique.mockResolvedValue(projectRow);

    await repo.move({ id: 1, status: "done", sortOrder: 3 });

    expect(prismaStub.planItem.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { status: "done", sortOrder: 3 },
    });
  });

  it("非法 status → 抛「无效的状态」", async () => {
    prismaStub.planItem.findUnique.mockResolvedValue(projectRow);
    await expect(
      repo.move({ id: 1, status: "archived" as never, sortOrder: 1 }),
    ).rejects.toThrow("无效的状态");
    expect(prismaStub.planItem.update).not.toHaveBeenCalled();
  });

  it("id 不存在 → 抛 PLAN_ITEM_NOT_FOUND", async () => {
    prismaStub.planItem.findUnique.mockResolvedValue(null);
    await expect(
      repo.move({ id: 99, status: "done", sortOrder: 1 }),
    ).rejects.toThrow(PLAN_ITEM_NOT_FOUND);
    expect(prismaStub.planItem.update).not.toHaveBeenCalled();
  });
});

describe("PlanItemRepository.remove", () => {
  it("按 id 删除", async () => {
    await repo.remove(9);
    expect(prismaStub.planItem.delete).toHaveBeenCalledWith({
      where: { id: 9 },
    });
  });
});

describe("PlanItemRepository.toRecord（JSON 列容错）", () => {
  beforeEach(() => vi.clearAllMocks());

  it("畸形 JSON / 非预期形状 / null 列 → tags=[]、customFields={}", async () => {
    prismaStub.planItem.findMany.mockResolvedValue([
      { ...projectRow, tags: "{oops", customFields: "not-json" },
      {
        ...projectRow,
        tags: '"字符串"',
        customFields: JSON.stringify(["数组"]),
      },
      { ...projectRow, tags: null, customFields: null },
    ]);

    const records = await repo.list(11);

    expect(records.map((r) => r.tags)).toEqual([[], [], []]);
    expect(records.map((r) => r.customFields)).toEqual([{}, {}, {}]);
  });
});

/**
 * 计划事项仓储单测（项目模块三期 spec §3.2）：
 * create 空 title/非法枚举拒绝与 sortOrder=同状态列 max+1（本地任务 null 项目独立计数）、
 * list/listMine 双视图聚合谓词与排序、update 局部更新（未传键缺席、
 * status 变更重算目标状态列尾 sortOrder、status 未变/未传不重算）与 NOT_FOUND、
 * move 拖拽落点、delete、toRecord JSON 列容错（畸形 → 空数组/空对象）；
 * fields:list/save 自定义字段（option 域 planFields:<projectId> 行、畸形行丢弃、
 * 空名/非法类型/重名拒绝、deleteMany+createMany 全量替换、消失字段行值逐行清理
 * + 失败收集汇总抛出）、8 通道自注册（fields 两通道补齐）。
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
  option: {
    findMany: vi.fn(),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  },
}));

vi.mock("../../electron/commons/prisma-client", () => ({
  default: prismaStub,
}));

import PlanItemRepository from "../../electron/domains/project/plan-item.repo";
import { PLAN_ITEM_NOT_FOUND } from "../../electron/domains/project/plan-item.entity";
import { ipcMain } from "electron";

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

  it("status 变更 → 重算目标状态列尾 sortOrder 落库（弹窗编辑路径不再残留旧列序号）", async () => {
    prismaStub.planItem.findUnique.mockResolvedValue(projectRow);
    prismaStub.planItem.findFirst.mockResolvedValue({ sortOrder: 7 });

    await repo.update({ id: 1, status: "done" });

    expect(prismaStub.planItem.findFirst).toHaveBeenCalledWith({
      where: { projectId: 11, status: "done" },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });
    expect(prismaStub.planItem.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { status: "done", sortOrder: 8 },
    });
  });

  it("status 传值但未变 → 不重算 sortOrder（data 无该键、不查列尾）", async () => {
    prismaStub.planItem.findUnique.mockResolvedValue(projectRow);

    await repo.update({ id: 1, status: "in_progress" });

    expect(prismaStub.planItem.findFirst).not.toHaveBeenCalled();
    expect(prismaStub.planItem.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { status: "in_progress" },
    });
    expect(prismaStub.planItem.update.mock.calls[0][0].data).not.toHaveProperty(
      "sortOrder",
    );
  });

  it("未传 status → 不重算 sortOrder（data 无该键）", async () => {
    prismaStub.planItem.findUnique.mockResolvedValue(projectRow);

    await repo.update({ id: 1, title: "只改标题" });

    expect(prismaStub.planItem.findFirst).not.toHaveBeenCalled();
    expect(prismaStub.planItem.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { title: "只改标题" },
    });
    expect(prismaStub.planItem.update.mock.calls[0][0].data).not.toHaveProperty(
      "sortOrder",
    );
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

describe("PlanItemRepository.listFields", () => {
  beforeEach(() => vi.clearAllMocks());

  it("读 option 域 planFields:<projectId> 行（value=字段名，note=类型），按 name asc 排序", async () => {
    prismaStub.option.findMany.mockResolvedValue([
      { value: "交付日", note: "date" },
      { value: "工作量", note: "number" },
    ]);

    const defs = await repo.listFields(11);

    expect(prismaStub.option.findMany).toHaveBeenCalledWith({
      where: { type: "planFields:11" },
      orderBy: { value: "asc" },
    });
    expect(defs).toEqual([
      { name: "交付日", type: "date" },
      { name: "工作量", type: "number" },
    ]);
  });

  it("畸形行（note 缺失 / 不在三枚举）→ 丢弃，不进结果", async () => {
    prismaStub.option.findMany.mockResolvedValue([
      { value: "交付日", note: null },
      { value: "工作量", note: "percent" },
      { value: "备注", note: "text" },
    ]);

    const defs = await repo.listFields(11);

    expect(defs).toEqual([{ name: "备注", type: "text" }]);
  });
});

describe("PlanItemRepository.saveFields", () => {
  beforeEach(() => vi.clearAllMocks());

  it("空名/非法类型/重名 → 抛中文错误，不触达 option 写与行清理", async () => {
    await expect(
      repo.saveFields(11, [{ name: "   ", type: "text" }]),
    ).rejects.toThrow("字段名不能为空");
    await expect(
      repo.saveFields(11, [{ name: "工作量", type: "percent" as never }]),
    ).rejects.toThrow("无效的字段类型");
    await expect(
      repo.saveFields(11, [
        { name: "工作量", type: "number" },
        { name: " 工作量 ", type: "text" },
      ]),
    ).rejects.toThrow("字段名重复");
    expect(prismaStub.option.deleteMany).not.toHaveBeenCalled();
    expect(prismaStub.option.createMany).not.toHaveBeenCalled();
    expect(prismaStub.planItem.update).not.toHaveBeenCalled();
  });

  it("正常保存：全量替换 deleteMany + createMany（name/value=字段名、note=类型、name trim）；无消失字段不触发行清理", async () => {
    prismaStub.option.findMany.mockResolvedValue([
      { value: "交付日" },
      { value: "工作量" },
    ]);

    await repo.saveFields(11, [
      { name: " 交付日 ", type: "date" },
      { name: "工作量", type: "text" },
    ]);

    expect(prismaStub.option.findMany).toHaveBeenCalledWith({
      where: { type: "planFields:11" },
      select: { value: true },
    });
    expect(prismaStub.option.deleteMany).toHaveBeenCalledWith({
      where: { type: "planFields:11" },
    });
    expect(prismaStub.option.createMany).toHaveBeenCalledWith({
      data: [
        {
          type: "planFields:11",
          name: "交付日",
          value: "交付日",
          note: "date",
        },
        {
          type: "planFields:11",
          name: "工作量",
          value: "工作量",
          note: "text",
        },
      ],
    });
    expect(prismaStub.planItem.findMany).not.toHaveBeenCalled();
    expect(prismaStub.planItem.update).not.toHaveBeenCalled();
  });

  it("空字段表清空：仅 deleteMany（createMany 空数组不调用），全量消失仍触发行清理", async () => {
    prismaStub.option.findMany.mockResolvedValue([{ value: "工作量" }]);
    prismaStub.planItem.findMany.mockResolvedValue([]);

    await repo.saveFields(11, []);

    expect(prismaStub.option.deleteMany).toHaveBeenCalledTimes(1);
    expect(prismaStub.option.createMany).not.toHaveBeenCalled();
    expect(prismaStub.planItem.findMany).toHaveBeenCalledWith({
      where: { projectId: 11 },
      select: { id: true, customFields: true },
    });
  });

  it("消失字段 → 该项目全部行逐行删键回写（清成空对象也回写）；未受影响/空列/畸形行不 update", async () => {
    prismaStub.option.findMany.mockResolvedValue([
      { value: "工作量" },
      { value: "交付日" },
    ]);
    prismaStub.planItem.findMany.mockResolvedValue([
      { id: 1, customFields: JSON.stringify({ 工作量: 3, 备注: "x" }) },
      { id: 2, customFields: JSON.stringify({ 工作量: 5 }) },
      { id: 3, customFields: JSON.stringify({ 备注: "y" }) },
      { id: 4, customFields: null },
      { id: 5, customFields: "{oops" },
    ]);

    await repo.saveFields(11, [{ name: "交付日", type: "date" }]);

    expect(prismaStub.planItem.update).toHaveBeenCalledTimes(2);
    expect(prismaStub.planItem.update).toHaveBeenNthCalledWith(1, {
      where: { id: 1 },
      data: { customFields: JSON.stringify({ 备注: "x" }) },
    });
    expect(prismaStub.planItem.update).toHaveBeenNthCalledWith(2, {
      where: { id: 2 },
      data: { customFields: JSON.stringify({}) },
    });
  });

  it("行清理失败 → 收集不中断（全部行均尝试），收尾抛「清理字段值失败 N 条」", async () => {
    prismaStub.option.findMany.mockResolvedValue([{ value: "工作量" }]);
    prismaStub.planItem.findMany.mockResolvedValue([
      { id: 1, customFields: JSON.stringify({ 工作量: 3 }) },
      { id: 2, customFields: JSON.stringify({ 工作量: 5 }) },
      { id: 3, customFields: JSON.stringify({ 工作量: 7 }) },
    ]);
    prismaStub.planItem.update.mockImplementation(
      async (args: { where: { id: number } }) => {
        if (args.where.id !== 1) {
          throw new Error("db locked");
        }
        return {};
      },
    );

    await expect(repo.saveFields(11, [])).rejects.toThrow(
      "清理字段值失败 2 条",
    );
    expect(prismaStub.planItem.update).toHaveBeenCalledTimes(3);
  });
});

describe("PlanItemRepository IPC 注册", () => {
  it("八个 planItem 通道自注册（fields 两通道补齐，union 不再占位）", () => {
    new PlanItemRepository();

    expect(ipcMain.handle).toHaveBeenCalledTimes(8);
    for (const channel of [
      "planItem:list",
      "planItem:listMine",
      "planItem:create",
      "planItem:update",
      "planItem:delete",
      "planItem:move",
      "planItem:fields:list",
      "planItem:fields:save",
    ]) {
      expect(ipcMain.handle).toHaveBeenCalledWith(
        channel,
        expect.any(Function),
      );
    }
  });
});

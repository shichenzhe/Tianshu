/**
 * 计划事项仓储单测（项目模块三期 spec §3.2）：
 * create 空 title/非法枚举拒绝与 sortOrder=同状态列 max+1（本地任务 null 项目独立计数）、
 * list/listMine 双视图聚合谓词与排序、update 局部更新（未传键缺席、
 * status 变更重算目标状态列尾 sortOrder、status 未变/未传不重算）与 NOT_FOUND、
 * move 拖拽落点、delete、toRecord JSON 列容错（畸形 → 空数组/空对象）；
 * fields:list/save 自定义字段（option 域 planFields:<projectId> 行、畸形行丢弃、
 * 空名/非法类型/重名拒绝、deleteMany+createMany 全量替换、消失字段行值逐行清理
 * + 失败收集汇总抛出）、11 通道自注册（fields 两通道 + 附件三通道补齐）；
 * 字段扩展（子系统 A）：source/startDate/dueDate 透传、null/空串清空、
 * 非法日期串拒绝、非法 source 拒绝、处理人必须是项目成员校验；
 * 字段扩展（子系统 D）：description 透传（create/update，null = 清空）与
 * toRecord null→空串归一、attachments 三通道（list/create/delete）与
 * 事项删除级联清附件关联（文件实体保留）。
 * v8（子系统 F）：aiSummary 读侧 null→空串归一、人路径负向（create/update
 * 输出永不含 aiSummary 键）、appendAiSummary 工具专用追加通道（换行 + 日期前缀、
 * 只增不改、id 不存在返回 null）。
 * 依赖经 vi.mock 替换（electron ipcMain / prisma client），沿用 project-repo.test.ts 模式。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  planItemAttachment: {
    findMany: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  },
  projectMember: {
    findFirst: vi.fn(),
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
  startDate: null,
  dueDate: null,
  source: "manual",
  aiSummary: null,
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
    prismaStub.projectMember.findFirst.mockResolvedValue({ id: 1 });

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

    expect(prismaStub.projectMember.findFirst).toHaveBeenCalledWith({
      where: { projectId: 11, userId: 1 },
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
        description: null,
        status: "in_progress",
        priority: "P0",
        assigneeId: 1,
        source: "manual",
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
        description: null,
        status: "not_started",
        priority: "P1",
        assigneeId: null,
        source: "manual",
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
        description: "",
        aiSummary: "",
        status: "in_progress",
        priority: "P0",
        assigneeId: 1,
        tags: ["前端", "联调"],
        customFields: { 工作量: 3 },
        startDate: "",
        dueDate: "",
        source: "manual",
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
      repo.update({ id: 1, priority: "P9" as never }),
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
  it("十一个 planItem 通道自注册（fields 两通道 + 附件三通道补齐）", () => {
    new PlanItemRepository();

    expect(ipcMain.handle).toHaveBeenCalledTimes(11);
    for (const channel of [
      "planItem:list",
      "planItem:listMine",
      "planItem:create",
      "planItem:update",
      "planItem:delete",
      "planItem:move",
      "planItem:fields:list",
      "planItem:fields:save",
      "planItem:attachments:list",
      "planItem:attachments:create",
      "planItem:attachments:delete",
    ]) {
      expect(ipcMain.handle).toHaveBeenCalledWith(
        channel,
        expect.any(Function),
      );
    }
  });
});

describe("PlanItemRepository.字段扩展（子系统 A）", () => {
  beforeEach(() => vi.clearAllMocks());

  it("create 透传 source/startDate/dueDate：ISO 字符串转 Date，缺省 source=manual", async () => {
    prismaStub.planItem.create.mockResolvedValue({ ...projectRow, id: 9 });
    await repo.create({
      createdById: 1,
      projectId: 11,
      title: "t",
      startDate: "2026-09-14T00:00:00.000Z",
      dueDate: "2026-09-20T00:00:00.000Z",
    });
    expect(prismaStub.planItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        source: "manual",
        startDate: new Date("2026-09-14T00:00:00.000Z"),
        dueDate: new Date("2026-09-20T00:00:00.000Z"),
      }),
    });
  });

  it("create 非法 source → 抛「无效的来源」", async () => {
    await expect(
      repo.create({
        createdById: 1,
        title: "t",
        source: "magic" as never,
      }),
    ).rejects.toThrow("无效的来源");
  });

  it("update 传 null 清空 startDate；合法 assigneeId（项目成员）通过", async () => {
    prismaStub.planItem.findUnique.mockResolvedValue(projectRow);
    prismaStub.projectMember.findFirst.mockResolvedValue({ id: 1 });
    await repo.update({ id: 1, startDate: null, assigneeId: 7 });
    expect(prismaStub.planItem.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { startDate: null, assigneeId: 7 },
    });
  });

  it("update 指派非项目成员 → 抛「处理人必须是项目成员」不落库", async () => {
    prismaStub.planItem.findUnique.mockResolvedValue(projectRow);
    prismaStub.projectMember.findFirst.mockResolvedValue(null);
    await expect(repo.update({ id: 1, assigneeId: 99 })).rejects.toThrow(
      "处理人必须是项目成员",
    );
    expect(prismaStub.planItem.update).not.toHaveBeenCalled();
  });

  it("update 传空串 startDate → 归一为 null 清空（弹窗回填空串 = 无日期）", async () => {
    prismaStub.planItem.findUnique.mockResolvedValue(projectRow);
    await repo.update({ id: 1, startDate: "" });
    expect(prismaStub.planItem.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { startDate: null },
    });
  });

  it("update 非法日期串 → 抛「无效的日期格式」不落库", async () => {
    prismaStub.planItem.findUnique.mockResolvedValue(projectRow);
    await expect(repo.update({ id: 1, startDate: "garbage" })).rejects.toThrow(
      "无效的日期格式",
    );
    expect(prismaStub.planItem.update).not.toHaveBeenCalled();
  });
});

describe("PlanItemRepository.description 透传", () => {
  beforeEach(() => vi.clearAllMocks());

  it("create 透传 description；缺省空串语义经 DB null 由 toRecord 归一", async () => {
    prismaStub.planItem.create.mockResolvedValue({ ...projectRow, id: 9 });
    await repo.create({
      createdById: 1,
      projectId: 11,
      title: "t",
      description: "# 计划",
    });
    expect(prismaStub.planItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ description: "# 计划" }),
    });
  });

  it("toRecord：DB null → 空串（list 断言）", async () => {
    prismaStub.planItem.findMany.mockResolvedValue([
      { ...projectRow, description: null },
    ]);
    const rows = await repo.list(11);
    expect(rows[0].description).toBe("");
  });

  it("update description null = 清空", async () => {
    prismaStub.planItem.findUnique.mockResolvedValue(projectRow);
    await repo.update({ id: 1, description: null });
    expect(prismaStub.planItem.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { description: null },
    });
  });
});

describe("PlanItemRepository.attachments 三通道", () => {
  const attRow = {
    id: 5,
    planItemId: 1,
    fileName: "a.pdf",
    assetPath: "attachments/a.pdf",
    createdAt: now,
  };

  beforeEach(() => vi.clearAllMocks());

  it("list 按 planItemId 查询并转 ISO", async () => {
    prismaStub.planItemAttachment.findMany.mockResolvedValue([attRow]);
    const rows = await repo.listAttachments(1);
    expect(prismaStub.planItemAttachment.findMany).toHaveBeenCalledWith({
      where: { planItemId: 1 },
      orderBy: { id: "asc" },
    });
    expect(rows[0]).toEqual({ ...attRow, createdAt: now.toISOString() });
  });

  it("create 建关联；delete 按 id 删", async () => {
    prismaStub.planItemAttachment.create.mockResolvedValue(attRow);
    const created = await repo.createAttachment(1, {
      fileName: "a.pdf",
      assetPath: "attachments/a.pdf",
    });
    expect(prismaStub.planItemAttachment.create).toHaveBeenCalledWith({
      data: {
        planItemId: 1,
        fileName: "a.pdf",
        assetPath: "attachments/a.pdf",
      },
    });
    expect(created.id).toBe(5);
    await repo.removeAttachment(5);
    expect(prismaStub.planItemAttachment.delete).toHaveBeenCalledWith({
      where: { id: 5 },
    });
  });

  it("remove 事项级联删附件关联（保留文件）", async () => {
    await repo.remove(1);
    expect(prismaStub.planItemAttachment.deleteMany).toHaveBeenCalledWith({
      where: { planItemId: 1 },
    });
    expect(
      prismaStub.planItemAttachment.deleteMany.mock.invocationCallOrder[0],
    ).toBeLessThan(prismaStub.planItem.delete.mock.invocationCallOrder[0]);
  });
});

describe("PlanItemRepository.aiSummary（v8，子系统 F）", () => {
  beforeEach(() => vi.clearAllMocks());

  it("toRecord：aiSummary null 容错归一空串", async () => {
    prismaStub.planItem.findMany.mockResolvedValue([
      { ...projectRow, aiSummary: "[2026-09-15] 完成" },
    ]);
    expect((await repo.list(11))[0].aiSummary).toBe("[2026-09-15] 完成");
    prismaStub.planItem.findMany.mockResolvedValue([
      { ...projectRow, aiSummary: null },
    ]);
    expect((await repo.list(11))[0].aiSummary).toBe("");
  });

  it("人路径负向：buildUpdateData/create 输出永不含 aiSummary 键", async () => {
    prismaStub.planItem.create.mockResolvedValue({ ...projectRow, id: 9 });
    await repo.create({ createdById: 1, projectId: 11, title: "t" } as never);
    const data = prismaStub.planItem.create.mock.calls[0][0].data;
    expect("aiSummary" in data).toBe(false);
    prismaStub.planItem.findUnique.mockResolvedValue(projectRow);
    await repo.update({ id: 1, title: "x", aiSummary: "hack" } as never);
    expect(
      "aiSummary" in prismaStub.planItem.update.mock.calls[0][0].data,
    ).toBe(false);
  });
});

describe("PlanItemRepository.appendAiSummary（工具专用通道，v8）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T10:30:00"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("已有摘要 → 换行追加带日期前缀的新行并回写，返回拼接结果（只增不改）", async () => {
    prismaStub.planItem.findUnique.mockResolvedValue({
      ...projectRow,
      aiSummary: "[2026-09-14] 启动",
    });
    const next = await repo.appendAiSummary(1, "完成联调");
    expect(next).toBe("[2026-09-14] 启动\n[2026-09-15] 完成联调");
    expect(prismaStub.planItem.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { aiSummary: "[2026-09-14] 启动\n[2026-09-15] 完成联调" },
    });
  });

  it("摘要为 null → 无前导换行直接落首行；id 不存在 → 返回 null 不写库", async () => {
    prismaStub.planItem.findUnique.mockResolvedValueOnce({
      ...projectRow,
      aiSummary: null,
    });
    const next = await repo.appendAiSummary(1, "开始");
    expect(next).toBe("[2026-09-15] 开始");
    expect(prismaStub.planItem.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { aiSummary: "[2026-09-15] 开始" },
    });
    prismaStub.planItem.findUnique.mockResolvedValueOnce(null);
    expect(await repo.appendAiSummary(99, "x")).toBeNull();
    expect(prismaStub.planItem.update).toHaveBeenCalledTimes(1);
  });
});

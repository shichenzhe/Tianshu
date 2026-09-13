// tests/project/plan-view-repo.test.ts
/** 计划视图仓储单测（子系统 A spec §主进程）：懒播种（空列表事务插两条默认视图，
 * name 空串）、list 排序、create 重名自动 (n) 后缀、update 局部键、
 * 最后一个视图拒删（PLAN_VIEW_LAST_ONE）、reorder 批量、
 * 读取时畸形 filterJson 降级 "{}"；5 通道自注册 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

const prismaStub = vi.hoisted(() => ({
  planView: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
  },
  $transaction: vi.fn(),
}));
vi.mock("../../electron/commons/prisma-client", () => ({
  default: prismaStub,
}));

import PlanViewRepository from "../../electron/domains/project/plan-view.repo";
import { PLAN_VIEW_LAST_ONE } from "../../electron/domains/project/plan-view.entity";
import { ipcMain } from "electron";

const repo = new PlanViewRepository();
const now = new Date("2026-09-14T00:00:00Z");
const row = (over: Record<string, unknown> = {}) => ({
  id: 1,
  projectId: 11,
  name: "",
  type: "table",
  groupBy: null,
  filterJson: "{}",
  sortJson: "[]",
  sortOrder: 0,
  createdAt: now,
  updatedAt: now,
  ...over,
});

describe("PlanViewRepository.list 懒播种", () => {
  beforeEach(() => vi.clearAllMocks());

  it("空列表 → $transaction 数组式 create×2 播种表格/看板两条（name 空串）再返回", async () => {
    prismaStub.planView.findMany
      .mockResolvedValueOnce([]) // 播种前
      .mockResolvedValueOnce([
        row(),
        row({ id: 2, type: "kanban", sortOrder: 1 }),
      ]); // 播种后重查
    const views = await repo.list(11);
    expect(prismaStub.$transaction).toHaveBeenCalledTimes(1);
    expect(
      Array.isArray(
        (prismaStub.$transaction as ReturnType<typeof vi.fn>).mock.calls[0][0],
      ),
    ).toBe(true);
    expect(prismaStub.planView.create).toHaveBeenCalledTimes(2);
    expect(prismaStub.planView.create).toHaveBeenNthCalledWith(1, {
      data: { projectId: 11, name: "", type: "table", sortOrder: 0 },
    });
    expect(prismaStub.planView.create).toHaveBeenNthCalledWith(2, {
      data: { projectId: 11, name: "", type: "kanban", sortOrder: 1 },
    });
    expect(views).toHaveLength(2);
    expect(views[1].type).toBe("kanban");
  });

  it("非空列表不播种；畸形 filterJson 降级为 {}", async () => {
    prismaStub.planView.findMany.mockResolvedValue([
      row({ filterJson: "not-json{" }),
    ]);
    const views = await repo.list(11);
    expect(prismaStub.$transaction).not.toHaveBeenCalled();
    expect(views[0].filterJson).toBe("{}");
  });
});

describe("PlanViewRepository.create 重名后缀", () => {
  beforeEach(() => vi.clearAllMocks());

  it("同名存在 → 自动加 (n) 后缀找到第一个可用名", async () => {
    prismaStub.planView.findFirst
      .mockResolvedValueOnce(row({ name: "我的看板" }))
      .mockResolvedValueOnce(row({ name: "我的看板(2)" }))
      .mockResolvedValueOnce(null);
    prismaStub.planView.findMany.mockResolvedValue([]);
    prismaStub.planView.create.mockResolvedValue(row({ name: "我的看板(3)" }));
    const created = await repo.create({
      projectId: 11,
      name: "我的看板",
      type: "kanban",
    });
    expect(prismaStub.planView.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: "我的看板(3)", type: "kanban" }),
    });
    expect(created.name).toBe("我的看板(3)");
  });
});

describe("PlanViewRepository.remove 最后视图保护", () => {
  beforeEach(() => vi.clearAllMocks());

  it("项目仅剩一条 → 抛 PLAN_VIEW_LAST_ONE 不删除", async () => {
    prismaStub.planView.findUnique.mockResolvedValue(row());
    prismaStub.planView.count.mockResolvedValue(1);
    await expect(repo.remove(1)).rejects.toThrow(PLAN_VIEW_LAST_ONE);
    expect(prismaStub.planView.delete).not.toHaveBeenCalled();
  });

  it("多于一条 → 正常删除", async () => {
    prismaStub.planView.findUnique.mockResolvedValue(row());
    prismaStub.planView.count.mockResolvedValue(3);
    await repo.remove(1);
    expect(prismaStub.planView.delete).toHaveBeenCalledWith({
      where: { id: 1 },
    });
  });
});

describe("PlanViewRepository.update/reorder", () => {
  beforeEach(() => vi.clearAllMocks());

  it("update 局部键：仅 name/type/groupBy/filterJson 传入者写入", async () => {
    prismaStub.planView.findUnique.mockResolvedValue(row());
    await repo.update({ id: 1, name: "高优", groupBy: "priority" });
    expect(prismaStub.planView.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { name: "高优", groupBy: "priority" },
    });
  });

  it("reorder 按 [{id, sortOrder}] 逐条更新", async () => {
    prismaStub.planView.update.mockResolvedValue(row());
    await repo.reorder([
      { id: 2, sortOrder: 0 },
      { id: 1, sortOrder: 1 },
    ]);
    expect(prismaStub.planView.update).toHaveBeenCalledTimes(2);
  });

  it("update 不存在的视图 → 抛「视图不存在」", async () => {
    prismaStub.planView.findUnique.mockResolvedValue(null);
    await expect(repo.update({ id: 99, name: "x" })).rejects.toThrow(
      "视图不存在",
    );
  });

  it("update 非法 type → 抛「无效的视图类型」不落库", async () => {
    prismaStub.planView.findUnique.mockResolvedValue(row());
    await expect(
      repo.update({ id: 1, type: "bogus" as never }),
    ).rejects.toThrow("无效的视图类型");
    expect(prismaStub.planView.update).not.toHaveBeenCalled();
  });
});

describe("planView 通道自注册", () => {
  it("注册 5 通道", () => {
    // 前序 describe 的 clearAllMocks 已清掉导入期的注册记录，重建实例再断言
    new PlanViewRepository();
    const channels = (
      ipcMain.handle as ReturnType<typeof vi.fn>
    ).mock.calls.map((call) => call[0]);
    expect(channels).toEqual(
      expect.arrayContaining([
        "planView:list",
        "planView:create",
        "planView:update",
        "planView:delete",
        "planView:reorder",
      ]),
    );
  });
});

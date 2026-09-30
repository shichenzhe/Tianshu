/**
 * v5 任务管理扩展单测：listAll 过滤归档、pin/archive 落库参数、
 * searchByTitle 的 LIKE/排序/take 语义、toSession 的新字段序列化。
 * 依赖经 vi.mock 替换（electron ipcMain / prisma client），沿用
 * permissions-integration.test.ts 的 mock 模式。
 * 项目模块一期（Task 3）起，AI 侧查询均隐含 projectId: null（会话隔离）；
 * v12 多用户隔离起，查询/校验均携带 userId（token 解出，不信任前端）。
 * 会话统一一期起：listAllSessions 返回项目会话（D4）、createSession
 * 支持 projectId/planItemId（D1：任务会话查重复用 + workspace 强制挂资产空间）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaStub = vi.hoisted(() => ({
  workspace: {
    count: vi.fn(async () => 1),
    findFirst: vi.fn(async () => ({})),
  },
  session: {
    findMany: vi.fn(),
    findFirst: vi.fn(async () => ({})),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  message: { findMany: vi.fn(), deleteMany: vi.fn() },
  automationRun: { updateMany: vi.fn() },
  // $transaction 数组形态：顺序执行（deleteSession 原子清理用）
  $transaction: vi.fn(async (ops: Array<Promise<unknown>>) => {
    for (const op of ops) {
      await op;
    }
  }),
}));

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  shell: { openPath: vi.fn() },
}));
// session.repo 引 commons/Log（Winston，模块加载即建 transport）——mock 掉避免测试写日志
vi.mock("../../electron/commons/Log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../electron/commons/prisma-client", () => ({
  default: prismaStub,
}));

import { SessionRepository } from "../../electron/domains/ai/chat/session.repo";
import type { SessionRow } from "../../electron/domains/ai/chat/session.repo";

/** 测试用户 id（v12 起所有查询/归属校验维度） */
const UID = 3;

function makeRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 1,
    workspaceId: 2,
    assistantId: null,
    currentModelId: null,
    title: "任务A",
    mode: null,
    pinnedAt: null,
    archivedAt: null,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-04T00:00:00Z"),
    lastMessageAt: null,
    ...overrides,
  } as SessionRow;
}

describe("SessionRepository v5 扩展", () => {
  let repo: SessionRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    prismaStub.workspace.count.mockResolvedValue(1);
    prismaStub.workspace.findFirst.mockResolvedValue({ id: 2, userId: UID });
    prismaStub.session.findFirst.mockResolvedValue({ id: 1, userId: UID });
    repo = new SessionRepository();
  });

  it("listAllSessions 只查未归档并按 lastMessageAt 倒序（一期起含项目会话）", async () => {
    prismaStub.session.findMany.mockResolvedValue([
      makeRow({ pinnedAt: new Date("2026-09-03T00:00:00Z") }),
      makeRow({ id: 2, projectId: 11, planItemId: 55, title: "任务会话" }),
    ]);
    const rows = await repo.listAllSessions(UID);
    expect(prismaStub.session.findMany).toHaveBeenCalledWith({
      where: { archivedAt: null, userId: UID },
      orderBy: { lastMessageAt: "desc" },
    });
    expect(rows[0].pinnedAt).toBe("2026-09-03T00:00:00.000Z");
    expect(rows[0].archivedAt).toBeUndefined();
    // 项目/任务会话不再被过滤，归属列随 toSession 透出（侧边栏项目分组数据源）
    expect(rows[1].projectId).toBe(11);
    expect(rows[1].planItemId).toBe(55);
  });

  it("pinSession(true) 写当前时间、pinSession(false) 写 null", async () => {
    await repo.pinSession(1, true, UID);
    const data = prismaStub.session.update.mock.calls[0][0].data;
    expect(data.pinnedAt).toBeInstanceOf(Date);
    await repo.pinSession(1, false, UID);
    expect(prismaStub.session.update.mock.calls[1][0].data).toEqual({
      pinnedAt: null,
    });
  });

  it("archiveSession 同理切换 archivedAt", async () => {
    await repo.archiveSession(1, true, UID);
    expect(
      prismaStub.session.update.mock.calls[0][0].data.archivedAt,
    ).toBeInstanceOf(Date);
    await repo.archiveSession(1, false, UID);
    expect(prismaStub.session.update.mock.calls[1][0].data).toEqual({
      archivedAt: null,
    });
  });

  it("searchSessionsByTitle 关键词模式：LIKE + 未归档 + 倒序 + take 20（一期起含项目会话）", async () => {
    prismaStub.session.findMany.mockResolvedValue([]);
    await repo.searchSessionsByTitle("金价", UID);
    expect(prismaStub.session.findMany).toHaveBeenCalledWith({
      where: {
        title: { contains: "金价" },
        archivedAt: null,
        userId: UID,
      },
      orderBy: { updatedAt: "desc" },
      take: 20,
    });
  });

  it("searchSessionsByTitle 空关键词：最近任务模式（含项目会话）", async () => {
    prismaStub.session.findMany.mockResolvedValue([]);
    await repo.searchSessionsByTitle("", UID);
    expect(prismaStub.session.findMany).toHaveBeenCalledWith({
      where: { archivedAt: null, userId: UID },
      orderBy: { updatedAt: "desc" },
      take: 20,
    });
  });

  it("listSessions 补过滤 archivedAt: null", async () => {
    prismaStub.session.findMany.mockResolvedValue([]);
    await repo.listSessions(2, UID);
    expect(prismaStub.session.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 2, archivedAt: null, projectId: null },
      orderBy: { lastMessageAt: "desc" },
    });
  });

  it("deleteSession 事务内先置空 automationRun.sessionId 再删消息与会话（孤儿 run 不残留死链）", async () => {
    await repo.deleteSession(7, UID);
    // 三操作经同一事务数组提交（先 run 置空、再消息、后会话）
    expect(prismaStub.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaStub.automationRun.updateMany).toHaveBeenCalledWith({
      where: { sessionId: 7 },
      data: { sessionId: null },
    });
    expect(prismaStub.message.deleteMany).toHaveBeenCalledWith({
      where: { sessionId: 7 },
    });
    expect(prismaStub.session.delete).toHaveBeenCalledWith({
      where: { id: 7 },
    });
  });

  it("createSession 带 planItemId：已有会话绑定该事项 → 直接复用不新建不报错", async () => {
    const existing = makeRow({ id: 9, projectId: 11, planItemId: 55 });
    // mockReset 兜底清残留 once 队列，单测内自建实现保持封闭
    prismaStub.session.findFirst.mockReset().mockResolvedValue(existing);

    const created = await repo.createSession(
      { workspaceId: 2, projectId: 11, planItemId: 55 },
      UID,
    );

    expect(prismaStub.session.findFirst).toHaveBeenCalledWith({
      where: { planItemId: 55, userId: UID },
    });
    expect(prismaStub.session.create).not.toHaveBeenCalled();
    expect(created.id).toBe(9);
  });

  it("createSession 带 projectId：workspaceId 强制取项目资产空间（防前端传错）", async () => {
    // 前端误传 workspaceId=2；资产空间实际为 30（两次查询：资产空间解析 + 归属校验）
    prismaStub.workspace.findFirst
      .mockReset()
      .mockResolvedValueOnce({ id: 30, projectId: 11, userId: UID })
      .mockResolvedValueOnce({ id: 30, userId: UID });
    // planItemId 查重未命中（走新建）+ 模型继承查不到
    prismaStub.session.findFirst.mockReset().mockResolvedValue(null);
    prismaStub.session.create
      .mockReset()
      .mockResolvedValue(makeRow({ id: 12, projectId: 11, planItemId: 55 }));

    const created = await repo.createSession(
      { workspaceId: 2, projectId: 11, planItemId: 55 },
      UID,
    );

    expect(prismaStub.workspace.findFirst).toHaveBeenNthCalledWith(1, {
      where: { projectId: 11, userId: UID },
    });
    expect(prismaStub.workspace.findFirst).toHaveBeenNthCalledWith(2, {
      where: { id: 30, userId: UID },
    });
    expect(prismaStub.session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          workspaceId: 30,
          projectId: 11,
          planItemId: 55,
          assistantId: undefined,
          scenario: null,
          currentModelId: undefined,
          title: "新会话",
          userId: UID,
        },
      }),
    );
    expect(created.projectId).toBe(11);
  });

  it("createSession 项目无资产空间 → 抛 PROJECT_NOT_FOUND 不落库", async () => {
    prismaStub.workspace.findFirst.mockReset().mockResolvedValueOnce(null);
    await expect(
      repo.createSession({ workspaceId: 2, projectId: 99 }, UID),
    ).rejects.toThrow("PROJECT_NOT_FOUND");
    expect(prismaStub.session.create).not.toHaveBeenCalled();
  });

  it("createSession 带 title → 落库为传入标题（推进入口传任务标题；缺省「新会话」不变）", async () => {
    prismaStub.session.findFirst.mockReset().mockResolvedValue(null);
    prismaStub.session.create
      .mockReset()
      .mockResolvedValue(makeRow({ id: 13 }));
    await repo.createSession({ workspaceId: 2, title: "调研竞品" }, UID);
    expect(prismaStub.session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ title: "调研竞品" }),
      }),
    );
  });

  it("createSession 仅 projectId 不传 workspaceId → 资产空间解析后建会话", async () => {
    // 两次 workspace 查询：资产空间解析（projectId 命中）+ 归属校验
    prismaStub.workspace.findFirst
      .mockReset()
      .mockResolvedValueOnce({ id: 30, projectId: 11, userId: UID })
      .mockResolvedValueOnce({ id: 30, userId: UID });
    prismaStub.session.findFirst.mockReset().mockResolvedValue(null);
    prismaStub.session.create
      .mockReset()
      .mockResolvedValue(makeRow({ id: 14, projectId: 11, planItemId: 55 }));

    const created = await repo.createSession(
      { projectId: 11, planItemId: 55, title: "调研竞品" },
      UID,
    );

    expect(prismaStub.workspace.findFirst).toHaveBeenNthCalledWith(1, {
      where: { projectId: 11, userId: UID },
    });
    expect(prismaStub.session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: 30,
          projectId: 11,
          planItemId: 55,
          title: "调研竞品",
        }),
      }),
    );
    expect(created.projectId).toBe(11);
  });

  it("createSession projectId 与 workspaceId 皆空 → 抛 WORKSPACE_NOT_FOUND 不落库", async () => {
    await expect(repo.createSession({}, UID)).rejects.toThrow(
      "WORKSPACE_NOT_FOUND",
    );
    expect(prismaStub.session.create).not.toHaveBeenCalled();
  });
});

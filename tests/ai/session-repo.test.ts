/**
 * v5 任务管理扩展单测：listAll 过滤归档、pin/archive 落库参数、
 * searchByTitle 的 LIKE/排序/take 语义、toSession 的新字段序列化。
 * 依赖经 vi.mock 替换（electron ipcMain / prisma client），沿用
 * permissions-integration.test.ts 的 mock 模式。
 * 项目模块一期（Task 3）起，AI 侧查询均隐含 projectId: null（会话隔离）；
 * v12 多用户隔离起，查询/校验均携带 userId（token 解出，不信任前端）。
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

  it("listAllSessions 只查未归档并按 lastMessageAt 倒序", async () => {
    prismaStub.session.findMany.mockResolvedValue([
      makeRow({ pinnedAt: new Date("2026-09-03T00:00:00Z") }),
    ]);
    const rows = await repo.listAllSessions(UID);
    expect(prismaStub.session.findMany).toHaveBeenCalledWith({
      where: { archivedAt: null, projectId: null, userId: UID },
      orderBy: { lastMessageAt: "desc" },
    });
    expect(rows[0].pinnedAt).toBe("2026-09-03T00:00:00.000Z");
    expect(rows[0].archivedAt).toBeUndefined();
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

  it("searchSessionsByTitle 关键词模式：LIKE + 未归档 + 倒序 + take 20", async () => {
    prismaStub.session.findMany.mockResolvedValue([]);
    await repo.searchSessionsByTitle("金价", UID);
    expect(prismaStub.session.findMany).toHaveBeenCalledWith({
      where: {
        title: { contains: "金价" },
        archivedAt: null,
        projectId: null,
        userId: UID,
      },
      orderBy: { updatedAt: "desc" },
      take: 20,
    });
  });

  it("searchSessionsByTitle 空关键词：最近任务模式", async () => {
    prismaStub.session.findMany.mockResolvedValue([]);
    await repo.searchSessionsByTitle("", UID);
    expect(prismaStub.session.findMany).toHaveBeenCalledWith({
      where: { archivedAt: null, projectId: null, userId: UID },
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
});

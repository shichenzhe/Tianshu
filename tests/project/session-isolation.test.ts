/**
 * 会话隔离单测（项目模块）：项目会话（session.projectId 非空）不得
 * 进入 AI 任务树（listSessions/listAllSessions）、标题搜索与全局消息
 * 搜索——AI 侧会话查询全部隐含 projectId: null，前端行为不变。
 * 二期（spec §3.2）：项目资产空间（workspace.projectId 非空）同样
 * 不进 AI 侧边栏空间分组树（listWorkspaces 过滤 projectId: null）。
 * v12 多用户隔离：全部查询携带 userId（token 解出，不信任前端）。
 * 依赖经 vi.mock 替换（electron ipcMain / Log / prisma client），
 * 沿用 session-repo.test.ts 的 mock 模式。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
// session.repo 引 commons/Log（Winston，模块加载即建 transport）——mock 掉避免测试写日志
vi.mock("../../electron/commons/Log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** 测试用户 id（v12 起所有查询/归属校验维度） */
const UID = 3;

const { prismaStub, sessionFindMany, messageFindMany, workspaceFindMany } =
  vi.hoisted(() => {
    const sessionFindMany = vi.fn().mockResolvedValue([]);
    const messageFindMany = vi.fn().mockResolvedValue([]);
    const workspaceFindMany = vi.fn().mockResolvedValue([]);
    const prismaStub = {
      session: {
        findMany: sessionFindMany,
        findFirst: vi.fn().mockResolvedValue({ id: 1, userId: 3 }),
      },
      message: { findMany: messageFindMany },
      // listWorkspaces 空 count 时补建默认空间（返回非 0 跳过）
      workspace: {
        count: vi.fn().mockResolvedValue(1),
        findMany: workspaceFindMany,
        findFirst: vi.fn().mockResolvedValue({ id: 1, userId: 3 }),
      },
    };
    return { prismaStub, sessionFindMany, messageFindMany, workspaceFindMany };
  });

vi.mock("../../electron/commons/prisma-client", () => ({
  default: prismaStub,
}));

// session.repo 为命名导出（无 default），同 tests/ai/session-repo.test.ts
import { SessionRepository } from "../../electron/domains/ai/chat/session.repo";
const repo = new SessionRepository();

describe("会话隔离（项目会话不进 AI 任务树/搜索）", () => {
  it("listAllSessions 查询含 projectId: null", async () => {
    await repo.listAllSessions(UID);
    expect(sessionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: null }),
      }),
    );
  });

  it("listSessions 查询含 projectId: null", async () => {
    await repo.listSessions(1, UID);
    expect(sessionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: null }),
      }),
    );
  });

  it("searchSessionsByTitle 查询含 projectId: null", async () => {
    await repo.searchSessionsByTitle("kw", UID);
    expect(sessionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: null }),
      }),
    );
  });

  it("searchMessages 先查非项目会话 id 集再限定消息范围", async () => {
    sessionFindMany.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);
    await repo.searchMessages("kw", UID);
    expect(sessionFindMany).toHaveBeenCalledWith({
      where: { projectId: null, userId: UID },
      select: { id: true },
    });
    expect(messageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ sessionId: { in: [1, 2] } }),
      }),
    );
  });

  it("listWorkspaces 查询含 projectId: null（资产空间不进侧边栏分组树）", async () => {
    await repo.listWorkspaces(UID);
    expect(workspaceFindMany).toHaveBeenCalledWith({
      where: { projectId: null, userId: UID },
      orderBy: { createdAt: "asc" },
    });
  });
});

/**
 * 会话变更总线埋点单测（2026-11-06 修复：移动端经 server-face 远程建会话
 * 后桌面侧栏树不实时刷新——本地路径靠渲染层写后主动 invalidate，远程写
 * 落库后无任何信号）。断言 session.repo 结构性写面（建/删/归档/置顶/改名）
 * 成功后 emitSessionChanged 恰好一次；读面（listSessions）不得扇出。
 * 依赖经 vi.mock 替换（electron / prisma client / granted-paths），沿用
 * plan-item-repo.test.ts 模式；bus 本身 vi.mock 为 spy（扇出结构为
 * workspace-change-bus 同构照抄，不在此重复覆盖）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/tmp",
    getAppPath: () => "/tmp",
    isPackaged: false,
  },
  ipcMain: { handle: vi.fn() },
  dialog: {},
  shell: {},
  BrowserWindow: { getAllWindows: () => [] },
}));

const { emitSessionChanged } = vi.hoisted(() => ({
  emitSessionChanged: vi.fn(),
}));
vi.mock("../../electron/domains/ai/chat/session-change-bus", () => ({
  emitSessionChanged,
  onSessionChanged: vi.fn(),
}));

vi.mock("../../electron/domains/ai/file-window/granted-paths", () => ({
  revokeSession: vi.fn().mockResolvedValue(undefined),
}));

const prismaStub = vi.hoisted(() => ({
  workspace: {
    findFirst: vi.fn().mockResolvedValue({ id: 2, userId: 1 }),
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(1),
  },
  session: {
    findFirst: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    update: vi.fn().mockResolvedValue({}),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  },
  message: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
  automationRun: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
  $transaction: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../electron/commons/prisma-client", () => ({
  default: prismaStub,
}));

import { SessionRepository } from "../../electron/domains/ai/chat/session.repo";

const sessionRow = {
  id: 10,
  workspaceId: 2,
  projectId: null,
  planItemId: null,
  assistantId: null,
  scenario: null,
  currentModelId: null,
  title: "新会话",
  pinnedAt: null,
  archivedAt: null,
  createdAt: new Date("2026-11-06T10:00:00Z"),
  updatedAt: new Date("2026-11-06T10:00:00Z"),
  lastMessageAt: new Date("2026-11-06T10:00:00Z"),
  userId: 1,
};

describe("session.repo 结构性写面 → emitSessionChanged 埋点", () => {
  let repo: SessionRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    // 归属校验放行：会话/空间皆本人（findFirst 同时服务模型继承查询，无妨）
    prismaStub.session.findFirst.mockResolvedValue({
      id: 9,
      workspaceId: 2,
      userId: 1,
      archivedAt: null,
      currentModelId: null,
    });
    prismaStub.session.create.mockResolvedValue(sessionRow);
    repo = new SessionRepository();
  });

  it("createSession 成功后恰好扇出一次", async () => {
    await repo.createSession({ workspaceId: 2, title: "远端新建" }, 1);
    expect(emitSessionChanged).toHaveBeenCalledTimes(1);
  });

  it("renameSession / pinSession / archiveSession 成功后各扇出一次", async () => {
    await repo.renameSession(9, "改名", 1);
    await repo.pinSession(9, true, 1);
    await repo.archiveSession(9, true, 1);
    expect(emitSessionChanged).toHaveBeenCalledTimes(3);
  });

  it("deleteSession 成功后恰好扇出一次", async () => {
    await repo.deleteSession(9, 1);
    expect(emitSessionChanged).toHaveBeenCalledTimes(1);
  });

  it("读面（listSessions）不扇出", async () => {
    await repo.listSessions(2, 1);
    expect(emitSessionChanged).not.toHaveBeenCalled();
  });
});

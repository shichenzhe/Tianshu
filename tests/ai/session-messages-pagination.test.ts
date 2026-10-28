/**
 * H6 性能回归：message:listBySession 游标分页——旧实现整会话全量读回
 * （长会话含大 blocks 是几十 MB 级 IPC 结构化克隆），改为 id 倒序取
 * limit+1 判 hasMore、翻转回时间正序（见性能审查报告 H6）
 * mock 骨架同 tests/ai/chat.service.test.ts：prisma-client 模块级替换
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: {
    getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`),
    getAppPath: vi.fn(() => `/tmp/tianshu-test-app-${process.pid}`),
    isPackaged: false,
  },
}));

type FindManyArgs = {
  where?: { sessionId?: number; id?: { lt?: number } };
  orderBy?: Record<string, string>;
  take?: number;
};

// 内存行库模拟分页语义（orderBy id desc + cursor lt + take）
const db = {
  sessions: [{ id: 1, userId: 1 }],
  messages: [] as Array<{
    id: number;
    sessionId: number;
    role: string;
    blocks: string;
    error: string | null;
    createdAt: Date;
  }>,
};
const messageFindMany = vi.fn(async (args?: FindManyArgs) => {
  const where = args?.where ?? {};
  const rows = db.messages
    .filter(
      (row) =>
        where.sessionId === undefined || row.sessionId === where.sessionId,
    )
    .filter((row) => where.id?.lt === undefined || row.id < where.id.lt)
    .sort((a, b) => (args?.orderBy?.id === "desc" ? b.id - a.id : a.id - b.id));
  return args?.take ? rows.slice(0, args.take) : rows;
});
const sessionFindFirst = vi.fn(
  async ({ where }: { where: { id: number; userId: number } }) =>
    db.sessions.find((s) => s.id === where.id && s.userId === where.userId) ??
    null,
);

vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    session: {
      findFirst: (args?: unknown) => sessionFindFirst(args),
    },
    message: {
      findMany: (args?: FindManyArgs) => messageFindMany(args),
    },
  },
}));

import { SessionRepository } from "../../electron/domains/ai/chat/session.repo";

const seed = (count: number) => {
  db.messages = Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    sessionId: 1,
    role: i % 2 === 0 ? "user" : "assistant",
    blocks: "[]",
    error: null,
    createdAt: new Date(2026, 8, 1, 0, 0, i),
  }));
};

beforeEach(() => {
  messageFindMany.mockClear();
  db.sessions = [{ id: 1, userId: 1 }];
});

describe("listMessages 游标分页（H6）", () => {
  it("默认取最近 100 条：desc + take 101 判 hasMore，返回时间正序", async () => {
    seed(150);
    const repo = new SessionRepository();
    const page = await repo.listMessages(1, 1);
    const args = messageFindMany.mock.calls[0]?.[0];
    expect(args?.orderBy).toEqual({ id: "desc" });
    expect(args?.take).toBe(101);
    expect(page.items).toHaveLength(100);
    // 最新的第 51..150 条，正序排列
    expect(page.items[0]?.id).toBe(51);
    expect(page.items.at(-1)?.id).toBe(150);
    expect(page.hasMore).toBe(true);
    expect(page.nextBeforeId).toBe(51);
  });

  it("beforeId 游标向上翻页：where id lt 透传", async () => {
    seed(150);
    const repo = new SessionRepository();
    const page = await repo.listMessages(1, 1, { beforeId: 51 });
    const args = messageFindMany.mock.calls[0]?.[0];
    expect(args?.where).toMatchObject({ sessionId: 1, id: { lt: 51 } });
    expect(page.items.at(-1)?.id).toBe(50);
  });

  it("尾页不足整页：hasMore false 与 nextBeforeId null", async () => {
    seed(150);
    const repo = new SessionRepository();
    const page = await repo.listMessages(1, 1, { beforeId: 51 });
    expect(page.items).toHaveLength(50);
    expect(page.hasMore).toBe(false);
    expect(page.nextBeforeId).toBeNull();
  });

  it("非本人会话仍然拒绝（归属校验回归）", async () => {
    db.sessions = [];
    const repo = new SessionRepository();
    await expect(repo.listMessages(1, 9)).rejects.toThrow();
  });
});

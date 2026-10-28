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
import { ipcMain as ipcMainMock } from "electron";
import { generateUserToken } from "../../electron/commons/ipc-user";

const prismaStub = vi.hoisted(() => ({
  workspace: {
    count: vi.fn(async () => 1),
    findFirst: vi.fn(async () => ({})),
    // getEffectiveModelId 三级解析（P1 双空兜底）用
    findUnique: vi.fn(),
  },
  session: {
    findMany: vi.fn(),
    findFirst: vi.fn(async () => ({})),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    // P1 未读角标批：markSessionRead 单调条件写
    updateMany: vi.fn(),
    delete: vi.fn(),
    // face 全表扫描优化批：querySessions 非 keyword 路径 count 总条数
    count: vi.fn(),
  },
  provider: { findMany: vi.fn() },
  model: { findFirst: vi.fn() },
  message: {
    findMany: vi.fn(),
    deleteMany: vi.fn(),
    // P1 未读角标批：末条 id 聚合/未读分组计数/归属校验
    groupBy: vi.fn(),
    count: vi.fn(),
    findFirst: vi.fn(),
  },
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

  it("listAllSessions 含归档（已归档分组数据源）并按置顶/lastMessageAt 倒序（LA 批起 pinnedAt 优先；一期起含项目会话）", async () => {
    prismaStub.session.findMany.mockResolvedValue([
      makeRow({ pinnedAt: new Date("2026-09-03T00:00:00Z") }),
      makeRow({ id: 2, projectId: 11, planItemId: 55, title: "任务会话" }),
      makeRow({ id: 3, archivedAt: new Date("2026-09-04T00:00:00Z") }),
    ]);
    const rows = await repo.listAllSessions(UID);
    expect(prismaStub.session.findMany).toHaveBeenCalledWith({
      where: { userId: UID },
      orderBy: [
        { pinnedAt: "desc" },
        { lastMessageAt: "desc" },
        { id: "desc" },
      ],
    });
    expect(rows[0].pinnedAt).toBe("2026-09-03T00:00:00.000Z");
    // 归档行透传 archivedAt（前端 splitArchived 拆「已归档」分组）
    expect(rows[2].archivedAt).toBe("2026-09-04T00:00:00.000Z");
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

describe("SessionRepository getEffectiveModelId（三级解析 + P1 双空兜底）", () => {
  let repo: SessionRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = new SessionRepository();
    prismaStub.session.findUnique.mockResolvedValue(makeRow({ userId: UID }));
    prismaStub.workspace.findUnique.mockResolvedValue({
      id: 2,
      defaultModelId: null,
    });
  });

  it("会话 currentModelId 优先（不查 workspace/provider）", async () => {
    prismaStub.session.findUnique.mockResolvedValue(
      makeRow({ currentModelId: 7, userId: UID }),
    );
    await expect(repo.getEffectiveModelId(1)).resolves.toBe(7);
    expect(prismaStub.workspace.findUnique).not.toHaveBeenCalled();
  });

  it("次选 workspace.defaultModelId（不进兜底查询）", async () => {
    prismaStub.workspace.findUnique.mockResolvedValue({
      id: 2,
      defaultModelId: 9,
    });
    await expect(repo.getEffectiveModelId(1)).resolves.toBe(9);
    expect(prismaStub.provider.findMany).not.toHaveBeenCalled();
  });

  it("双空兜底：provider 启用集两步查，取首个启用 llm 模型（userId 隔离）", async () => {
    prismaStub.provider.findMany.mockResolvedValue([{ id: 21 }, { id: 22 }]);
    prismaStub.model.findFirst.mockResolvedValue({ id: 31 });
    await expect(repo.getEffectiveModelId(1)).resolves.toBe(31);
    expect(prismaStub.provider.findMany).toHaveBeenCalledWith({
      where: { enabled: true, userId: UID },
      select: { id: true },
    });
    expect(prismaStub.model.findFirst).toHaveBeenCalledWith({
      where: { type: "llm", enabled: true, providerId: { in: [21, 22] } },
      orderBy: { id: "asc" },
      select: { id: true },
    });
  });

  it("全无可用模型（无启用 provider）→ null（上层维持 NO_MODEL）", async () => {
    prismaStub.provider.findMany.mockResolvedValue([]);
    await expect(repo.getEffectiveModelId(1)).resolves.toBeNull();
    expect(prismaStub.model.findFirst).not.toHaveBeenCalled();
  });

  it("会话不存在 → null", async () => {
    prismaStub.session.findUnique.mockResolvedValue(null);
    await expect(repo.getEffectiveModelId(1)).resolves.toBeNull();
  });
});

describe("SessionRepository getById（T22 文件窗按 id 拉取）", () => {
  let repo: SessionRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    prismaStub.workspace.count.mockResolvedValue(1);
    repo = new SessionRepository();
  });

  it("归属校验（findFirst 带 userId）命中 → toSession 序列化返回", async () => {
    prismaStub.session.findFirst.mockResolvedValue(makeRow({ id: 5 }));
    const session = await repo.getSessionById(5, UID);
    expect(prismaStub.session.findFirst).toHaveBeenCalledWith({
      where: { id: 5, userId: UID },
    });
    expect(session.id).toBe(5);
    // toSession：createdAt Date → ISO 串；mode null → 缺省 agent
    expect(session.createdAt).toBe("2026-09-01T00:00:00.000Z");
    expect(session.mode).toBe("agent");
  });

  it("查无（他人会话/已删）→ 抛 SESSION_NOT_FOUND（不泄露存在性）", async () => {
    prismaStub.session.findFirst.mockResolvedValue(null);
    await expect(repo.getSessionById(5, UID)).rejects.toThrow(
      "SESSION_NOT_FOUND",
    );
  });

  it("IPC 注册：session:getById 经 handleUser 注册到 ipcMain", async () => {
    const ipcMain = (await import("electron")).ipcMain as unknown as {
      handle: ReturnType<typeof vi.fn>;
    };
    // 注册发生在构造期（beforeEach 在 new 之前已 clear）——channel 存在即可
    expect(
      vi
        .mocked(ipcMain.handle)
        .mock.calls.some(([ch]) => ch === "session:getById"),
    ).toBe(true);
  });
});

describe("SessionRepository P1 未读角标批（enriched 列表 + read 游标）", () => {
  let repo: SessionRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    prismaStub.workspace.count.mockResolvedValue(1);
    repo = new SessionRepository();
  });

  it("listAllSessionsSummarized：恒定两条聚合批量 enrich（禁 N+1），NULL 游标全计/有游标按 id>cursor", async () => {
    prismaStub.session.findMany.mockResolvedValue([
      makeRow({ id: 1, title: "全计" }),
      makeRow({ id: 2, title: "半读", lastReadMessageId: 5 }),
    ]);
    prismaStub.message.groupBy
      // 第一次：末条 message id 聚合；第二次：未读计数（OR 逐会话一分支）
      .mockResolvedValueOnce([
        { sessionId: 1, _max: { id: 10 } },
        { sessionId: 2, _max: { id: 20 } },
      ])
      .mockResolvedValueOnce([
        { sessionId: 1, _count: { _all: 3 } },
        { sessionId: 2, _count: { _all: 1 } },
      ]);
    prismaStub.message.findMany.mockResolvedValue([
      {
        id: 10,
        sessionId: 1,
        role: "assistant",
        blocks: JSON.stringify([{ type: "text", text: "末条一" }]),
        createdAt: new Date("2026-10-26T00:00:00Z"),
      },
      {
        id: 20,
        sessionId: 2,
        role: "user",
        blocks: JSON.stringify([{ type: "text", text: "末条二" }]),
        createdAt: new Date("2026-10-26T01:00:00Z"),
      },
    ]);

    const rows = await repo.listAllSessionsSummarized(UID);

    // 禁 N+1：恒定两条 groupBy 聚合 + 一次批量取行，零逐会话 count
    expect(prismaStub.message.groupBy).toHaveBeenCalledTimes(2);
    expect(prismaStub.message.count).not.toHaveBeenCalled();
    expect(prismaStub.message.findMany).toHaveBeenCalledWith({
      where: { id: { in: [10, 20] } },
    });
    const unreadArgs = prismaStub.message.groupBy.mock.calls[1][0];
    expect(unreadArgs.where).toEqual({
      role: "assistant",
      OR: [{ sessionId: 1 }, { sessionId: 2, id: { gt: 5 } }],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].unreadCount).toBe(3);
    expect(rows[0].lastMessage).toEqual({
      id: 10,
      role: "assistant",
      kind: "text",
      text: "末条一",
      createdAt: "2026-10-26T00:00:00.000Z",
    });
    expect(rows[1].unreadCount).toBe(1);
    expect(rows[1].lastMessage?.kind).toBe("text");
  });

  it("listAllSessionsSummarized：空会话集短路返回（零聚合查询）", async () => {
    prismaStub.session.findMany.mockResolvedValue([]);
    await expect(repo.listAllSessionsSummarized(UID)).resolves.toEqual([]);
    expect(prismaStub.message.groupBy).not.toHaveBeenCalled();
  });

  it("markSessionRead：updateMany 单调条件写 + 生效游标现算未读", async () => {
    prismaStub.session.findFirst.mockResolvedValue({
      id: 1,
      userId: UID,
      lastReadMessageId: 2,
    });
    prismaStub.message.findFirst.mockResolvedValue({ id: 3, sessionId: 1 });
    prismaStub.message.count.mockResolvedValue(2);

    const result = await repo.markSessionRead(1, 3, UID);

    expect(prismaStub.session.updateMany).toHaveBeenCalledWith({
      where: {
        id: 1,
        userId: UID,
        OR: [{ lastReadMessageId: null }, { lastReadMessageId: { lt: 3 } }],
      },
      data: { lastReadMessageId: 3 },
    });
    expect(prismaStub.message.count).toHaveBeenCalledWith({
      where: { sessionId: 1, role: "assistant", id: { gt: 3 } },
    });
    expect(result).toEqual({
      sessionId: 1,
      lastReadMessageId: 3,
      unreadCount: 2,
    });
  });

  it("markSessionRead：请求 id 小于库内游标 → 生效游标不回退（幂等成功）", async () => {
    prismaStub.session.findFirst.mockResolvedValue({
      id: 1,
      userId: UID,
      lastReadMessageId: 8,
    });
    prismaStub.message.findFirst.mockResolvedValue({ id: 3, sessionId: 1 });
    prismaStub.message.count.mockResolvedValue(0);

    const result = await repo.markSessionRead(1, 3, UID);

    expect(result.lastReadMessageId).toBe(8);
    // updateMany 仍会执行（条件写天然并发安全），但未读按生效游标现算
    expect(prismaStub.session.updateMany).toHaveBeenCalled();
    expect(prismaStub.message.count).toHaveBeenCalledWith({
      where: { sessionId: 1, role: "assistant", id: { gt: 8 } },
    });
  });

  it("markSessionRead：会话缺失/message 不属会话 同抛 SESSION_NOT_FOUND 不写游标", async () => {
    prismaStub.session.findFirst.mockResolvedValue(null);
    await expect(repo.markSessionRead(1, 3, UID)).rejects.toThrow(
      "SESSION_NOT_FOUND",
    );
    prismaStub.session.findFirst.mockResolvedValue({
      id: 1,
      userId: UID,
      lastReadMessageId: null,
    });
    prismaStub.message.findFirst.mockResolvedValue(null);
    await expect(repo.markSessionRead(1, 3, UID)).rejects.toThrow(
      "SESSION_NOT_FOUND",
    );
    expect(prismaStub.session.updateMany).not.toHaveBeenCalled();
  });
});

describe("SessionRepository querySessions（face 全表扫描优化批）", () => {
  let repo: SessionRepository;

  /** 三键排序钉死（与 listAllSessions 同序，分页确定） */
  const ORDER_BY = [
    { pinnedAt: "desc" },
    { lastMessageAt: "desc" },
    { id: "desc" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    prismaStub.workspace.count.mockResolvedValue(1);
    repo = new SessionRepository();
  });

  it("非 keyword：where 下推 + skip/take + count，3 会话跨 2 页仅当前页 enrich（第二页响应无第一页角标聚合，total=3）", async () => {
    const pageRow = makeRow({ id: 3, title: "丙" });
    prismaStub.session.findMany.mockResolvedValue([pageRow]);
    prismaStub.session.count.mockResolvedValue(3);
    prismaStub.message.groupBy
      .mockResolvedValueOnce([{ sessionId: 3, _max: { id: 30 } }])
      .mockResolvedValueOnce([{ sessionId: 3, _count: { _all: 2 } }]);
    prismaStub.message.findMany.mockResolvedValue([
      {
        id: 30,
        sessionId: 3,
        role: "assistant",
        blocks: JSON.stringify([{ type: "text", text: "丙末条" }]),
        createdAt: new Date("2026-10-26T00:00:00Z"),
      },
    ]);

    const result = await repo.querySessions({ page: 2, pageSize: 2 }, UID);

    // 下推：findMany(skip/take) + count 同 where；排序固定三键
    expect(prismaStub.session.findMany).toHaveBeenCalledWith({
      where: { userId: UID },
      orderBy: ORDER_BY,
      skip: 2,
      take: 2,
    });
    expect(prismaStub.session.count).toHaveBeenCalledWith({
      where: { userId: UID },
    });
    // 仅当前页 enrich：两条聚合只携第二页会话 id（无第一页会话 1/2 的聚合）
    expect(prismaStub.message.groupBy).toHaveBeenCalledTimes(2);
    expect(prismaStub.message.groupBy.mock.calls[0][0]).toEqual({
      by: ["sessionId"],
      where: { sessionId: { in: [3] } },
      _max: { id: true },
    });
    expect(prismaStub.message.groupBy.mock.calls[1][0].where).toEqual({
      role: "assistant",
      OR: [{ sessionId: 3 }],
    });
    expect(result).toMatchObject({ page: 2, pageSize: 2, total: 3 });
    expect(result.records).toHaveLength(1);
    expect(result.records[0].id).toBe(3);
    expect(result.records[0].unreadCount).toBe(2);
    expect(result.records[0].lastMessage?.text).toBe("丙末条");
  });

  it("keyword：候选集全量（不带 skip/take）+ 大小写敏感 includes 过滤，total=filtered.length，不走 DB count", async () => {
    prismaStub.session.findMany.mockResolvedValue([
      makeRow({ id: 1, title: "ab" }),
      makeRow({ id: 2, title: "Ab" }),
      makeRow({ id: 3, title: "aB" }),
    ]);
    prismaStub.message.groupBy
      .mockResolvedValueOnce([{ sessionId: 2, _max: { id: 20 } }])
      .mockResolvedValueOnce([{ sessionId: 2, _count: { _all: 1 } }]);
    prismaStub.message.findMany.mockResolvedValue([
      {
        id: 20,
        sessionId: 2,
        role: "assistant",
        blocks: JSON.stringify([{ type: "text", text: "命中" }]),
        createdAt: new Date("2026-10-26T00:00:00Z"),
      },
    ]);

    const result = await repo.querySessions({ keyword: "Ab" }, UID);

    // 候选集查询：下推其余条件但无 skip/take（keyword 不可下推）
    expect(prismaStub.session.findMany).toHaveBeenCalledWith({
      where: { userId: UID },
      orderBy: ORDER_BY,
    });
    expect(prismaStub.session.count).not.toHaveBeenCalled();
    // 大小写敏感：仅 "Ab" 命中（"ab"/"aB" 不命中）；仅命中行 enrich
    expect(result.total).toBe(1);
    expect(result.records.map((r) => r.id)).toEqual([2]);
    expect(prismaStub.message.groupBy.mock.calls[1][0].where).toEqual({
      role: "assistant",
      OR: [{ sessionId: 2 }],
    });
  });

  it("activityAfter 双分支：where 钉死 OR 形状（lastMessageAt gte OR (null AND updatedAt gte)），含边界", async () => {
    const since = new Date("2026-06-01T00:00:00.000Z");
    prismaStub.session.findMany.mockResolvedValue([]);
    prismaStub.session.count.mockResolvedValue(0);

    await repo.querySessions(
      { workspaceId: 2, archived: false, activityAfter: since },
      UID,
    );

    expect(prismaStub.session.findMany).toHaveBeenCalledWith({
      where: {
        userId: UID,
        workspaceId: 2,
        archivedAt: null,
        AND: [
          {
            OR: [
              { lastMessageAt: { gte: since } },
              { AND: [{ lastMessageAt: null }, { updatedAt: { gte: since } }] },
            ],
          },
        ],
      },
      orderBy: ORDER_BY,
      skip: 0,
      take: 100,
    });
  });

  it("archived=true 下推 archivedAt {not:null}（SQLite null=未归档语义）", async () => {
    prismaStub.session.findMany.mockResolvedValue([]);
    prismaStub.session.count.mockResolvedValue(0);

    await repo.querySessions({ archived: true }, UID);

    expect(prismaStub.session.findMany).toHaveBeenCalledWith({
      where: { userId: UID, archivedAt: { not: null } },
      orderBy: ORDER_BY,
      skip: 0,
      take: 100,
    });
  });

  it("分页边界：page 越界空页——total 正确、records 空、零 enrich 聚合", async () => {
    prismaStub.session.findMany.mockResolvedValue([]);
    prismaStub.session.count.mockResolvedValue(1);

    const result = await repo.querySessions({ page: 5, pageSize: 10 }, UID);

    expect(result).toEqual({ page: 5, pageSize: 10, records: [], total: 1 });
    // 空页短路：不跑末条/未读聚合
    expect(prismaStub.message.groupBy).not.toHaveBeenCalled();
  });

  it("分页钳制：page<1 归 1，pageSize 0/501 钳 1/500（协议上限不变）", async () => {
    prismaStub.session.findMany.mockResolvedValue([]);
    prismaStub.session.count.mockResolvedValue(0);

    const low = await repo.querySessions({ page: 0, pageSize: 0 }, UID);
    expect(low.page).toBe(1);
    expect(low.pageSize).toBe(1);
    expect(prismaStub.session.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ skip: 0, take: 1 }),
    );

    const high = await repo.querySessions({ pageSize: 501 }, UID);
    expect(high.pageSize).toBe(500);
    expect(prismaStub.session.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ skip: 0, take: 500 }),
    );
  });

  it("listAllSessionsSummarized 经 enrichSummaries 重构后全量语义逐字节不变（回归：聚合口径与空集短路）", async () => {
    prismaStub.session.findMany.mockResolvedValue([
      makeRow({ id: 1, title: "全计" }),
      makeRow({ id: 2, title: "半读", lastReadMessageId: 5 }),
    ]);
    prismaStub.message.groupBy
      .mockResolvedValueOnce([
        { sessionId: 1, _max: { id: 10 } },
        { sessionId: 2, _max: { id: 20 } },
      ])
      .mockResolvedValueOnce([
        { sessionId: 1, _count: { _all: 3 } },
        { sessionId: 2, _count: { _all: 1 } },
      ]);
    prismaStub.message.findMany.mockResolvedValue([
      {
        id: 10,
        sessionId: 1,
        role: "assistant",
        blocks: JSON.stringify([{ type: "text", text: "末条一" }]),
        createdAt: new Date("2026-10-26T00:00:00Z"),
      },
      {
        id: 20,
        sessionId: 2,
        role: "user",
        blocks: JSON.stringify([{ type: "text", text: "末条二" }]),
        createdAt: new Date("2026-10-26T01:00:00Z"),
      },
    ]);

    const rows = await repo.listAllSessionsSummarized(UID);

    expect(prismaStub.message.groupBy).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 1, unreadCount: 3 });
    expect(rows[1]).toMatchObject({ id: 2, unreadCount: 1 });
    expect(rows[0].lastMessage?.text).toBe("末条一");
    // 空集短路语义保留
    prismaStub.session.findMany.mockResolvedValue([]);
    await expect(repo.listAllSessionsSummarized(UID)).resolves.toEqual([]);
  });
});

describe("SessionRepository P1 尾：本地 IPC 接线（enriched 列表 + read 上报）", () => {
  /** 构造即注册 IPC handler 的持引用占位（用例经 handlerOf 直调 handler） */
  let _repo: SessionRepository;

  /** 该通道最近一次注册的 handler（ipcMain.handle 模块级累积，取最新） */
  const handlerOf = (channel: string) => {
    const calls = vi.mocked(ipcMainMock.handle).mock.calls;
    const matched = calls.filter(([ch]) => ch === channel);
    const latest = matched[matched.length - 1];
    if (!latest) {
      throw new Error(`IPC 未注册: ${channel}`);
    }
    return latest[1] as (...args: unknown[]) => unknown;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    prismaStub.workspace.count.mockResolvedValue(1);
    _repo = new SessionRepository();
  });

  it("session:listAll 切 enriched：handler 直调 listAllSessionsSummarized（含 unreadCount/lastMessage）", async () => {
    prismaStub.session.findMany.mockResolvedValue([
      makeRow({ id: 1, title: "角标" }),
    ]);
    prismaStub.message.groupBy
      .mockResolvedValueOnce([{ sessionId: 1, _max: { id: 10 } }])
      .mockResolvedValueOnce([{ sessionId: 1, _count: { _all: 2 } }]);
    prismaStub.message.findMany.mockResolvedValue([
      {
        id: 10,
        sessionId: 1,
        role: "assistant",
        blocks: JSON.stringify([{ type: "text", text: "末条" }]),
        createdAt: new Date("2026-10-26T00:00:00Z"),
      },
    ]);
    const token = generateUserToken({ id: UID, username: "t" });
    const rows = (await handlerOf("session:listAll")({}, token)) as Array<{
      unreadCount: number;
      lastMessage?: { text: string };
    }>;
    expect(prismaStub.message.groupBy).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(1);
    expect(rows[0].unreadCount).toBe(2);
    expect(rows[0].lastMessage?.text).toBe("末条");
  });

  it("session:markRead：token 解 userId 后直调 markSessionRead 单调游标", async () => {
    prismaStub.session.findFirst.mockResolvedValue({
      id: 7,
      userId: UID,
      lastReadMessageId: null,
    });
    prismaStub.message.findFirst.mockResolvedValue({ id: 9, sessionId: 7 });
    prismaStub.message.count.mockResolvedValue(0);
    const token = generateUserToken({ id: UID, username: "t" });
    const result = (await handlerOf("session:markRead")({}, 7, 9, token)) as {
      sessionId: number;
      lastReadMessageId: number;
    };
    expect(prismaStub.session.updateMany).toHaveBeenCalledWith({
      where: {
        id: 7,
        userId: UID,
        OR: [{ lastReadMessageId: null }, { lastReadMessageId: { lt: 9 } }],
      },
      data: { lastReadMessageId: 9 },
    });
    expect(result).toEqual({
      sessionId: 7,
      lastReadMessageId: 9,
      unreadCount: 0,
    });
  });
});

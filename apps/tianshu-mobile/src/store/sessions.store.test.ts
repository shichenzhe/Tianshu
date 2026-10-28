import { beforeEach, describe, expect, it, vi } from "vitest";

import { ENDPOINTS } from "@tianshu/protocol";

// —— connections 层替身：activeTransport 可换 mock/null，事件总线可手动发射 ——
// state.subscribeCount 为普通闭包计数（非 vi.fn 状态——本仓 vitest 测试间会
// 自动清 mock 调用记录，跨用例断言「只绑一次」须用不受清除影响的计数）
const connMock = vi.hoisted(() => {
  const state = { subscribeCount: 0 };
  const cbs = new Set<(e: unknown) => void>();
  // useConnectionsStore 替身（M4 串台清空订阅）：activeConnId 可换 +
  // state 订阅回调可手动发射（subscribe 用普通函数——注册须跨用例存续）
  const connStateCbs = new Set<(s: { activeConnId: string | null }) => void>();
  let activeConnId: string | null = null;
  return {
    state,
    activeTransport: vi.fn(),
    subscribeTransportEvents: vi.fn((cb: (e: unknown) => void) => {
      cbs.add(cb);
      state.subscribeCount += 1;
      return () => cbs.delete(cb);
    }),
    emit: (e: unknown) => {
      for (const cb of [...cbs]) cb(e);
    },
    useConnectionsStore: {
      getState: () => ({ activeConnId }),
      subscribe: (cb: (s: { activeConnId: string | null }) => void) => {
        connStateCbs.add(cb);
        return () => connStateCbs.delete(cb);
      },
    },
    /** 驱动 activeConnId 变化（发全部 state 订阅——对应真实 store 语义） */
    setActiveConnId: (id: string | null) => {
      activeConnId = id;
      for (const cb of [...connStateCbs]) cb({ activeConnId: id });
    },
  };
});

vi.mock("./connections.store", () => ({
  activeTransport: connMock.activeTransport,
  subscribeTransportEvents: connMock.subscribeTransportEvents,
  useConnectionsStore: connMock.useConnectionsStore,
}));

import {
  useSessionsStore,
  reorderSessions,
  type SessionBrief,
} from "./sessions.store";

/** 伪 transport：只需 request（六态/事件均不经此路径） */
function makeTransport() {
  return { request: vi.fn() };
}

const page1 = {
  page: 1,
  pageSize: 50,
  records: [
    // workspaceId 自 MB-T2 起保留（分组消费）；pinnedAt 自 LA 交互批透传；
    // unreadCount/lastMessage 自 P1 未读角标批透传；其余多余字段仍裁剪
    {
      id: 1,
      title: "会话一",
      updatedAt: "2026-10-17T01:00:00.000Z",
      archivedAt: null,
      pinnedAt: null,
      workspaceId: 3,
      unreadCount: 2,
      lastMessage: {
        id: 9,
        role: "assistant",
        kind: "text",
        text: "末条摘要",
        createdAt: "2026-10-17T02:00:00.000Z",
      },
    },
    {
      id: 2,
      title: null,
      updatedAt: "2026-10-16T01:00:00.000Z",
      archivedAt: null,
      pinnedAt: "2026-10-18T00:00:00.000Z",
      unreadCount: 0,
      lastMessage: null,
    },
  ],
  total: 2,
};

const brief1: SessionBrief = {
  id: 1,
  title: "会话一",
  updatedAt: "2026-10-17T01:00:00.000Z",
  archivedAt: null,
  pinnedAt: null,
  workspaceId: 3,
  unreadCount: 2,
  lastMessage: {
    id: 9,
    role: "assistant",
    kind: "text",
    text: "末条摘要",
    createdAt: "2026-10-17T02:00:00.000Z",
  },
};

function ok(data: unknown) {
  return {
    status: 200,
    body: { code: "2000", success: true, data, message: "success" },
  };
}

/** store 为模块级单例：用例间复位 state（bindEvents 订阅由模块守卫保持单份） */
function resetStore(): void {
  useSessionsStore.setState({
    items: [],
    workspaces: [],
    total: 0,
    page: 1,
    keyword: "",
    showArchived: false,
    timeFilter: "all",
    loading: false,
    refreshing: false,
    workspaceSessions: {},
  });
}

describe("sessions store", () => {
  let transport: ReturnType<typeof makeTransport>;

  beforeEach(() => {
    transport = makeTransport();
    connMock.activeTransport.mockReset().mockReturnValue(transport);
    resetStore();
    useSessionsStore.getState().bindEvents();
  });

  it("loadFirst：POST session/query 解包 records/total（裁 SessionBrief 子集）", async () => {
    transport.request.mockResolvedValue(ok(page1));
    await useSessionsStore.getState().loadFirst();

    expect(transport.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.session.query,
      {
        page: 1,
        pageSize: 50,
        keyword: "",
        archived: false, // 默认仅未归档（LA 交互批）
      },
    );
    const s = useSessionsStore.getState();
    expect(s.items).toEqual([
      brief1,
      {
        id: 2,
        title: null,
        updatedAt: "2026-10-16T01:00:00.000Z",
        archivedAt: null,
        pinnedAt: "2026-10-18T00:00:00.000Z",
        unreadCount: 0,
        lastMessage: null,
      },
    ]);
    expect(s.total).toBe(2);
    expect(s.page).toBe(1);
    expect(s.loading).toBe(false);
  });

  it("loadMore：hasMore 时 page+1 拼接去重；取尽后不再请求", async () => {
    const ids = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, k) => ({
        ...brief1,
        id: from + k,
      }));
    transport.request.mockImplementation(
      async (_m: string, _p: string, b: { page: number }) =>
        ok(
          b.page === 1
            ? { page: 1, pageSize: 50, records: ids(1, 50), total: 51 }
            : {
                page: 2,
                pageSize: 50,
                records: [
                  { ...brief1, id: 50 },
                  { ...brief1, id: 51 },
                ],
                total: 51,
              },
        ),
    );
    await useSessionsStore.getState().loadFirst();

    await useSessionsStore.getState().loadMore();
    const s = useSessionsStore.getState();
    expect(s.page).toBe(2);
    expect(s.items).toHaveLength(51); // 跨页重复 id 50 去重
    expect(s.items.map((i) => i.id)).toEqual([
      ...ids(1, 50).map((i) => i.id),
      51,
    ]);

    await useSessionsStore.getState().loadMore(); // 已满 total=51 → hasMore false，不再翻页
    // loadFirst 多带一次 workspace/query（MB-T2 覆写语义），loadMore 不重复拉
    expect(transport.request).toHaveBeenCalledTimes(3);
    expect(useSessionsStore.getState().page).toBe(2);
  });

  it("refreshing（fix：与分页 loading 分离）：loadFirst 进行中亮、收尾灭；loadMore 续页全程不亮", async () => {
    let releaseQuery: ((v: void) => void) | null = null;
    const gate = new Promise<void>((r) => (releaseQuery = r));
    transport.request.mockImplementation(async () => {
      await gate;
      return ok(page1);
    });
    const first = useSessionsStore.getState().loadFirst();
    expect(useSessionsStore.getState().refreshing).toBe(true); // 首页覆写进行中
    expect(useSessionsStore.getState().loading).toBe(true);
    releaseQuery!();
    await first;
    expect(useSessionsStore.getState().refreshing).toBe(false);
    expect(useSessionsStore.getState().loading).toBe(false);

    // 续页：loading 亮但 refreshing 不亮（下拉刷新条不误亮）
    useSessionsStore.setState({
      items: page1.records.map((r) => ({ ...r })) as SessionBrief[],
      total: 60,
    });
    transport.request.mockResolvedValue(
      ok({ records: page1.records, total: 60 }),
    );
    await useSessionsStore.getState().loadMore();
    expect(useSessionsStore.getState().loading).toBe(false);
    expect(useSessionsStore.getState().refreshing).toBe(false);
  });

  it("session.updated：原地更新 title/updatedAt 并重排（活跃上浮，LA 交互批），未知 id 无副作用", () => {
    useSessionsStore.setState({
      items: [
        brief1,
        {
          id: 2,
          title: "旧",
          updatedAt: "2026-10-15T00:00:00.000Z",
          archivedAt: null,
          pinnedAt: null,
          unreadCount: 0,
          lastMessage: null,
        },
      ],
    });

    connMock.emit({
      type: "session.updated",
      payload: {
        id: 2,
        title: "新标题",
        updatedAt: "2026-10-17T08:00:00.000Z",
        unreadCount: 0,
        lastMessage: null,
      },
    });
    let items = useSessionsStore.getState().items;
    expect(items).toHaveLength(2);
    // updatedAt 跃至最新 → 重排上浮至首位（原「原地不动」语义已废）
    expect(items[0]).toEqual({
      id: 2,
      title: "新标题",
      updatedAt: "2026-10-17T08:00:00.000Z",
      archivedAt: null,
      pinnedAt: null,
      unreadCount: 0,
      lastMessage: null,
    });
    expect(items[1]).toEqual(brief1);

    connMock.emit({
      type: "session.updated",
      payload: {
        id: 99,
        title: "他表",
        updatedAt: "2026-10-17T09:00:00.000Z",
        unreadCount: 3,
        lastMessage: null,
      },
    });
    items = useSessionsStore.getState().items;
    expect(items).toHaveLength(2);
  });

  // —— P1 未读角标批：事件角标投影 / read 清角标 ——

  it("session.updated：unreadCount/lastMessage 投影进主列表与命中组缓存（read 后服务端复用本事件清角标）", () => {
    const row2: SessionBrief = {
      id: 2,
      title: "旧",
      updatedAt: "2026-10-15T00:00:00.000Z",
      archivedAt: null,
      pinnedAt: null,
      unreadCount: 5,
      lastMessage: null,
    };
    useSessionsStore.setState({
      items: [brief1, row2],
      workspaceSessions: {
        3: { loaded: true, loading: false, items: [brief1] },
      },
    });

    const lastMessage = {
      id: 20,
      role: "assistant",
      kind: "tool",
      text: "run_command",
      createdAt: "2026-10-17T09:00:00.000Z",
    };
    connMock.emit({
      type: "session.updated",
      payload: {
        id: 1,
        title: "会话一",
        updatedAt: "2026-10-17T01:00:00.000Z",
        unreadCount: 0,
        lastMessage,
      },
    });
    const s = useSessionsStore.getState();
    expect(s.items.find((i) => i.id === 1)?.unreadCount).toBe(0);
    expect(s.items.find((i) => i.id === 1)?.lastMessage).toEqual(lastMessage);
    expect(s.items.find((i) => i.id === 2)?.unreadCount).toBe(5); // 未命中行不动
    // 组缓存命中行同步投影
    expect(s.workspaceSessions[3].items[0].unreadCount).toBe(0);
    expect(s.workspaceSessions[3].items[0].lastMessage).toEqual(lastMessage);
  });

  it("session.updated：旧被控端载荷未下发角标字段——缺省保留原值无副作用", () => {
    useSessionsStore.setState({ items: [brief1] });
    connMock.emit({
      type: "session.updated",
      payload: { id: 1, title: "改题", updatedAt: "2026-10-17T10:00:00.000Z" },
    });
    const row = useSessionsStore.getState().items[0];
    expect(row.title).toBe("改题");
    expect(row.unreadCount).toBe(2); // 角标保留
    expect(row.lastMessage).toEqual(brief1.lastMessage);
  });

  it("applyRead：已读生效后清主列表与组缓存角标；未知 id 无副作用", () => {
    const row2: SessionBrief = {
      id: 2,
      title: "旧",
      updatedAt: "2026-10-15T00:00:00.000Z",
      archivedAt: null,
      pinnedAt: null,
      unreadCount: 7,
      lastMessage: null,
    };
    useSessionsStore.setState({
      items: [brief1, row2],
      workspaceSessions: {
        3: { loaded: true, loading: false, items: [{ ...brief1 }] },
        4: { loaded: true, loading: false, items: [row2] },
      },
    });

    useSessionsStore.getState().applyRead(1, 0);
    const s = useSessionsStore.getState();
    expect(s.items.find((i) => i.id === 1)?.unreadCount).toBe(0);
    expect(s.workspaceSessions[3].items[0].unreadCount).toBe(0);
    expect(s.workspaceSessions[4].items[0].unreadCount).toBe(7); // 他组不动

    useSessionsStore.getState().applyRead(99, 0); // 未知 id 无副作用
    expect(
      useSessionsStore.getState().items.find((i) => i.id === 2)?.unreadCount,
    ).toBe(7);
  });

  it("server.connected：触发 loadFirst 全量刷新", async () => {
    transport.request.mockResolvedValue(ok(page1));
    await useSessionsStore.getState().loadFirst();
    transport.request.mockClear();

    connMock.emit({
      type: "server.connected",
      payload: { instanceId: "inst", capabilities: ["chat"] },
    });
    // fire-and-forget loadFirst：session/query 先发、workspace/query 随后
    // （MB-T2 两请求，微任务时序——轮询等待第二个到达）
    for (let i = 0; i < 10 && transport.request.mock.calls.length < 2; i += 1) {
      await Promise.resolve();
    }
    expect(transport.request).toHaveBeenCalledTimes(2);
    expect(transport.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.session.query,
      {
        page: 1,
        pageSize: 50,
        keyword: "",
        archived: false,
      },
    );
  });

  it("连接切换（M4）：activeConnId 换目标清空列表并重拉首页；同 id 重连不清", async () => {
    transport.request.mockResolvedValue(ok(page1));
    await useSessionsStore.getState().loadFirst();
    expect(useSessionsStore.getState().items).toHaveLength(2);

    // 换目标：旧连接的列表即时清空（不等新端列表返回，串台窗口消除）
    transport.request.mockClear();
    connMock.setActiveConnId("conn-b");
    expect(useSessionsStore.getState().items).toEqual([]);
    expect(useSessionsStore.getState().total).toBe(0);
    expect(useSessionsStore.getState().page).toBe(1);
    // 清表后 loadFirst 已发起并以新端首页回填
    await vi.waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith(
        "POST",
        ENDPOINTS.session.query,
        {
          page: 1,
          pageSize: 50,
          keyword: "",
          archived: false,
        },
      ),
    );
    await vi.waitFor(() =>
      expect(useSessionsStore.getState().items).toHaveLength(2),
    );

    // 同 id 重连（teardown+activate 同值）：不触发清空
    connMock.setActiveConnId("conn-b");
    expect(useSessionsStore.getState().items).toHaveLength(2);
  });

  it("无活动连接：loadFirst 静默置空表不报错", async () => {
    connMock.activeTransport.mockReturnValue(null);
    await expect(
      useSessionsStore.getState().loadFirst(),
    ).resolves.toBeUndefined();
    const s = useSessionsStore.getState();
    expect(s.items).toEqual([]);
    expect(s.total).toBe(0);
    expect(s.loading).toBe(false);
    expect(transport.request).not.toHaveBeenCalled();
  });

  it("create：成功返回新会话并即时置顶入列（M1）；业务错（success false）返回 null 不动表", async () => {
    const created = {
      id: 100,
      title: "新会话",
      updatedAt: "2026-10-17T10:00:00.000Z",
      archivedAt: null,
      pinnedAt: null,
      unreadCount: 0,
      lastMessage: null,
    };
    useSessionsStore.setState({ items: [brief1], total: 1 });
    transport.request.mockResolvedValueOnce(ok(created));
    await expect(useSessionsStore.getState().create()).resolves.toEqual(
      created,
    );
    expect(transport.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.session.create,
      {},
    );
    const s = useSessionsStore.getState();
    expect(s.items).toEqual([created, brief1]); // 置顶立即可见（重拉 lastMessageAt NULL 沉底已知可接受）
    expect(s.total).toBe(2);

    transport.request.mockResolvedValueOnce({
      status: 200,
      body: { code: "5000", success: false, data: null, message: "内部错误" },
    });
    await expect(
      useSessionsStore.getState().create("失败例"),
    ).resolves.toBeNull();
    expect(transport.request).toHaveBeenLastCalledWith(
      "POST",
      ENDPOINTS.session.create,
      { title: "失败例" },
    );
    expect(useSessionsStore.getState().items).toEqual([created, brief1]); // 失败不动表
  });

  it("create(workspaceId)：请求体携带 workspaceId；归属组已加载时原地前置入组缓存，其余组缓存不动", async () => {
    const created = {
      id: 101,
      title: "新会话",
      updatedAt: "2026-10-17T10:00:00.000Z",
      archivedAt: null,
      pinnedAt: null,
      workspaceId: 7,
      unreadCount: 0,
      lastMessage: null,
    };
    useSessionsStore.setState({
      workspaceSessions: {
        7: { loaded: true, loading: false, items: [brief1] },
        8: { loaded: true, loading: false, items: [] },
      },
    });
    transport.request.mockResolvedValueOnce(ok(created));
    await expect(
      useSessionsStore.getState().create(undefined, 7),
    ).resolves.toEqual(created);
    expect(transport.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.session.create,
      { workspaceId: 7 },
    );
    const s = useSessionsStore.getState();
    // 归属组（已加载）原地前置，展开中的组不再因全清缓存而误显「暂无会话」
    expect(s.workspaceSessions[7].items.map((i) => i.id)).toEqual([101, 1]);
    expect(s.workspaceSessions[8].loaded).toBe(true);
    expect(s.workspaceSessions[8].items).toEqual([]);
  });

  it("remove：成功后从 items 滤除；失败保留原表", async () => {
    useSessionsStore.setState({ items: [brief1] });
    transport.request.mockResolvedValueOnce(ok(null));
    await useSessionsStore.getState().remove(1);
    expect(useSessionsStore.getState().items).toEqual([]);
    expect(transport.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.session.delete,
      { id: 1 },
    );

    useSessionsStore.setState({ items: [brief1] });
    transport.request.mockResolvedValueOnce({
      status: 200,
      body: { code: "4040", success: false, data: null, message: "会话不存在" },
    });
    await useSessionsStore.getState().remove(1);
    expect(useSessionsStore.getState().items).toEqual([brief1]);
  });

  it("search：400ms 防抖后以新 keyword loadFirst", () => {
    vi.useFakeTimers();
    try {
      useSessionsStore.getState().search("甲");
      expect(transport.request).not.toHaveBeenCalled();

      vi.advanceTimersByTime(399);
      expect(transport.request).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(transport.request).toHaveBeenCalledTimes(1);
      expect(transport.request).toHaveBeenCalledWith(
        "POST",
        ENDPOINTS.session.query,
        {
          page: 1,
          pageSize: 50,
          keyword: "甲",
          archived: false,
        },
      );
      expect(useSessionsStore.getState().keyword).toBe("甲");
    } finally {
      vi.useRealTimers();
    }
  });

  it("bindEvents：重复调用只订阅一次（App 级单份）", () => {
    expect(connMock.state.subscribeCount).toBe(1); // 首绑发生于本文件首个 beforeEach
    useSessionsStore.getState().bindEvents();
    useSessionsStore.getState().bindEvents();
    expect(connMock.state.subscribeCount).toBe(1); // 追加调用零新增订阅
  });

  // —— LA 交互批：重排 / 置顶归档动作 / 归档筛选 ——

  it("reorderSessions：置顶恒在前（组内 pinnedAt 倒序），其余 updatedAt 倒序（对齐桌面 session-list 语义）", () => {
    const a: SessionBrief = {
      id: 1,
      title: null,
      updatedAt: "2026-10-17T01:00:00.000Z",
      archivedAt: null,
      pinnedAt: null,
      unreadCount: 0,
      lastMessage: null,
    };
    const b: SessionBrief = {
      id: 2,
      title: null,
      updatedAt: "2026-10-16T01:00:00.000Z",
      archivedAt: null,
      pinnedAt: null,
      unreadCount: 0,
      lastMessage: null,
    };
    const p1: SessionBrief = {
      id: 3,
      title: null,
      updatedAt: "2026-10-01T00:00:00.000Z",
      archivedAt: null,
      pinnedAt: "2026-10-10T00:00:00.000Z",
      unreadCount: 0,
      lastMessage: null,
    };
    const p2: SessionBrief = {
      id: 4,
      title: null,
      updatedAt: "2026-10-02T00:00:00.000Z",
      archivedAt: null,
      pinnedAt: "2026-10-15T00:00:00.000Z",
      unreadCount: 0,
      lastMessage: null,
    };
    expect(reorderSessions([a, p1, b, p2]).map((i) => i.id)).toEqual([
      4, 3, 1, 2,
    ]);
  });

  it("update：置顶成功本地置值并上浮，取消置顶回落；载荷 sessionId 打头（LA）", async () => {
    const other: SessionBrief = {
      id: 2,
      title: "其他",
      updatedAt: "2026-10-17T05:00:00.000Z",
      archivedAt: null,
      pinnedAt: null,
      unreadCount: 0,
      lastMessage: null,
    };
    useSessionsStore.setState({ items: [brief1, other], total: 2 });
    transport.request.mockResolvedValueOnce(ok(null));

    await expect(
      useSessionsStore.getState().update(1, { pinned: true }),
    ).resolves.toBe(true);
    expect(transport.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.session.update,
      { sessionId: 1, pinned: true },
    );
    let items = useSessionsStore.getState().items;
    expect(items[0].id).toBe(1); // 置顶上浮（updatedAt 落后 other 也前置）
    expect(items[0].pinnedAt).toEqual(expect.any(String));
    expect(items[1]).toEqual(other);

    transport.request.mockResolvedValueOnce(ok(null));
    await useSessionsStore.getState().update(1, { pinned: false });
    items = useSessionsStore.getState().items;
    expect(items.map((i) => i.id)).toEqual([2, 1]); // 取消置顶回落 updatedAt 序
    expect(items[1].pinnedAt).toBeNull();
  });

  it("update：归档在默认视图（showArchived=false）下行暂存（pendingArchive）不即删，撤销窗口由 settleArchive 落定移除；业务错返回 false 不动表", async () => {
    useSessionsStore.setState({ items: [brief1], total: 1 });
    transport.request.mockResolvedValueOnce({
      status: 200,
      body: { code: "4040", success: false, data: null, message: "会话不存在" },
    });
    await expect(
      useSessionsStore.getState().update(1, { archived: true }),
    ).resolves.toBe(false);
    expect(useSessionsStore.getState().items).toEqual([brief1]); // 失败不动表

    transport.request.mockResolvedValueOnce(ok(null));
    await expect(
      useSessionsStore.getState().update(1, { archived: true }),
    ).resolves.toBe(true);
    // B5 撤销批：行保留 + 临时还原态标记（total 不变——到点落定才减）
    expect(useSessionsStore.getState().items[0].pendingArchive).toBe(true);
    expect(useSessionsStore.getState().items[0].archivedAt).toEqual(
      expect.any(String),
    );
    expect(useSessionsStore.getState().total).toBe(1);

    useSessionsStore.getState().settleArchive(1);
    expect(useSessionsStore.getState().items).toEqual([]);
    expect(useSessionsStore.getState().total).toBe(0);

    // 已移除后再落定 no-op
    useSessionsStore.getState().settleArchive(1);
    expect(useSessionsStore.getState().items).toEqual([]);
  });

  it("update：归档撤销（archived:false）清 pendingArchive 原地还原，不经移除", async () => {
    useSessionsStore.setState({ items: [brief1], total: 1 });
    transport.request.mockResolvedValueOnce(ok(null));
    await useSessionsStore.getState().update(1, { archived: true });
    expect(useSessionsStore.getState().items[0].pendingArchive).toBe(true);

    transport.request.mockResolvedValueOnce(ok(null));
    await useSessionsStore.getState().update(1, { archived: false });
    const row = useSessionsStore.getState().items[0];
    expect(row.pendingArchive).toBe(false);
    expect(row.archivedAt).toBeNull();
    expect(useSessionsStore.getState().total).toBe(1); // 还原不触落定
    // 无暂存标记后落定 no-op（行仍在）
    useSessionsStore.getState().settleArchive(1);
    expect(useSessionsStore.getState().items[0].id).toBe(1);
  });

  it("settleArchive：组缓存同步滤行；非暂存行（全部筛选直归档）不落定", async () => {
    useSessionsStore.setState({
      items: [brief1],
      total: 1,
      workspaceSessions: {
        3: { loaded: true, loading: false, items: [{ ...brief1 }] },
      },
    });
    transport.request.mockResolvedValueOnce(ok(null));
    await useSessionsStore.getState().update(1, { archived: true });
    expect(
      useSessionsStore.getState().workspaceSessions[3].items[0].pendingArchive,
    ).toBe(true);

    useSessionsStore.getState().settleArchive(1);
    expect(useSessionsStore.getState().workspaceSessions[3].items).toEqual([]);

    // 全部筛选：归档无暂存标记，settle 不删行（archivedAt 置值即可）
    useSessionsStore.setState({
      items: [brief1],
      total: 1,
      showArchived: true,
    });
    transport.request.mockResolvedValueOnce(ok(null));
    await useSessionsStore.getState().update(1, { archived: true });
    expect(useSessionsStore.getState().items[0].pendingArchive).toBe(false);
    useSessionsStore.getState().settleArchive(1);
    expect(useSessionsStore.getState().items[0].archivedAt).toEqual(
      expect.any(String),
    );
  });

  it("update：showArchived 视图下归档原地保留（archivedAt 置值），取消归档清空", async () => {
    useSessionsStore.setState({
      items: [brief1],
      total: 1,
      showArchived: true,
    });
    transport.request.mockResolvedValueOnce(ok(null));
    await useSessionsStore.getState().update(1, { archived: true });
    expect(useSessionsStore.getState().items[0].archivedAt).toEqual(
      expect.any(String),
    );

    transport.request.mockResolvedValueOnce(ok(null));
    await useSessionsStore.getState().update(1, { archived: false });
    expect(useSessionsStore.getState().items[0].archivedAt).toBeNull();
  });

  it("update：重命名（B1 对齐桌面）同步 items 与已加载组缓存；载荷带 title", async () => {
    useSessionsStore.setState({
      items: [brief1],
      workspaceSessions: {
        3: { loaded: true, loading: false, items: [brief1] },
      },
    });
    transport.request.mockResolvedValueOnce(ok(null));
    await expect(
      useSessionsStore.getState().update(1, { title: "新标题" }),
    ).resolves.toBe(true);
    expect(transport.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.session.update,
      { sessionId: 1, title: "新标题" },
    );
    expect(useSessionsStore.getState().items[0].title).toBe("新标题");
    expect(
      useSessionsStore.getState().workspaceSessions[3].items[0].title,
    ).toBe("新标题");
  });

  it("setShowArchived：切换即重拉且载荷不带 archived（全量）；重复同值不触发", async () => {
    transport.request.mockResolvedValue(ok({ records: [], total: 0 }));
    useSessionsStore.getState().setShowArchived(true);
    await vi.waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith(
        "POST",
        ENDPOINTS.session.query,
        {
          page: 1,
          pageSize: 50,
          keyword: "",
        },
      ),
    );
    expect(useSessionsStore.getState().showArchived).toBe(true);

    transport.request.mockClear();
    useSessionsStore.getState().setShowArchived(true); // 同值幂等
    expect(transport.request).not.toHaveBeenCalled();
  });

  // —— A11 时间筛选批：两处组装带参 / 全部时不带参 / 切换重拉 ——

  it("setTimeFilter：切换即重拉首屏且载荷带 activityAfter；切回 all 不带参；同值幂等", async () => {
    transport.request.mockResolvedValue(ok({ records: [], total: 0 }));
    useSessionsStore.getState().setTimeFilter("week");
    await vi.waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith(
        "POST",
        ENDPOINTS.session.query,
        {
          page: 1,
          pageSize: 50,
          keyword: "",
          archived: false,
          activityAfter: expect.any(String),
        },
      ),
    );
    expect(useSessionsStore.getState().timeFilter).toBe("week");

    transport.request.mockClear();
    useSessionsStore.getState().setTimeFilter("week"); // 同值幂等
    expect(transport.request).not.toHaveBeenCalled();

    useSessionsStore.getState().setTimeFilter("all");
    await vi.waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith(
        "POST",
        ENDPOINTS.session.query,
        {
          page: 1,
          pageSize: 50,
          keyword: "",
          archived: false, // all：不出 activityAfter 键
        },
      ),
    );
  });

  it("loadWorkspaceSessions：时间筛选选中时组懒加载同步带 activityAfter（与主列表同参）", async () => {
    transport.request.mockResolvedValue(ok({ records: [], total: 0 }));
    useSessionsStore.setState({ timeFilter: "today" });
    await useSessionsStore.getState().loadWorkspaceSessions(3);
    expect(transport.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.session.query,
      {
        page: 0,
        pageSize: 50,
        keyword: "",
        workspaceId: 3,
        archived: false,
        activityAfter: expect.any(String),
      },
    );
  });

  it("loadWorkspaceSessions：未归属组（null）时间筛选同样带 activityAfter", async () => {
    transport.request.mockResolvedValue(ok({ records: [], total: 0 }));
    useSessionsStore.setState({ timeFilter: "month" });
    await useSessionsStore.getState().loadWorkspaceSessions(null);
    expect(transport.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.session.query,
      {
        page: 0,
        pageSize: 50,
        keyword: "",
        archived: false,
        activityAfter: expect.any(String),
      },
    );
  });
});

// —— A8 工作空间管理批：投影补齐 + 写面（串行/防迟到/级联删除清缓存） ——

describe("workspace 管理批（A8）", () => {
  let transport: ReturnType<typeof makeTransport>;

  beforeEach(() => {
    transport = makeTransport();
    connMock.activeTransport.mockReset().mockReturnValue(transport);
    resetStore();
  });

  const wsRow = {
    id: 3,
    name: "空间甲",
    directoryPath: "/data/docs",
    defaultModelId: 9,
  };
  const wsBrief = {
    id: 3,
    name: "空间甲",
    directoryPath: "/data/docs",
    defaultModelId: 9,
  };

  /** 冲刷微任务队列：让串行链上的 run 真正发出请求 */
  async function flush(times = 6): Promise<void> {
    for (let i = 0; i < times; i += 1) await Promise.resolve();
  }

  it("workspace/query 投影补齐 directoryPath/defaultModelId（旧端未下发归 null）", async () => {
    transport.request.mockImplementation(async (_m: string, path: string) =>
      path === ENDPOINTS.workspace.query
        ? ok([wsRow, { id: 4, name: "旧端空间" }])
        : ok({ records: [], total: 0 }),
    );
    await useSessionsStore.getState().loadFirst();
    expect(useSessionsStore.getState().workspaces).toEqual([
      wsBrief,
      { id: 4, name: "旧端空间", directoryPath: null, defaultModelId: null },
    ]);
  });

  it("loadWorkspaces：按需单拉 workspace/query（不连带会话主拉），失败保留旧表", async () => {
    transport.request.mockResolvedValueOnce(ok([wsRow]));
    await useSessionsStore.getState().loadWorkspaces();
    expect(transport.request).toHaveBeenCalledWith(
      "POST",
      "workspace/query",
      {},
    );
    // 未发 session/query（与 loadFirst 覆写语义分流）
    expect(
      transport.request.mock.calls.some(
        (call) => call[1] === ENDPOINTS.session.query,
      ),
    ).toBe(false);
    expect(useSessionsStore.getState().workspaces).toEqual([wsBrief]);
    // 失败保留旧表
    transport.request.mockResolvedValueOnce({
      status: 200,
      body: { code: "5000", success: false, data: null, message: "err" },
    });
    await useSessionsStore.getState().loadWorkspaces();
    expect(useSessionsStore.getState().workspaces).toEqual([wsBrief]);
  });

  it("createWorkspace：POST workspace/create（name/icon），成功投影四字段入清单", async () => {
    // 协议钉：新写面路径与 spec 一致——常量未落地时本用例红（防假绿）
    expect(ENDPOINTS.workspace.create).toBe("workspace/create");
    transport.request.mockResolvedValueOnce(ok(wsRow));
    await expect(
      useSessionsStore.getState().createWorkspace("空间甲", "🚀"),
    ).resolves.toEqual(wsBrief);
    expect(transport.request).toHaveBeenCalledWith("POST", "workspace/create", {
      name: "空间甲",
      icon: "🚀",
    });
    expect(useSessionsStore.getState().workspaces).toEqual([wsBrief]);
  });

  it("createWorkspace：icon 缺省不带键；业务错返回 null 不动清单；无连接静默 null", async () => {
    transport.request.mockResolvedValueOnce(ok(wsRow));
    await useSessionsStore.getState().createWorkspace("空间甲");
    expect(transport.request).toHaveBeenCalledWith("POST", "workspace/create", {
      name: "空间甲",
    });

    transport.request.mockResolvedValueOnce({
      status: 200,
      body: { code: "5000", success: false, data: null, message: "内部错误" },
    });
    await expect(
      useSessionsStore.getState().createWorkspace("乙"),
    ).resolves.toBeNull();
    expect(useSessionsStore.getState().workspaces).toHaveLength(1);

    connMock.activeTransport.mockReturnValue(null);
    await expect(
      useSessionsStore.getState().createWorkspace("丙"),
    ).resolves.toBeNull();
    expect(transport.request).toHaveBeenCalledTimes(2); // 无连接不发请求
  });

  it("renameWorkspace：POST workspace/update {id,name}，成功原地改名；失败不动表", async () => {
    useSessionsStore.setState({
      workspaces: [
        { id: 3, name: "旧名", directoryPath: null, defaultModelId: null },
      ],
    });
    transport.request.mockResolvedValueOnce(ok(wsRow));
    await expect(
      useSessionsStore.getState().renameWorkspace(3, "新名"),
    ).resolves.toBe(true);
    expect(transport.request).toHaveBeenCalledWith("POST", "workspace/update", {
      id: 3,
      name: "新名",
    });
    expect(useSessionsStore.getState().workspaces[0].name).toBe("新名");

    transport.request.mockResolvedValueOnce({
      status: 200,
      body: { code: "4040", success: false, data: null, message: "空间不存在" },
    });
    await expect(
      useSessionsStore.getState().renameWorkspace(3, "再改"),
    ).resolves.toBe(false);
    expect(useSessionsStore.getState().workspaces[0].name).toBe("新名");
  });

  it("deleteWorkspace：POST workspace/delete {id}；清单移除 + 组缓存清 + 级联会话行滤除 total 回落", async () => {
    const rowOf4: SessionBrief = { ...brief1, id: 5, workspaceId: 4 };
    useSessionsStore.setState({
      items: [brief1, rowOf4],
      total: 2,
      workspaces: [wsBrief, { ...wsBrief, id: 4, name: "空间乙" }],
      workspaceSessions: {
        3: { loaded: true, loading: false, items: [{ ...brief1 }] },
        4: { loaded: true, loading: false, items: [] },
      },
    });
    transport.request.mockResolvedValueOnce(ok(null)); // delete 成功帧 data 即 null
    await expect(useSessionsStore.getState().deleteWorkspace(3)).resolves.toBe(
      true,
    );
    expect(transport.request).toHaveBeenCalledWith("POST", "workspace/delete", {
      id: 3,
    });
    const s = useSessionsStore.getState();
    expect(s.workspaces.map((w) => w.id)).toEqual([4]); // 清单移除
    expect(s.workspaceSessions[3]).toBeUndefined(); // 该组缓存清
    expect(s.workspaceSessions[4]).toBeDefined(); // 他组不动
    expect(s.items.map((i) => i.id)).toEqual([5]); // 级联会话行同步滤除
    expect(s.total).toBe(1);

    transport.request.mockResolvedValueOnce({
      status: 200,
      body: { code: "4040", success: false, data: null, message: "空间不存在" },
    });
    await expect(useSessionsStore.getState().deleteWorkspace(4)).resolves.toBe(
      false,
    );
    expect(useSessionsStore.getState().workspaces.map((w) => w.id)).toEqual([
      4,
    ]);
  });

  it("写面串行：前写在途时后写不发请求；释放后按入队序落地", async () => {
    let release: ((v: void) => void) | null = null;
    const gate = new Promise<void>((r) => (release = r));
    transport.request
      .mockImplementationOnce(async () => {
        await gate;
        return ok(wsRow);
      })
      .mockResolvedValueOnce(ok(null));
    const p1 = useSessionsStore.getState().createWorkspace("甲");
    const p2 = useSessionsStore.getState().renameWorkspace(3, "乙");
    await flush();
    expect(transport.request).toHaveBeenCalledTimes(1); // 串行：后写排队未发
    release!();
    await expect(p1).resolves.toEqual(wsBrief);
    await expect(p2).resolves.toBe(true);
    expect(transport.request).toHaveBeenNthCalledWith(
      1,
      "POST",
      "workspace/create",
      { name: "甲" },
    );
    expect(transport.request).toHaveBeenNthCalledWith(
      2,
      "POST",
      "workspace/update",
      { id: 3, name: "乙" },
    );
  });

  it("写面防迟到：写途中换连接，迟到响应丢弃不动清单", async () => {
    let release: ((v: void) => void) | null = null;
    const gate = new Promise<void>((r) => (release = r));
    transport.request.mockImplementation(async () => {
      await gate;
      return ok(wsRow);
    });
    const p = useSessionsStore.getState().createWorkspace("甲");
    await flush();
    connMock.setActiveConnId("conn-a8"); // 写途中换连接（异于当前值才生效）
    release!();
    await expect(p).resolves.toBeNull();
    expect(useSessionsStore.getState().workspaces).toEqual([]);
  });
});

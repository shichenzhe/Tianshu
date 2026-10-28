import { beforeEach, describe, expect, it, vi } from "vitest";

import { ENDPOINTS } from "@tianshu/protocol";

// —— connections 层替身：activeTransport 可换 mock/null（事件总线本任务不经 store 消费）——
const connMock = vi.hoisted(() => ({
  activeTransport: vi.fn(),
}));

vi.mock("./connections.store", () => ({
  activeTransport: connMock.activeTransport,
}));

// —— sessions 层替身（P1 未读角标批）：read 上报成功后经 applyRead 同步
//  列表角标——stream.store 只依赖该出口，替身隔离会话列表语义 ——
const sessionsMock = vi.hoisted(() => ({
  applyRead: vi.fn(),
}));
vi.mock("./sessions.store", () => ({
  useSessionsStore: {
    getState: () => ({ applyRead: sessionsMock.applyRead }),
  },
}));

// —— 通知链替身（M3）：notify lib mock（react-native 不可在 node 加载）；
// notify.store 只 mock getNotifyPrefs（prefs 运行时可换）；i18n 以 key 回显 ——
const notifyMock = vi.hoisted(() => ({ notifyLocal: vi.fn() }));
vi.mock("../lib/notify", () => ({
  notifyLocal: notifyMock.notifyLocal,
  requestNotificationPermission: vi.fn(async () => true),
}));

const prefsMock = vi.hoisted(() => ({
  prefs: { enabled: true, approvals: true, graphDone: true },
}));
vi.mock("./notify.store", () => ({
  getNotifyPrefs: vi.fn(() => prefsMock.prefs),
}));

vi.mock("../i18n", () => ({ default: { t: (key: string) => key } }));

import { useStreamStore } from "./stream.store";

/** 伪 transport：只需 request */
function makeTransport() {
  return { request: vi.fn() };
}

function ok(data: unknown, status = 200) {
  return {
    status,
    body: { code: "2000", success: true, data, message: "success" },
  };
}

function biz(message: string) {
  return {
    status: 200,
    body: { code: "5000", success: false, data: null, message },
  };
}

/** getById 详情帧（messages blocks 为协议 JSON 字符串——wire 口径；
 * id 收 string 以便构造畸形行用例；modelId/durationMs 可选透传消息
 * 元信息） */
function detail(
  messages: Array<{
    id: number | string;
    role: string;
    blocks: unknown;
    modelId?: unknown;
    durationMs?: unknown;
  }>,
) {
  return {
    session: {
      id: 7,
      title: "远控会话",
      updatedAt: "2026-10-17T01:00:00.000Z",
    },
    messages: messages.map((m) => ({ ...m, blocks: JSON.stringify(m.blocks) })),
  };
}

const historyMsgs = [
  { id: 1, role: "user", blocks: [{ type: "text", text: "你好" }] },
  {
    id: 2,
    role: "assistant",
    blocks: [
      { type: "thinking", text: "想想" },
      { type: "text", text: "答复" },
      { type: "usage", input: 10, output: 20 },
    ],
  },
];

/** 微任务冲刷：loadHistory 定稿重拉为 void fire-and-forget */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function resetStore(): void {
  useStreamStore.setState({ bySession: {} });
}

describe("stream store", () => {
  let transport: ReturnType<typeof makeTransport>;

  beforeEach(() => {
    transport = makeTransport();
    connMock.activeTransport.mockReset().mockReturnValue(transport);
    sessionsMock.applyRead.mockReset();
    resetStore();
  });

  it("loadHistory：blocks JSON 字符串 parse 成数组 + sessionTitle；畸形行丢弃", async () => {
    transport.request.mockResolvedValue(
      ok(
        detail([
          ...historyMsgs,
          { id: 3, role: "assistant", blocks: "not-json" }, // 畸形 blocks → 空数组
          { id: "x", role: "user", blocks: "[]" }, // 缺 number id → 整行丢弃
        ]),
      ),
    );
    await useStreamStore.getState().loadHistory(7);

    expect(transport.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.session.getById,
      { id: 7 },
    );
    const e = useStreamStore.getState().bySession[7];
    expect(e?.sessionTitle).toBe("远控会话");
    expect(e?.history).toEqual([
      { id: 1, role: "user", blocks: [{ type: "text", text: "你好" }] },
      {
        id: 2,
        role: "assistant",
        blocks: [
          { type: "thinking", text: "想想" },
          { type: "text", text: "答复" },
          { type: "usage", input: 10, output: 20 },
        ],
      },
      { id: 3, role: "assistant", blocks: [] },
    ]);
    expect(e?.live.active).toBe(false);
    expect(e?.loading).toBe(false);
    expect(e?.loadError).toBe(false);
  });

  it("loadHistory：assistant 行 modelId/durationMs 透传（消息元信息）；缺省/畸形不携带", async () => {
    transport.request.mockResolvedValue(
      ok(
        detail([
          { id: 1, role: "user", blocks: [{ type: "text", text: "你好" }] },
          {
            id: 2,
            role: "assistant",
            blocks: [{ type: "text", text: "答复" }],
            modelId: 11,
            durationMs: 2350,
          },
          {
            id: 3,
            role: "assistant",
            blocks: [{ type: "text", text: "旧端无字段" }],
          },
          {
            id: 4,
            role: "assistant",
            blocks: [{ type: "text", text: "坏值" }],
            modelId: "x",
            durationMs: "x",
          },
        ]),
      ),
    );
    await useStreamStore.getState().loadHistory(7);

    const h = useStreamStore.getState().bySession[7]?.history ?? [];
    expect(h.find((m) => m.id === 2)?.modelId).toBe(11);
    expect(h.find((m) => m.id === 2)?.durationMs).toBe(2350);
    expect(h.find((m) => m.id === 1)?.modelId).toBeUndefined();
    expect(h.find((m) => m.id === 1)?.durationMs).toBeUndefined();
    expect(h.find((m) => m.id === 3)?.modelId).toBeUndefined();
    expect(h.find((m) => m.id === 3)?.durationMs).toBeUndefined();
    expect(h.find((m) => m.id === 4)?.modelId).toBeUndefined();
    expect(h.find((m) => m.id === 4)?.durationMs).toBeUndefined();
  });

  it("loadHistory 失败：空表置 loadError 供重试；已有历史不闪错；无连接同径", async () => {
    transport.request.mockResolvedValue(biz("会话不存在"));
    await useStreamStore.getState().loadHistory(7);
    expect(useStreamStore.getState().bySession[7]?.loadError).toBe(true);

    transport.request.mockResolvedValue(ok(detail(historyMsgs)));
    await useStreamStore.getState().loadHistory(7);
    transport.request.mockResolvedValue(biz("网络断"));
    await useStreamStore.getState().loadHistory(7);
    expect(useStreamStore.getState().bySession[7]?.loadError).toBe(false);

    connMock.activeTransport.mockReturnValue(null);
    await useStreamStore.getState().loadHistory(9);
    expect(useStreamStore.getState().bySession[9]?.loadError).toBe(true);
  });

  // —— P1 未读角标批：成功 loadHistory 后按真实消息 max(id) 上报已读 ——

  it("loadHistory 成功：取正 id max 上报 session/read；响应生效游标同步角标（applyRead）", async () => {
    transport.request.mockImplementation(async (_m: string, path: string) =>
      path === ENDPOINTS.session.getById
        ? ok(detail(historyMsgs)) // max real id = 2
        : ok({ sessionId: 7, lastReadMessageId: 2, unreadCount: 0 }),
    );
    await useStreamStore.getState().loadHistory(7);

    expect(transport.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.session.read,
      {
        sessionId: 7,
        messageId: 2,
      },
    );
    await flush(); // read 为 fire-and-forget，冲刷微任务等响应应用
    expect(sessionsMock.applyRead).toHaveBeenCalledWith(7, 0);
  });

  it("loadHistory 空历史/仅乐观负 id：无真实消息 id 不报 read", async () => {
    transport.request.mockResolvedValue(ok(detail([])));
    await useStreamStore.getState().loadHistory(7);
    expect(
      transport.request.mock.calls.filter(
        (c) => c[1] === ENDPOINTS.session.read,
      ),
    ).toHaveLength(0);
    expect(sessionsMock.applyRead).not.toHaveBeenCalled();

    // 仅乐观负 id（发送中历史）同径：负 id 不参与 max
    transport.request.mockResolvedValue(
      ok(
        detail([
          { id: -1, role: "user", blocks: [{ type: "text", text: "hi" }] },
        ]),
      ),
    );
    await useStreamStore.getState().loadHistory(7);
    expect(
      transport.request.mock.calls.filter(
        (c) => c[1] === ENDPOINTS.session.read,
      ),
    ).toHaveLength(0);
  });

  it("read 失败：不改本地已读（applyRead 不触发），下次 loadHistory 重报", async () => {
    transport.request.mockImplementation(async (_m: string, path: string) =>
      path === ENDPOINTS.session.getById
        ? ok(detail(historyMsgs))
        : biz("会话不存在"),
    );
    await useStreamStore.getState().loadHistory(7);
    await flush();
    expect(sessionsMock.applyRead).not.toHaveBeenCalled();

    // 再拉一次：read 重报（服务端单调幂等）
    transport.request.mockClear();
    await useStreamStore.getState().loadHistory(7);
    expect(transport.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.session.read,
      {
        sessionId: 7,
        messageId: 2,
      },
    );
  });

  it("read 迟到旧响应不回滚已读：lastReadMessageId 小于已上报 max 的响应丢弃", async () => {
    let persisted = historyMsgs; // 首轮 max id 2
    const readResolvers: Array<(v: unknown) => void> = [];
    transport.request.mockImplementation(async (_m: string, path: string) => {
      if (path === ENDPOINTS.session.getById) return ok(detail(persisted));
      return new Promise((res) => readResolvers.push(res)); // read 挂起手动放行
    });
    await useStreamStore.getState().loadHistory(7); // read(2) 在途
    persisted = [
      ...historyMsgs,
      { id: 4, role: "user", blocks: [{ type: "text", text: "hi" }] },
      { id: 5, role: "assistant", blocks: [{ type: "text", text: "新答复" }] },
    ];
    await useStreamStore.getState().loadHistory(7); // read(5) 在途
    expect(readResolvers).toHaveLength(2);

    // 新响应先达：游标 5 生效清角标
    readResolvers[1](
      ok({ sessionId: 7, lastReadMessageId: 5, unreadCount: 0 }),
    );
    await flush();
    expect(sessionsMock.applyRead).toHaveBeenCalledTimes(1);
    expect(sessionsMock.applyRead).toHaveBeenLastCalledWith(7, 0);

    // 旧响应迟到：游标 2 < 已上报 max 5——丢弃，不回滚出假角标
    readResolvers[0](
      ok({ sessionId: 7, lastReadMessageId: 2, unreadCount: 3 }),
    );
    await flush();
    expect(sessionsMock.applyRead).toHaveBeenCalledTimes(1);
  });

  it("startSend 受理成功：乐观消息入列 + live 开流 + sending；modelId 缺省不传", async () => {
    transport.request.mockImplementation(async (_m: string, path: string) =>
      path === ENDPOINTS.session.getById
        ? ok(detail(historyMsgs))
        : ok({ accepted: true }, 202),
    );
    await useStreamStore.getState().loadHistory(7);
    transport.request.mockClear();

    const accepted = await useStreamStore
      .getState()
      .startSend(7, "执行 echo hi");
    expect(accepted).toBe(true);
    expect(transport.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.session.send,
      {
        sessionId: 7,
        content: "执行 echo hi",
      },
    );

    const e = useStreamStore.getState().bySession[7];
    expect(e?.sending).toBe(true);
    expect(e?.live.active).toBe(true);
    expect(e?.history).toHaveLength(3);
    expect(e?.history[2].id).toBeLessThan(0);
    expect(e?.history[2].role).toBe("user");
    expect(e?.history[2].blocks).toEqual([
      { type: "text", text: "执行 echo hi" },
    ]);

    // modelId 显式传入时随 body 上送
    transport.request.mockResolvedValue(ok({ accepted: true }, 202));
    await useStreamStore.getState().startSend(7, "再来", 5);
    expect(transport.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.session.send,
      {
        sessionId: 7,
        content: "再来",
        modelId: 5,
      },
    );
  });

  it("startSend 业务错：乐观消息回滚 + 流态置错 + 解锁，返回 false", async () => {
    transport.request.mockResolvedValue(ok(detail(historyMsgs)));
    await useStreamStore.getState().loadHistory(7);
    transport.request.mockResolvedValue(biz("会话已归档"));

    const accepted = await useStreamStore.getState().startSend(7, "hi");
    expect(accepted).toBe(false);
    const e = useStreamStore.getState().bySession[7];
    expect(e?.history).toHaveLength(2); // 乐观消息已撤回
    expect(e?.sending).toBe(false);
    expect(e?.live.status).toBe("error");
    expect(e?.error).toBe("会话已归档");
  });

  it("startSend images（MB-T1）：逐张 uploadImage 得 imagePath 随 send 上行；任一失败阻断发送（裁定 2026-10-21）", async () => {
    transport.request.mockImplementation(
      async (_m: string, path: string, body: unknown) => {
        if (path === ENDPOINTS.files.uploadImage) {
          const name = (body as { name?: string }).name;
          return ok({ imagePath: `attachments/d1/${name}` });
        }
        return ok({ accepted: true }, 202);
      },
    );

    const accepted = await useStreamStore
      .getState()
      .startSend(7, "看图", undefined, [
        { name: "a.png", base64: "aGk=" },
        { name: "b.png", base64: "eW8=" },
      ]);
    expect(accepted).toBe(true);
    expect(transport.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.files.uploadImage,
      {
        name: "a.png",
        base64: "aGk=",
      },
    );
    expect(transport.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.session.send,
      {
        sessionId: 7,
        content: "看图",
        images: ["attachments/d1/a.png", "attachments/d1/b.png"],
      },
    );

    // 上传失败：阻断——send 不发、乐观消息不插、error 置位
    // （先 finish 收尾第一段流——真实时序中 sending 未解锁不可再发）
    useStreamStore.getState().applyChunk(7, { type: "finish" });
    await flush();
    transport.request.mockClear();
    transport.request.mockImplementation(
      async (_m: string, path: string, body: unknown) => {
        if (path === ENDPOINTS.files.uploadImage) {
          const name = (body as { name?: string }).name;
          if (name === "bad.png") return biz("图片超过 3MB 上限");
          return ok({ imagePath: `attachments/d1/${name}` });
        }
        return ok({ accepted: true }, 202);
      },
    );
    const blocked = await useStreamStore
      .getState()
      .startSend(7, "再看", undefined, [
        { name: "a.png", base64: "aGk=" },
        { name: "bad.png", base64: "eW8=" },
      ]);
    expect(blocked).toBe(false);
    const calls = transport.request.mock.calls.filter(
      (c) => c[1] === ENDPOINTS.session.send,
    );
    expect(calls).toHaveLength(0); // 文本未发送
    const e = useStreamStore.getState().bySession[7];
    expect(e?.error).toBeTruthy(); // 上传失败提示（含张数）
    expect(e?.sending).toBe(false);
    expect(e?.history.every((m) => m.id > 0)).toBe(true); // 无乐观消息插入
  });

  it("editAndResend（LT-T2）：乐观改写截断；受理置流态；失败回滚置错", async () => {
    // 造三行历史：user(101)/assistant(102)/user(103)
    const rows = [
      {
        id: 101,
        role: "user",
        blocks: JSON.stringify([{ type: "text", text: "原话" }]),
      },
      {
        id: 102,
        role: "assistant",
        blocks: JSON.stringify([{ type: "text", text: "答" }]),
      },
      {
        id: 103,
        role: "user",
        blocks: JSON.stringify([{ type: "text", text: "后续" }]),
      },
    ];
    transport.request.mockResolvedValue(ok(detail(rows)));
    await useStreamStore.getState().loadHistory(7);
    transport.request.mockClear();

    transport.request.mockResolvedValue(ok({ accepted: true }, 202));
    const accepted = await useStreamStore
      .getState()
      .editAndResend(7, 101, "改写后");
    expect(accepted).toBe(true);
    expect(transport.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.session.editAndResend,
      { sessionId: 7, messageId: 101, content: "改写后" },
    );
    let e = useStreamStore.getState().bySession[7];
    expect(e?.sending).toBe(true);
    // 乐观改写：101 文本换新 + 其后截断（102/103 不在）
    expect(e?.history).toHaveLength(1);
    expect(e?.history[0].blocks).toEqual([{ type: "text", text: "改写后" }]);

    // 失败回滚：先经 finish 定稿重拉回三行真历史（fire-and-forget flush）
    transport.request.mockResolvedValue(ok(detail(rows)));
    useStreamStore.getState().applyChunk(7, { type: "finish" });
    await flush();
    expect(useStreamStore.getState().bySession[7]?.history).toHaveLength(3);
    transport.request.mockResolvedValue(biz("消息不存在"));
    const rejected = await useStreamStore
      .getState()
      .editAndResend(7, 101, "再改");
    expect(rejected).toBe(false);
    e = useStreamStore.getState().bySession[7];
    expect(e?.history).toHaveLength(3);
    expect(e?.sending).toBe(false);
    expect(e?.error).toBe("消息不存在");
  });

  it("regenerate（MB-T3）：受理置流态；失败回滚置错；sending 中拒绝", async () => {
    transport.request.mockResolvedValue(ok(detail(historyMsgs)));
    await useStreamStore.getState().loadHistory(7);

    transport.request.mockResolvedValue(ok({ accepted: true }, 202));
    expect(await useStreamStore.getState().regenerate(7)).toBe(true);
    let e = useStreamStore.getState().bySession[7];
    expect(e?.sending).toBe(true);
    expect(e?.live.active).toBe(true);

    // 收尾（finish chunk）后再来一轮失败路径
    transport.request.mockResolvedValue(biz("没有可重新生成的回复"));
    useStreamStore.getState().applyChunk(7, { type: "finish" });
    expect(await useStreamStore.getState().regenerate(7)).toBe(false);
    e = useStreamStore.getState().bySession[7];
    expect(e?.sending).toBe(false);
    expect(e?.error).toBe("没有可重新生成的回复");
  });

  it("startSend 网络异常（request 抛错）：同径回滚，error 置空串供 UI 兜底", async () => {
    transport.request.mockRejectedValue(new Error("ECONNRESET"));
    const accepted = await useStreamStore.getState().startSend(7, "hi");
    expect(accepted).toBe(false);
    const e = useStreamStore.getState().bySession[7];
    expect(e?.history).toEqual([]);
    expect(e?.sending).toBe(false);
    expect(e?.error).toBe("");
  });

  it("applyChunk：增量归并进 live；未打开会话（无条目）静默丢弃", async () => {
    transport.request.mockResolvedValue(ok({ accepted: true }, 202));
    await useStreamStore.getState().startSend(7, "hi");

    useStreamStore
      .getState()
      .applyChunk(7, { type: "reasoning-delta", text: "思考" });
    useStreamStore.getState().applyChunk(7, {
      type: "tool-update",
      toolCallId: "t1",
      toolName: "run_command",
      args: { cmd: "echo hi" },
      state: "running",
    });
    useStreamStore.getState().applyChunk(7, { type: "text-delta", text: "答" });
    const e = useStreamStore.getState().bySession[7];
    expect(e?.live.thinking).toBe("思考");
    expect(e?.live.tools.t1?.state).toBe("running");
    expect(e?.live.text).toBe("答");
    expect(e?.sending).toBe(true);

    useStreamStore.getState().applyChunk(99, { type: "text-delta", text: "x" });
    expect(useStreamStore.getState().bySession[99]).toBeUndefined();
  });

  it("applyChunk finish：解锁 sending + 重拉 getById 定稿（history 覆写、live 重置）", async () => {
    let persisted = historyMsgs;
    transport.request.mockImplementation(async (_m: string, path: string) =>
      path === ENDPOINTS.session.getById
        ? ok(detail(persisted))
        : ok({ accepted: true }, 202),
    );
    await useStreamStore.getState().loadHistory(7);
    await useStreamStore.getState().startSend(7, "hi");
    useStreamStore
      .getState()
      .applyChunk(7, { type: "text-delta", text: "流式" });

    // 服务端定稿：新增 assistant 轮（含 usage）
    persisted = [
      ...historyMsgs,
      { id: 4, role: "user", blocks: [{ type: "text", text: "hi" }] },
      {
        id: 5,
        role: "assistant",
        blocks: [
          { type: "text", text: "流式完稿" },
          { type: "usage", input: 1, output: 2 },
        ],
      },
    ];
    transport.request.mockClear();
    useStreamStore.getState().applyChunk(7, { type: "finish" });

    expect(transport.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.session.getById,
      { id: 7 },
    );
    await flush();
    const e = useStreamStore.getState().bySession[7];
    expect(e?.sending).toBe(false);
    expect(e?.history).toHaveLength(4); // 覆写为服务端真值（乐观负 id 消失）
    expect(e?.live.text).toBe(""); // live 重置
    expect(e?.live.toolOrder).toEqual([]);
  });

  it("applyChunk error chunk：置错 + 解锁 + 定稿重拉；error 文案留存", async () => {
    transport.request.mockImplementation(async (_m: string, path: string) =>
      path === ENDPOINTS.session.getById
        ? ok(detail(historyMsgs))
        : ok({ accepted: true }, 202),
    );
    await useStreamStore.getState().loadHistory(7);
    await useStreamStore.getState().startSend(7, "hi");
    transport.request.mockClear();

    useStreamStore.getState().applyChunk(7, {
      type: "error",
      errorCode: "PROVIDER_ERROR",
      message: "供应商请求失败",
    });
    expect(useStreamStore.getState().bySession[7]?.sending).toBe(false);
    expect(useStreamStore.getState().bySession[7]?.error).toBe(
      "供应商请求失败",
    );
    expect(transport.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.session.getById,
      { id: 7 },
    );
  });

  it("applySessionError：置错收尾不重拉（被拒轮次服务端不落库）；乐观消息滤除（fix1）", async () => {
    transport.request.mockResolvedValue(ok({ accepted: true }, 202));
    await useStreamStore.getState().startSend(7, "hi");
    expect(useStreamStore.getState().bySession[7]?.history).toHaveLength(1); // 乐观在列
    transport.request.mockClear();

    useStreamStore.getState().applySessionError(7, "会话已有进行中的请求");
    const e = useStreamStore.getState().bySession[7];
    expect(e?.sending).toBe(false);
    expect(e?.live.status).toBe("error");
    expect(e?.live.errorMessage).toBe("会话已有进行中的请求");
    expect(e?.history).toEqual([]); // 守卫先于用户消息落库——被拒轮次乐观为假，滤除
    expect(e?.history.every((m) => m.id >= 0)).toBe(true);
    expect(transport.request).not.toHaveBeenCalled();

    // finish 清残留 error（前轮失败不再悬挂横幅）
    transport.request.mockResolvedValue(ok(detail(historyMsgs)));
    useStreamStore.getState().applyChunk(7, { type: "finish" });
    await flush();
    expect(useStreamStore.getState().bySession[7]?.error).toBeNull();
  });

  it("handleTransportDown：sending 中置错解锁（乐观保留）；非发送态/无条目无操作（fix1）", async () => {
    // 无条目不炸
    useStreamStore.getState().handleTransportDown(99, "连接中断");

    transport.request.mockResolvedValue(ok({ accepted: true }, 202));
    await useStreamStore.getState().startSend(7, "hi");
    transport.request.mockClear();

    useStreamStore.getState().handleTransportDown(7, "连接中断");
    let e = useStreamStore.getState().bySession[7];
    expect(e?.sending).toBe(false);
    expect(e?.live.status).toBe("error");
    expect(e?.live.errorMessage).toBe("连接中断");
    expect(e?.error).toBe("连接中断");
    expect(e?.history).toHaveLength(1); // 已受理：乐观保留，重连重拉对齐真值

    // 非发送态：不覆写既有 error（无关掉线不污染展示）
    useStreamStore.getState().handleTransportDown(7, "再断");
    e = useStreamStore.getState().bySession[7];
    expect(e?.error).toBe("连接中断");
    expect(transport.request).not.toHaveBeenCalled(); // 不重拉
  });

  it("loadHistory 在 sending 中：保留 live/sending（挂载竞态守卫）", async () => {
    transport.request.mockResolvedValue(ok({ accepted: true }, 202));
    await useStreamStore.getState().startSend(7, "hi");
    useStreamStore.getState().applyChunk(7, { type: "text-delta", text: "流" });

    transport.request.mockResolvedValue(ok(detail(historyMsgs)));
    await useStreamStore.getState().loadHistory(7);
    const e = useStreamStore.getState().bySession[7];
    expect(e?.sending).toBe(true);
    expect(e?.live.text).toBe("流");
  });

  it("abort：POST session/abort 即发不等回包", async () => {
    transport.request.mockResolvedValue(ok({ accepted: true }, 202));
    await useStreamStore.getState().startSend(7, "hi");
    transport.request.mockClear();

    useStreamStore.getState().abort(7);
    expect(transport.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.session.abort,
      {
        sessionId: 7,
      },
    );
    expect(useStreamStore.getState().bySession[7]?.sending).toBe(true); // finish chunk 兜底解锁
  });

  it("clear：条目移除，在途 loadHistory 迟到响应不得复活", async () => {
    let resolveReq!: (v: unknown) => void;
    transport.request.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveReq = res;
        }),
    );
    const pending = useStreamStore.getState().loadHistory(7);
    useStreamStore.getState().clear(7);
    expect(useStreamStore.getState().bySession[7]).toBeUndefined();

    resolveReq(ok(detail(historyMsgs)));
    await pending;
    await flush();
    expect(useStreamStore.getState().bySession[7]).toBeUndefined(); // 时序令牌作废
  });

  it("applyChunk approval-request：新审批（队列无同 id）触发一次后台通知，同 id 重发不重复", async () => {
    notifyMock.notifyLocal.mockClear();
    transport.request.mockResolvedValue(ok({ accepted: true }, 202));
    await useStreamStore.getState().startSend(7, "hi");

    useStreamStore.getState().applyChunk(7, {
      type: "approval-request",
      toolCallId: "t1",
      toolName: "run_command",
      argSummary: "echo hi",
    });
    expect(notifyMock.notifyLocal).toHaveBeenCalledTimes(1);
    expect(notifyMock.notifyLocal).toHaveBeenCalledWith({
      title: "notify:approvalTitle",
      body: "run_command",
    });

    // 同 id 重发仅刷新摘要（enqueueApproval 语义）——不再打扰
    useStreamStore.getState().applyChunk(7, {
      type: "approval-request",
      toolCallId: "t1",
      toolName: "run_command",
      argSummary: "echo hi（重发）",
    });
    expect(notifyMock.notifyLocal).toHaveBeenCalledTimes(1);
  });

  it("applyChunk approval-request：prefs 关（enabled 或 approvals 任一关）不触发通知", async () => {
    notifyMock.notifyLocal.mockClear();
    transport.request.mockResolvedValue(ok({ accepted: true }, 202));
    await useStreamStore.getState().startSend(7, "hi");

    prefsMock.prefs = { enabled: false, approvals: true, graphDone: true };
    useStreamStore.getState().applyChunk(7, {
      type: "approval-request",
      toolCallId: "a",
      toolName: "run_command",
      argSummary: "x",
    });

    prefsMock.prefs = { enabled: true, approvals: false, graphDone: true };
    useStreamStore.getState().applyChunk(7, {
      type: "approval-request",
      toolCallId: "b",
      toolName: "run_command",
      argSummary: "x",
    });

    expect(notifyMock.notifyLocal).not.toHaveBeenCalled();
    // 恢复默认，避免影响后续用例
    prefsMock.prefs = { enabled: true, approvals: true, graphDone: true };
  });

  it("applyChunk approval-request：idle entry（live.active=false）上的审批 chunk 不触发通知（M4，与 UI 展示对齐）", async () => {
    notifyMock.notifyLocal.mockClear();
    // 仅 loadHistory 建条目（live 保持 idle）——未 startSend，无进行中流
    transport.request.mockResolvedValue(ok(detail(historyMsgs)));
    await useStreamStore.getState().loadHistory(7);
    expect(useStreamStore.getState().bySession[7]?.live.active).toBe(false);

    useStreamStore.getState().applyChunk(7, {
      type: "approval-request",
      toolCallId: "t1",
      toolName: "run_command",
      argSummary: "echo hi",
    });
    expect(notifyMock.notifyLocal).not.toHaveBeenCalled();

    // 对照：startSend 后（live.active=true）同 chunk 恢复通知
    transport.request.mockResolvedValue(ok({ accepted: true }, 202));
    await useStreamStore.getState().startSend(7, "hi");
    useStreamStore.getState().applyChunk(7, {
      type: "approval-request",
      toolCallId: "t2",
      toolName: "run_command",
      argSummary: "echo hi",
    });
    expect(notifyMock.notifyLocal).toHaveBeenCalledTimes(1);
  });
});

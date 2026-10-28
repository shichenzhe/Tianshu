import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENDPOINTS } from "@tianshu/protocol";

const connMock = vi.hoisted(() => ({
  activeTransport: vi.fn(),
  activeConnId: "c1" as string | null,
  transport: null as null | { request: ReturnType<typeof vi.fn> },
  useConnectionsStore: {
    getState: () => ({
      activeConnId: connMock.activeConnId,
      capabilitiesByConn: connMock.activeConnId
        ? { [connMock.activeConnId]: ["chat", "assistant"] }
        : {},
    }),
    subscribe: () => () => {},
  },
}));

vi.mock("./connections.store", () => ({
  activeTransport: connMock.activeTransport,
  useConnectionsStore: connMock.useConnectionsStore,
}));

import { useExpertsStore } from "./experts.store";

function makeTransport() {
  return { request: vi.fn() };
}

function successBody(data: unknown) {
  return {
    status: 200,
    body: { code: "2000", success: true, data, message: "success" },
  };
}

function failureBody(code: string, message: string) {
  return { status: 200, body: { code, success: false, data: null, message } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const MINE_ROW = {
  id: 1,
  name: "翻译专家",
  description: "中英互译",
  icon: "🌐",
  profession: "翻译",
};

const DETAIL = {
  id: 1,
  name: "翻译专家",
  icon: "🌐",
  systemPrompt: "你是翻译专家",
  builtin: false,
  description: "中英互译",
  tags: ["翻译"],
  profession: "翻译",
  quickPrompts: ["翻译这段"],
  temperature: 0.3,
  topP: 0.9,
  maxTokens: 2048,
  expertType: "agent",
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
};

const MARKET_SUMMARY = {
  slug: "translator-pro",
  name: "专业翻译",
  description: "专业级中英互译",
  profession: "翻译",
  tags: ["翻译", "写作"],
  categoryId: "writing",
  isTeam: false,
  // 体验精修批契约增量：排序三档字段 + 分类名 i18n 键
  score: 9.5,
  downloads: 120,
  createdAt: "2026-10-20T00:00:00.000Z",
  categoryTitleKey: "contentCreative",
};

const MARKET_DETAIL = {
  ...MARKET_SUMMARY,
  icon: "🈶",
  systemPrompt: "你是专业翻译",
  temperature: 0.2,
  quickPrompts: ["润色"],
  skillNames: ["grammar"],
};

describe("experts.store", () => {
  beforeEach(() => {
    connMock.activeTransport.mockReset();
    connMock.activeConnId = "c1";
    connMock.transport = null;
    connMock.activeTransport.mockImplementation(() => connMock.transport);
    useExpertsStore.getState().resetForTest();
  });

  it("loadMine 走 assistant/query 并解析行", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody([MINE_ROW]));
    connMock.activeTransport.mockReturnValue(t);
    await useExpertsStore.getState().loadMine();
    const s = useExpertsStore.getState();
    expect(s.mine).toHaveLength(1);
    expect(s.mine[0].name).toBe("翻译专家");
    expect(s.initialized).toBe(true);
    expect(t.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.assistant.query,
      null,
    );
  });

  it("loadDetail 走 assistant/detail 透传全量字段", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody(DETAIL));
    connMock.activeTransport.mockReturnValue(t);
    const detail = await useExpertsStore.getState().loadDetail(1);
    expect(t.request).toHaveBeenCalledWith("POST", ENDPOINTS.assistant.detail, {
      id: 1,
    });
    expect(detail?.systemPrompt).toBe("你是翻译专家");
    expect(detail?.builtin).toBe(false);
    expect(detail?.temperature).toBe(0.3);
  });

  it("loadDetail 业务错置 error（code 优先）并返回 null", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(failureBody("ASSISTANT_NOT_FOUND", "不存在"));
    connMock.activeTransport.mockReturnValue(t);
    const detail = await useExpertsStore.getState().loadDetail(99);
    expect(detail).toBeNull();
    expect(useExpertsStore.getState().error).toBe("ASSISTANT_NOT_FOUND");
  });

  it("save 三态载荷透传 assistant/save 且写后重拉列表", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody(null));
    connMock.activeTransport.mockReturnValue(t);
    const payload = {
      id: 1,
      name: "新名字",
      temperature: null,
      description: undefined,
      quickPrompts: ["a"],
    };
    const ok = await useExpertsStore.getState().save(payload);
    expect(ok).toBe(true);
    const writeCall = t.request.mock.calls.find(
      (call) => call[1] === ENDPOINTS.assistant.save,
    );
    expect(writeCall).toBeDefined();
    expect(writeCall?.[2]).toEqual(payload);
    // 写后重拉 mine
    const listCall = t.request.mock.calls.find(
      (call) => call[1] === ENDPOINTS.assistant.query,
    );
    expect(listCall).toBeDefined();
  });

  it("remove 走 assistant/delete 且写后重拉", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody(null));
    connMock.activeTransport.mockReturnValue(t);
    const ok = await useExpertsStore.getState().remove(1);
    expect(ok).toBe(true);
    expect(t.request).toHaveBeenCalledWith("POST", ENDPOINTS.assistant.delete, {
      id: 1,
    });
  });

  it("写面串行：第一个写完成前第二个不发请求", async () => {
    const t = makeTransport();
    connMock.activeTransport.mockReturnValue(t);
    const firstResponse = deferred<unknown>();
    const secondResponse = deferred<unknown>();
    t.request
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise);
    const first = useExpertsStore.getState().remove(1);
    const second = useExpertsStore.getState().remove(2);
    await Promise.resolve();
    expect(t.request).toHaveBeenCalledTimes(1);
    firstResponse.resolve(successBody(null));
    await first;
    await Promise.resolve();
    expect(t.request).toHaveBeenCalledTimes(2);
    secondResponse.resolve(successBody(null));
    await second;
    expect(useExpertsStore.getState().saving).toBe(false);
  });

  it("无连接时不发请求且写面返回 false", async () => {
    const t = makeTransport();
    connMock.activeTransport.mockReturnValue(t);
    connMock.activeConnId = null;
    await useExpertsStore.getState().loadMine();
    const ok = await useExpertsStore.getState().remove(1);
    expect(t.request).not.toHaveBeenCalled();
    expect(ok).toBe(false);
    expect(useExpertsStore.getState().initialized).toBe(false);
  });

  it("切连接后丢弃旧主机迟到的 loadMine 响应", async () => {
    const transportA = makeTransport();
    const transportB = makeTransport();
    const responseA = deferred<unknown>();
    const responseB = deferred<unknown>();
    transportA.request.mockReturnValue(responseA.promise);
    transportB.request.mockReturnValue(responseB.promise);
    connMock.transport = transportA;
    const loadA = useExpertsStore.getState().loadMine();
    connMock.activeConnId = "c2";
    connMock.transport = transportB;
    const loadB = useExpertsStore.getState().loadMine();
    responseB.resolve(successBody([{ ...MINE_ROW, name: "B专家" }]));
    await loadB;
    responseA.resolve(successBody([MINE_ROW]));
    await loadA;
    expect(useExpertsStore.getState().mine[0]?.name).toBe("B专家");
  });

  it("loadMarket 走 assistant/marketList 且解析概要", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody([MARKET_SUMMARY]));
    connMock.activeTransport.mockReturnValue(t);
    await useExpertsStore.getState().loadMarket();
    const s = useExpertsStore.getState();
    expect(s.marketList).toHaveLength(1);
    expect(s.marketList[0].slug).toBe("translator-pro");
    expect(s.marketInitialized).toBe(true);
    expect(t.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.assistant.marketList,
      null,
    );
  });

  it("loadMarket 解析排序三档字段与分类名 i18n 键（契约增量透传）", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody([MARKET_SUMMARY]));
    connMock.activeTransport.mockReturnValue(t);
    await useExpertsStore.getState().loadMarket();
    const item = useExpertsStore.getState().marketList[0];
    expect(item.score).toBe(9.5);
    expect(item.downloads).toBe(120);
    expect(item.createdAt).toBe("2026-10-20T00:00:00.000Z");
    expect(item.categoryTitleKey).toBe("contentCreative");
  });

  it("loadMarket 旧被控端未下发新字段仍解析（回退 undefined）", async () => {
    const t = makeTransport();
    // 旧端形态：无排序三档字段与分类名 i18n 键
    const legacy = {
      slug: "translator-pro",
      name: "专业翻译",
      description: "专业级中英互译",
      profession: "翻译",
      tags: ["翻译", "写作"],
      categoryId: "writing",
      isTeam: false,
    };
    t.request.mockResolvedValue(successBody([legacy]));
    connMock.activeTransport.mockReturnValue(t);
    await useExpertsStore.getState().loadMarket();
    const item = useExpertsStore.getState().marketList[0];
    expect(item.slug).toBe("translator-pro");
    expect(item.score).toBeUndefined();
    expect(item.downloads).toBeUndefined();
    expect(item.createdAt).toBeUndefined();
    expect(item.categoryTitleKey).toBeUndefined();
  });

  it("loadMarketDetail 走 assistant/marketDetail 且含全文字段", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody(MARKET_DETAIL));
    connMock.activeTransport.mockReturnValue(t);
    const detail = await useExpertsStore
      .getState()
      .loadMarketDetail("translator-pro");
    expect(t.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.assistant.marketDetail,
      { slug: "translator-pro" },
    );
    expect(detail?.systemPrompt).toBe("你是专业翻译");
    expect(detail?.temperature).toBe(0.2);
  });

  it("installFromMarket = marketDetail 取全文 → assistant/save 新建", async () => {
    const t = makeTransport();
    t.request.mockImplementation((_m: string, path: string) => {
      if (path === ENDPOINTS.assistant.marketDetail) {
        return Promise.resolve(successBody(MARKET_DETAIL));
      }
      return Promise.resolve(successBody(null));
    });
    connMock.activeTransport.mockReturnValue(t);
    const ok = await useExpertsStore
      .getState()
      .installFromMarket("translator-pro");
    expect(ok).toBe(true);
    const saveCall = t.request.mock.calls.find(
      (call) => call[1] === ENDPOINTS.assistant.save,
    );
    expect(saveCall?.[2]).toMatchObject({
      name: "专业翻译",
      systemPrompt: "你是专业翻译",
      temperature: 0.2,
      profession: "翻译",
      categoryId: "writing",
      // 市场来源回填（体验精修批契约增量）
      sourceSlug: "translator-pro",
    });
    expect(saveCall?.[2]).not.toHaveProperty("id");
    // 新建后重拉我的列表
    const listCall = t.request.mock.calls.find(
      (call) => call[1] === ENDPOINTS.assistant.query,
    );
    expect(listCall).toBeDefined();
  });

  it("installFromMarket 团队模板带 expertType/members", async () => {
    const t = makeTransport();
    const teamDetail = {
      ...MARKET_DETAIL,
      isTeam: true,
      members: [
        {
          id: "m1",
          name: "成员一",
          profession: "写作",
          systemPrompt: "你是写手",
        },
      ],
    };
    t.request.mockImplementation((_m: string, path: string) => {
      if (path === ENDPOINTS.assistant.marketDetail) {
        return Promise.resolve(successBody(teamDetail));
      }
      return Promise.resolve(successBody(null));
    });
    connMock.activeTransport.mockReturnValue(t);
    const ok = await useExpertsStore
      .getState()
      .installFromMarket("translator-pro");
    expect(ok).toBe(true);
    const saveCall = t.request.mock.calls.find(
      (call) => call[1] === ENDPOINTS.assistant.save,
    );
    expect(saveCall?.[2]).toMatchObject({
      expertType: "team",
      members: [
        {
          id: "m1",
          name: "成员一",
          profession: "写作",
          systemPrompt: "你是写手",
        },
      ],
    });
  });

  it("installFromMarket 详情失败短路不触碰 save", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(
      failureBody("EXPERT_MARKET_NOT_FOUND", "市场条目不存在"),
    );
    connMock.activeTransport.mockReturnValue(t);
    const ok = await useExpertsStore.getState().installFromMarket("missing");
    expect(ok).toBe(false);
    expect(
      t.request.mock.calls.some((call) => call[1] === ENDPOINTS.assistant.save),
    ).toBe(false);
  });

  it("并行 loadMine+loadMarket 两都完成且各自 loading 复位（跨资源不过期）", async () => {
    const t = makeTransport();
    connMock.activeTransport.mockReturnValue(t);
    const mineResponse = deferred<unknown>();
    const marketResponse = deferred<unknown>();
    t.request.mockImplementation((_m: string, path: string) => {
      if (path === ENDPOINTS.assistant.query) return mineResponse.promise;
      if (path === ENDPOINTS.assistant.marketList)
        return marketResponse.promise;
      return Promise.resolve(successBody(null));
    });
    const loadMine = useExpertsStore.getState().loadMine();
    const loadMarket = useExpertsStore.getState().loadMarket();
    // 市场先回（旧全局 reqSeq 下 mine token 已过期：响应丢弃+finally
    // 不复位 loading——「我的」永久转圈）
    marketResponse.resolve(successBody([MARKET_SUMMARY]));
    await loadMarket;
    expect(useExpertsStore.getState().marketList).toHaveLength(1);
    expect(useExpertsStore.getState().marketLoading).toBe(false);
    mineResponse.resolve(successBody([MINE_ROW]));
    await loadMine;
    const s = useExpertsStore.getState();
    expect(s.mine).toHaveLength(1);
    expect(s.loading).toBe(false);
    expect(s.initialized).toBe(true);
    expect(s.marketInitialized).toBe(true);
  });

  it("同资源内后发仍使先发过期（mine 面防迟到语义保留）", async () => {
    const t = makeTransport();
    connMock.activeTransport.mockReturnValue(t);
    const firstResponse = deferred<unknown>();
    const secondResponse = deferred<unknown>();
    t.request
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise);
    const first = useExpertsStore.getState().loadMine();
    const second = useExpertsStore.getState().loadMine();
    secondResponse.resolve(successBody([{ ...MINE_ROW, name: "新专家" }]));
    await second;
    firstResponse.resolve(successBody([MINE_ROW]));
    await first;
    expect(useExpertsStore.getState().mine[0]?.name).toBe("新专家");
    expect(useExpertsStore.getState().loading).toBe(false);
  });

  it("exportExpert 走 assistant/export 并透出 json 文本", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(
      successBody({ json: '{"kind":"tianshu-expert"}' }),
    );
    connMock.activeTransport.mockReturnValue(t);
    const json = await useExpertsStore.getState().exportExpert(1);
    expect(t.request).toHaveBeenCalledWith("POST", ENDPOINTS.assistant.export, {
      id: 1,
    });
    expect(json).toBe('{"kind":"tianshu-expert"}');
  });

  it("exportExpert 出参缺 json 置 error 并返回 null", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody({}));
    connMock.activeTransport.mockReturnValue(t);
    const json = await useExpertsStore.getState().exportExpert(1);
    expect(json).toBeNull();
    expect(useExpertsStore.getState().error).toBe(
      "Invalid assistant export response",
    );
  });

  it("exportExpert 业务错置 error（code 优先）并返回 null", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(failureBody("ASSISTANT_NOT_FOUND", "不存在"));
    connMock.activeTransport.mockReturnValue(t);
    const json = await useExpertsStore.getState().exportExpert(99);
    expect(json).toBeNull();
    expect(useExpertsStore.getState().error).toBe("ASSISTANT_NOT_FOUND");
  });

  it("importExpert 走 assistant/import 透传 json 且成功后重拉列表", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody(null));
    connMock.activeTransport.mockReturnValue(t);
    const payload = '{"kind":"tianshu-expert","version":1,"name":"翻译"}';
    const ok = await useExpertsStore.getState().importExpert(payload);
    expect(ok).toBe(true);
    const importCall = t.request.mock.calls.find(
      (call) => call[1] === ENDPOINTS.assistant.import,
    );
    expect(importCall?.[2]).toEqual({ json: payload });
    // 成功后重拉 mine
    const listCall = t.request.mock.calls.find(
      (call) => call[1] === ENDPOINTS.assistant.query,
    );
    expect(listCall).toBeDefined();
  });

  it("importExpert 失败不动列表（不重拉、mine 保持原值）", async () => {
    const t = makeTransport();
    t.request.mockImplementation((_m: string, path: string) => {
      if (path === ENDPOINTS.assistant.query) {
        return Promise.resolve(successBody([MINE_ROW]));
      }
      return Promise.resolve(failureBody("ASSISTANT_INVALID", "格式不正确"));
    });
    connMock.activeTransport.mockReturnValue(t);
    await useExpertsStore.getState().loadMine();
    const before = useExpertsStore.getState().mine;
    const ok = await useExpertsStore.getState().importExpert("{}");
    expect(ok).toBe(false);
    // 失败路径不触发第二次 query（仅 loadMine 那一次）
    const listCalls = t.request.mock.calls.filter(
      (call) => call[1] === ENDPOINTS.assistant.query,
    );
    expect(listCalls).toHaveLength(1);
    expect(useExpertsStore.getState().mine).toBe(before);
    expect(useExpertsStore.getState().error).toBe("ASSISTANT_INVALID");
  });

  it("importExpert 写面串行：入 enqueueWrite 队列（首个写完成前不发）", async () => {
    const t = makeTransport();
    connMock.activeTransport.mockReturnValue(t);
    const firstResponse = deferred<unknown>();
    const secondResponse = deferred<unknown>();
    t.request
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise);
    const first = useExpertsStore.getState().importExpert("{}");
    const second = useExpertsStore.getState().remove(2);
    await Promise.resolve();
    expect(t.request).toHaveBeenCalledTimes(1);
    expect(t.request.mock.calls[0][1]).toBe(ENDPOINTS.assistant.import);
    firstResponse.resolve(successBody(null));
    await first;
    await Promise.resolve();
    expect(t.request).toHaveBeenCalledTimes(2);
    secondResponse.resolve(successBody(null));
    await second;
    expect(useExpertsStore.getState().saving).toBe(false);
  });

  it("exportExpert 切连接后丢弃旧主机迟到的响应", async () => {
    const transportA = makeTransport();
    const transportB = makeTransport();
    const responseA = deferred<unknown>();
    const responseB = deferred<unknown>();
    transportA.request.mockReturnValue(responseA.promise);
    transportB.request.mockReturnValue(responseB.promise);
    connMock.transport = transportA;
    const exportA = useExpertsStore.getState().exportExpert(1);
    connMock.activeConnId = "c2";
    connMock.transport = transportB;
    const exportB = useExpertsStore.getState().exportExpert(2);
    responseB.resolve(successBody({ json: "B-json" }));
    await expect(exportB).resolves.toBe("B-json");
    responseA.resolve(successBody({ json: "A-json" }));
    await expect(exportA).resolves.toBeNull();
  });
});

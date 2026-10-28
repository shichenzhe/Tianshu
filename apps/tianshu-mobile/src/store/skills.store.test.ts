import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENDPOINTS } from "@tianshu/protocol";

const connMock = vi.hoisted(() => ({
  activeTransport: vi.fn(),
  activeConnId: "c1" as string | null,
  capabilities: ["chat", "skillhub"] as string[] | null,
  transport: null as null | { request: ReturnType<typeof vi.fn> },
  useConnectionsStore: {
    getState: () => ({
      activeConnId: connMock.activeConnId,
      capabilitiesByConn: connMock.activeConnId
        ? { [connMock.activeConnId]: connMock.capabilities }
        : {},
    }),
    subscribe: () => () => {},
  },
}));

vi.mock("./connections.store", () => ({
  activeTransport: connMock.activeTransport,
  useConnectionsStore: connMock.useConnectionsStore,
}));

import { useSkillsStore } from "./skills.store";

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

const SKILL_ROW = {
  name: "grammar",
  enabled: true,
  scenarios: ["daily", "coding"],
  source: "skillhub",
  builtin: false,
};

const HUB_SKILL = {
  slug: "grammar",
  name: "语法检查",
  description: "Grammar check",
  description_zh: "语法检查",
  iconUrl: null,
  category: "writing",
  version: "1.0.0",
  downloads: 100,
  stars: 5,
  score: 9.5,
  source: "skillhub",
};

describe("skills.store", () => {
  beforeEach(() => {
    connMock.activeTransport.mockReset();
    connMock.activeConnId = "c1";
    connMock.capabilities = ["chat", "skillhub"];
    connMock.transport = null;
    connMock.activeTransport.mockImplementation(() => connMock.transport);
    useSkillsStore.getState().resetForTest();
  });

  it("load 走 skills/query 并解析扩展概要（场景/来源/内置）", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody([SKILL_ROW]));
    connMock.activeTransport.mockReturnValue(t);
    await useSkillsStore.getState().load();
    const s = useSkillsStore.getState();
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].scenarios).toEqual(["daily", "coding"]);
    expect(s.rows[0].builtin).toBe(false);
    expect(s.initialized).toBe(true);
    expect(t.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.skills.query,
      null,
    );
  });

  it("load 忽略非法场景值整行过滤", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(
      successBody([{ ...SKILL_ROW, scenarios: ["daily", "bogus"] }]),
    );
    connMock.activeTransport.mockReturnValue(t);
    await useSkillsStore.getState().load();
    expect(useSkillsStore.getState().rows).toHaveLength(0);
  });

  it("readContent 走 skills/read 解包 content", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody({ content: "# 技能正文" }));
    connMock.activeTransport.mockReturnValue(t);
    await expect(
      useSkillsStore.getState().readContent("grammar"),
    ).resolves.toBe("# 技能正文");
    expect(t.request).toHaveBeenCalledWith("POST", ENDPOINTS.skills.read, {
      name: "grammar",
    });
    t.request.mockResolvedValue(failureBody("SKILL_NOT_FOUND", "不存在"));
    await expect(useSkillsStore.getState().readContent("x")).rejects.toThrow(
      "不存在",
    );
  });

  it("setScenarios 走 skills/setScenarios 且写后重拉列表", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody(null));
    connMock.activeTransport.mockReturnValue(t);
    const ok = await useSkillsStore
      .getState()
      .setScenarios("grammar", ["coding"]);
    expect(ok).toBe(true);
    const writeCall = t.request.mock.calls.find(
      (call) => call[1] === ENDPOINTS.skills.setScenarios,
    );
    expect(writeCall?.[2]).toEqual({ name: "grammar", scenarios: ["coding"] });
    const listCall = t.request.mock.calls.find(
      (call) => call[1] === ENDPOINTS.skills.query,
    );
    expect(listCall).toBeDefined();
  });

  it("uninstall 走 skills/uninstall 且写后重拉", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody(null));
    connMock.activeTransport.mockReturnValue(t);
    const ok = await useSkillsStore.getState().uninstall("grammar");
    expect(ok).toBe(true);
    expect(t.request).toHaveBeenCalledWith("POST", ENDPOINTS.skills.uninstall, {
      name: "grammar",
    });
  });

  it("写面串行：builtin 拒错（SKILL_BUILTIN）置 error 且不重拉", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(
      failureBody("SKILL_BUILTIN", "内置技能不可卸载"),
    );
    connMock.activeTransport.mockReturnValue(t);
    const ok = await useSkillsStore.getState().uninstall("builtin-skill");
    expect(ok).toBe(false);
    expect(useSkillsStore.getState().error).toBe("SKILL_BUILTIN");
    expect(
      t.request.mock.calls.some((call) => call[1] === ENDPOINTS.skills.query),
    ).toBe(false);
  });

  it("写面串行且旧写完成不提前清除 saving", async () => {
    const t = makeTransport();
    connMock.activeTransport.mockReturnValue(t);
    const firstResponse = deferred<unknown>();
    const secondResponse = deferred<unknown>();
    t.request
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise);
    const first = useSkillsStore.getState().uninstall("a");
    const second = useSkillsStore.getState().uninstall("b");
    await Promise.resolve();
    expect(t.request).toHaveBeenCalledTimes(1);
    expect(useSkillsStore.getState().saving).toBe(true);
    firstResponse.resolve(successBody(null));
    await first;
    await Promise.resolve();
    expect(t.request).toHaveBeenCalledTimes(2);
    secondResponse.resolve(successBody(null));
    await second;
    expect(useSkillsStore.getState().saving).toBe(false);
  });

  it("切连接后丢弃旧主机迟到的 load 响应", async () => {
    const transportA = makeTransport();
    const transportB = makeTransport();
    const responseA = deferred<unknown>();
    const responseB = deferred<unknown>();
    transportA.request.mockReturnValue(responseA.promise);
    transportB.request.mockReturnValue(responseB.promise);
    connMock.transport = transportA;
    const loadA = useSkillsStore.getState().load();
    connMock.activeConnId = "c2";
    connMock.transport = transportB;
    const loadB = useSkillsStore.getState().load();
    responseB.resolve(successBody([{ ...SKILL_ROW, name: "skill-b" }]));
    await loadB;
    responseA.resolve(successBody([SKILL_ROW]));
    await loadA;
    expect(useSkillsStore.getState().rows[0]?.name).toBe("skill-b");
  });

  it("连发 loadCategories→loadMarketTop→load 跨资源互不阻塞（市场/已装 loading 均复位）", async () => {
    const t = makeTransport();
    connMock.activeTransport.mockReturnValue(t);
    const categoriesResponse = deferred<unknown>();
    const topResponse = deferred<unknown>();
    const queryResponse = deferred<unknown>();
    const statsResponse = deferred<unknown>();
    t.request.mockImplementation((_m: string, path: string) => {
      if (path === ENDPOINTS.skillhub.categories)
        return categoriesResponse.promise;
      if (path === ENDPOINTS.skillhub.top) return topResponse.promise;
      if (path === ENDPOINTS.skills.query) return queryResponse.promise;
      if (path === ENDPOINTS.skills.stats) return statsResponse.promise;
      return Promise.resolve(successBody(null));
    });
    // SkillHubSection 首屏链：依次发出但响应乱序返回
    const loadCategories = useSkillsStore.getState().loadCategories();
    const loadMarketTop = useSkillsStore.getState().loadMarketTop();
    const load = useSkillsStore.getState().load();
    categoriesResponse.resolve(
      successBody([
        { key: "writing", name: "写作", nameEn: "Writing", sortOrder: 1 },
      ]),
    );
    await loadCategories;
    expect(useSkillsStore.getState().categories).toHaveLength(1);
    queryResponse.resolve(successBody([SKILL_ROW]));
    await load;
    // load 成功后顺带 loadStats 推进旧全局 reqSeq——旧语义下此处
    // marketLoading/loading 均被 finally 防迟到挡下不复位（永久转圈）
    expect(useSkillsStore.getState().loading).toBe(false);
    topResponse.resolve(successBody([HUB_SKILL]));
    await loadMarketTop;
    const s = useSkillsStore.getState();
    expect(s.marketItems).toHaveLength(1);
    expect(s.marketLoading).toBe(false);
    statsResponse.resolve(successBody([]));
    await Promise.resolve();
    expect(s.initialized).toBe(true);
  });

  it("同资源内后发仍使先发过期（market 面防迟到语义保留）", async () => {
    const t = makeTransport();
    connMock.activeTransport.mockReturnValue(t);
    const firstResponse = deferred<unknown>();
    const secondResponse = deferred<unknown>();
    t.request
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise);
    const first = useSkillsStore.getState().loadMarketTop();
    const second = useSkillsStore.getState().loadMarketTop();
    secondResponse.resolve(successBody([{ ...HUB_SKILL, slug: "newer" }]));
    await second;
    firstResponse.resolve(successBody([HUB_SKILL]));
    await first;
    expect(useSkillsStore.getState().marketItems[0]?.slug).toBe("newer");
    expect(useSkillsStore.getState().marketLoading).toBe(false);
  });

  it("loadCategories 走 skillhub/categories", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(
      successBody([
        { key: "writing", name: "写作", nameEn: "Writing", sortOrder: 1 },
      ]),
    );
    connMock.activeTransport.mockReturnValue(t);
    await useSkillsStore.getState().loadCategories();
    expect(useSkillsStore.getState().categories).toHaveLength(1);
    expect(t.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.skillhub.categories,
      null,
    );
  });

  it("loadMarketTop 走 skillhub/top 替换浏览态", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody([HUB_SKILL]));
    connMock.activeTransport.mockReturnValue(t);
    await useSkillsStore.getState().loadMarketTop();
    const s = useSkillsStore.getState();
    expect(s.marketItems).toHaveLength(1);
    expect(s.marketTotal).toBe(1);
    expect(t.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.skillhub.top,
      null,
    );
  });

  it("searchMarket 走 skillhub/list 带过滤参数；翻页追加", async () => {
    const t = makeTransport();
    const page1 = Array.from({ length: 20 }, (_, i) => ({
      ...HUB_SKILL,
      slug: `grammar-${i}`,
    }));
    const page2 = Array.from({ length: 20 }, (_, i) => ({
      ...HUB_SKILL,
      slug: `grammar-x${i}`,
    }));
    t.request.mockResolvedValueOnce(successBody({ total: 40, skills: page1 }));
    connMock.activeTransport.mockReturnValue(t);
    await useSkillsStore.getState().searchMarket({ keyword: "语法" }, true);
    expect(t.request).toHaveBeenCalledWith("POST", ENDPOINTS.skillhub.list, {
      keyword: "语法",
      category: undefined,
      page: 1,
      pageSize: 20,
      sortBy: "score",
    });
    expect(useSkillsStore.getState().marketPage).toBe(1);
    t.request.mockResolvedValueOnce(successBody({ total: 40, skills: page2 }));
    await useSkillsStore.getState().searchMarket({}, false);
    expect(useSkillsStore.getState().marketPage).toBe(2);
    expect(useSkillsStore.getState().marketItems).toHaveLength(40);
  });

  it("market 行按 slug 去重：top 响应内重复行只保留首见", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(
      successBody([HUB_SKILL, { ...HUB_SKILL, name: "重复行" }, HUB_SKILL]),
    );
    connMock.activeTransport.mockReturnValue(t);
    await useSkillsStore.getState().loadMarketTop();
    const s = useSkillsStore.getState();
    expect(s.marketItems.map((item) => item.slug)).toEqual(["grammar"]);
    expect(s.marketTotal).toBe(1);
  });

  it("market 翻页追加去重：与已载页重叠的行不重复出现", async () => {
    const t = makeTransport();
    t.request.mockResolvedValueOnce(
      successBody({ total: 30, skills: [HUB_SKILL] }),
    );
    connMock.activeTransport.mockReturnValue(t);
    await useSkillsStore.getState().searchMarket({}, true);
    // 上游未实现分页/页间重叠：第二页回第一页同集 + 一条新行
    t.request.mockResolvedValueOnce(
      successBody({
        total: 30,
        skills: [HUB_SKILL, { ...HUB_SKILL, slug: "new-skill" }],
      }),
    );
    await useSkillsStore.getState().searchMarket({}, false);
    const s = useSkillsStore.getState();
    expect(s.marketItems.map((item) => item.slug)).toEqual([
      "grammar",
      "new-skill",
    ]);
  });

  it("无 skillhub 能力时市场面不发请求（静默降级）", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody([HUB_SKILL]));
    connMock.activeTransport.mockReturnValue(t);
    connMock.capabilities = ["chat"];
    await useSkillsStore.getState().loadMarketTop();
    await useSkillsStore.getState().loadCategories();
    const result = await useSkillsStore.getState().install("grammar");
    expect(t.request).not.toHaveBeenCalled();
    expect(result).toBeNull();
    expect(useSkillsStore.getState().marketItems).toHaveLength(0);
  });

  it("install 成功（installed）重拉已装列表", async () => {
    const t = makeTransport();
    t.request.mockImplementation((_m: string, path: string) => {
      if (path === ENDPOINTS.skillhub.install) {
        return Promise.resolve(
          successBody({
            status: "installed",
            record: {
              id: 9,
              name: "grammar",
              source: "skillhub",
              slug: "grammar",
              version: "1.0.0",
            },
          }),
        );
      }
      return Promise.resolve(successBody([]));
    });
    connMock.activeTransport.mockReturnValue(t);
    const result = await useSkillsStore.getState().install("grammar");
    expect(result?.status).toBe("installed");
    expect(
      t.request.mock.calls.some((call) => call[1] === ENDPOINTS.skills.query),
    ).toBe(true);
    expect(useSkillsStore.getState().installingSlug).toBeNull();
  });

  it("setEnabled/patchEnabled 启停补丁与端点", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody([SKILL_ROW]));
    connMock.activeTransport.mockReturnValue(t);
    useSkillsStore.getState().patchEnabled("grammar", false);
    // 补丁作用于现有行——空列表时无行可补
    expect(
      useSkillsStore.getState().rows.find((r) => r.name === "grammar"),
    ).toBeUndefined();
    await useSkillsStore.getState().load();
    t.request.mockClear();
    useSkillsStore.getState().patchEnabled("grammar", false);
    expect(
      useSkillsStore.getState().rows.find((r) => r.name === "grammar")?.enabled,
    ).toBe(false);
    const ok = await useSkillsStore.getState().setEnabled("grammar", true);
    expect(ok).toBe(true);
    expect(t.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.skills.setEnabled,
      {
        name: "grammar",
        enabled: true,
      },
    );
    // 失败回滚由调用方执行（patchEnabled 再翻回）
    t.request.mockResolvedValue(failureBody("SKILL_NOT_FOUND", "不存在"));
    const failed = await useSkillsStore.getState().setEnabled("grammar", true);
    expect(failed).toBe(false);
    useSkillsStore.getState().patchEnabled("grammar", false);
    expect(
      useSkillsStore.getState().rows.find((r) => r.name === "grammar")?.enabled,
    ).toBe(false);
  });

  it("market 面逐行过滤：一条六字段缺失其余保留（不再整页 null）", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(
      successBody([
        HUB_SKILL,
        { slug: "broken" },
        { ...HUB_SKILL, slug: "other", name: "其他技能" },
      ]),
    );
    connMock.activeTransport.mockReturnValue(t);
    await useSkillsStore.getState().loadMarketTop();
    const s = useSkillsStore.getState();
    expect(s.marketItems.map((item) => item.slug)).toEqual([
      "grammar",
      "other",
    ]);
    expect(s.marketError).toBeNull();
  });

  it("market 面非数组响应才整页报错（数组级 null 语义保留）", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody({ not: "an array" }));
    connMock.activeTransport.mockReturnValue(t);
    await useSkillsStore.getState().loadMarketTop();
    expect(useSkillsStore.getState().marketError).toBe(
      "Invalid skillhub top response",
    );
    expect(useSkillsStore.getState().marketItems).toHaveLength(0);
  });

  it("安装响应慢期间切分类互不判过期：筛选照常落地、安装结果照达", async () => {
    const t = makeTransport();
    connMock.activeTransport.mockReturnValue(t);
    const installResponse = deferred<unknown>();
    const listResponse = deferred<unknown>();
    t.request.mockImplementation((_m: string, path: string) => {
      if (path === ENDPOINTS.skillhub.install) return installResponse.promise;
      if (path === ENDPOINTS.skillhub.list) return listResponse.promise;
      return Promise.resolve(successBody([]));
    });
    const installPromise = useSkillsStore.getState().install("grammar");
    const searchPromise = useSkillsStore
      .getState()
      .searchMarket({ category: "writing" }, true);
    // 筛选先返回：旧 market 共用序号下 install token 已判过期返回 null——
    // 拆分后筛选结果照常落地
    listResponse.resolve(successBody({ total: 1, skills: [HUB_SKILL] }));
    await searchPromise;
    expect(useSkillsStore.getState().marketItems).toHaveLength(1);
    expect(useSkillsStore.getState().marketLoading).toBe(false);
    // 安装慢响应后至：结果照达（conflict 原样）且单槽进度态复位
    installResponse.resolve(
      successBody({ status: "conflict", name: "grammar" }),
    );
    const result = await installPromise;
    expect(result).toEqual({ status: "conflict", name: "grammar" });
    expect(useSkillsStore.getState().installingSlug).toBeNull();
  });

  it("install 失败写 installError 不串 marketError", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(
      failureBody("SKILLHUB_UNAVAILABLE", "技能市场不可用"),
    );
    connMock.activeTransport.mockReturnValue(t);
    const result = await useSkillsStore.getState().install("grammar");
    expect(result).toBeNull();
    expect(useSkillsStore.getState().installError).toBe("SKILLHUB_UNAVAILABLE");
    expect(useSkillsStore.getState().marketError).toBeNull();
  });

  it("install 冲突原样返回供覆盖确认；进度态置 installingSlug", async () => {
    const t = makeTransport();
    let resolveInstall!: (value: unknown) => void;
    t.request.mockReturnValue(
      new Promise((done) => {
        resolveInstall = done;
      }),
    );
    connMock.activeTransport.mockReturnValue(t);
    const pending = useSkillsStore.getState().install("grammar");
    await Promise.resolve();
    expect(useSkillsStore.getState().installingSlug).toBe("grammar");
    resolveInstall(successBody({ status: "conflict", name: "grammar" }));
    const result = await pending;
    expect(result).toEqual({ status: "conflict", name: "grammar" });
    expect(useSkillsStore.getState().installingSlug).toBeNull();
  });

  it("installUpload 走 ENDPOINTS.skills.installUpload 映射 {name, base64, overwrite}；installed 重拉列表", async () => {
    const t = makeTransport();
    t.request.mockImplementation((_m: string, path: string) => {
      if (path === ENDPOINTS.skills.installUpload) {
        return Promise.resolve(
          successBody({
            status: "installed",
            record: {
              id: 7,
              name: "grammar",
              source: "local",
              slug: null,
              version: null,
            },
          }),
        );
      }
      return Promise.resolve(successBody([]));
    });
    connMock.activeTransport.mockReturnValue(t);
    const result = await useSkillsStore
      .getState()
      .installUpload("grammar.zip", "QUJD");
    expect(result?.status).toBe("installed");
    expect(t.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.skills.installUpload,
      {
        name: "grammar.zip",
        base64: "QUJD",
        overwrite: false,
      },
    );
    expect(
      t.request.mock.calls.some((call) => call[1] === ENDPOINTS.skills.query),
    ).toBe(true);
    expect(useSkillsStore.getState().uploadingZip).toBe(false);
  });

  it("installUpload 冲突原样返回不重拉；覆盖重试带 overwrite:true", async () => {
    const t = makeTransport();
    t.request.mockImplementation((_m: string, path: string) => {
      if (path === ENDPOINTS.skills.installUpload) {
        return Promise.resolve(
          successBody({ status: "conflict", name: "grammar" }),
        );
      }
      return Promise.resolve(successBody([]));
    });
    connMock.activeTransport.mockReturnValue(t);
    const conflict = await useSkillsStore
      .getState()
      .installUpload("a.zip", "AA");
    expect(conflict).toEqual({ status: "conflict", name: "grammar" });
    expect(
      t.request.mock.calls.some((call) => call[1] === ENDPOINTS.skills.query),
    ).toBe(false);
    const overwritten = await useSkillsStore
      .getState()
      .installUpload("a.zip", "AA", true);
    expect(overwritten).toEqual({ status: "conflict", name: "grammar" });
    expect(t.request).toHaveBeenLastCalledWith(
      "POST",
      ENDPOINTS.skills.installUpload,
      { name: "a.zip", base64: "AA", overwrite: true },
    );
  });

  it("installUpload 失败置服务端错码且不重拉", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(failureBody("SKILL_UPLOAD_INVALID", "超上限"));
    connMock.activeTransport.mockReturnValue(t);
    const result = await useSkillsStore
      .getState()
      .installUpload("big.zip", "AA");
    expect(result).toBeNull();
    expect(useSkillsStore.getState().error).toBe("SKILL_UPLOAD_INVALID");
    expect(
      t.request.mock.calls.some((call) => call[1] === ENDPOINTS.skills.query),
    ).toBe(false);
  });

  it("installUpload 写面串行：二次上传排队等首写完成；进度态单槽复位", async () => {
    const t = makeTransport();
    connMock.activeTransport.mockReturnValue(t);
    const firstResponse = deferred<unknown>();
    const secondResponse = deferred<unknown>();
    t.request
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise);
    const first = useSkillsStore.getState().installUpload("a.zip", "AA");
    const second = useSkillsStore.getState().installUpload("b.zip", "BB");
    await Promise.resolve();
    expect(t.request).toHaveBeenCalledTimes(1);
    expect(useSkillsStore.getState().uploadingZip).toBe(true);
    firstResponse.resolve(successBody({ status: "conflict", name: "a" }));
    await first;
    await Promise.resolve();
    expect(t.request).toHaveBeenCalledTimes(2);
    secondResponse.resolve(successBody({ status: "conflict", name: "b" }));
    await second;
    expect(useSkillsStore.getState().uploadingZip).toBe(false);
    expect(useSkillsStore.getState().saving).toBe(false);
  });

  it("installUpload 切连接后丢弃旧主机迟到响应（返回 null 不污染 error）", async () => {
    const transportA = makeTransport();
    const transportB = makeTransport();
    const responseA = deferred<unknown>();
    transportA.request.mockReturnValue(responseA.promise);
    transportB.request.mockResolvedValue(successBody([]));
    connMock.transport = transportA;
    const pending = useSkillsStore.getState().installUpload("a.zip", "AA");
    connMock.activeConnId = "c2";
    connMock.transport = transportB;
    responseA.resolve(
      successBody({
        status: "installed",
        record: { id: 1, name: "a", source: "local" },
      }),
    );
    await expect(pending).resolves.toBeNull();
    expect(useSkillsStore.getState().error).toBeNull();
  });

  it("load 顺带拉 ENDPOINTS.skills.stats 并按名归一（ISO 串 → epoch ms）", async () => {
    const t = makeTransport();
    t.request.mockImplementation((_m: string, path: string) => {
      if (path === ENDPOINTS.skills.stats) {
        return Promise.resolve(
          successBody([
            {
              name: "grammar",
              usedCount: 3,
              lastUsedAt: "2026-10-26T01:00:00.000Z",
            },
            { name: "plain", usedCount: 1, lastUsedAt: 1760000000000 },
            { name: "never", usedCount: 0, lastUsedAt: null },
            { name: 42, usedCount: "x" },
          ]),
        );
      }
      return Promise.resolve(successBody([SKILL_ROW]));
    });
    connMock.activeTransport.mockReturnValue(t);
    await useSkillsStore.getState().load();
    await Promise.resolve();
    const stats = useSkillsStore.getState().stats;
    expect(Object.keys(stats)).toEqual(["grammar", "plain", "never"]);
    expect(stats.grammar.usedCount).toBe(3);
    expect(stats.grammar.lastUsedAt).toBe(
      new Date("2026-10-26T01:00:00.000Z").getTime(),
    );
    expect(stats.plain.lastUsedAt).toBe(1760000000000);
    expect(stats.never.lastUsedAt).toBeNull();
  });

  it("loadStats 失败静默：不置 error、保留旧统计", async () => {
    const t = makeTransport();
    t.request.mockImplementation((_m: string, path: string) => {
      if (path === ENDPOINTS.skills.stats) {
        return Promise.resolve(failureBody("NOT_FOUND", "无此端点"));
      }
      return Promise.resolve(successBody([SKILL_ROW]));
    });
    connMock.activeTransport.mockReturnValue(t);
    await useSkillsStore.getState().load();
    await Promise.resolve();
    expect(useSkillsStore.getState().error).toBeNull();
    expect(useSkillsStore.getState().stats).toEqual({});
  });

  it("loadDetail 走 skillhub/detail 收 detail；业务失败写 detailError", async () => {
    const t = makeTransport();
    const DETAIL = {
      skill: { slug: "grammar", overviewMd: "# hi" },
      owner: { displayName: "a", handle: "a", image: null },
      latestVersion: { version: "1.1.0" },
      security: "benign",
    };
    t.request.mockResolvedValueOnce(successBody(DETAIL));
    connMock.activeTransport.mockReturnValue(t);
    await useSkillsStore.getState().loadDetail("grammar");
    expect(t.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.skillhub.detail,
      { slug: "grammar" },
    );
    expect(useSkillsStore.getState().detail).toEqual(DETAIL);
    expect(useSkillsStore.getState().detailLoading).toBe(false);
    t.request.mockResolvedValueOnce(
      failureBody("SKILLHUB_UNAVAILABLE", "503"),
    );
    await useSkillsStore.getState().loadDetail("grammar");
    expect(useSkillsStore.getState().detailError).toBe("SKILLHUB_UNAVAILABLE");
  });

  it("loadDetail 非法响应收 Invalid；无 skillhub 能力静默短路", async () => {
    const t = makeTransport();
    t.request.mockResolvedValueOnce(successBody({ nope: true }));
    connMock.activeTransport.mockReturnValue(t);
    await useSkillsStore.getState().loadDetail("grammar");
    expect(useSkillsStore.getState().detailError).toBe(
      "Invalid skillhub detail response",
    );
    connMock.capabilities = ["chat"];
    await useSkillsStore.getState().loadDetail("grammar");
    expect(t.request).toHaveBeenCalledTimes(1);
  });
});

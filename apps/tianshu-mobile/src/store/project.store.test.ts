import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ENDPOINTS,
  type PlanItemRecordDto,
  type ProjectRecordDto,
} from "@tianshu/protocol";

const connMock = vi.hoisted(() => ({
  activeTransport: vi.fn(),
  activeConnId: "c1" as string | null,
  capabilities: ["chat", "project"] as string[] | null,
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

import {
  filterMine,
  inferUserId,
  resolveActiveView,
  useProjectStore,
} from "./project.store";

function makeTransport() {
  return { request: vi.fn() };
}

function successBody(data: unknown) {
  return {
    status: 200,
    body: { code: "2000", success: true, data, message: "success" },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function projectDto(overrides: Partial<ProjectRecordDto> = {}): ProjectRecordDto {
  return {
    id: 1,
    name: "演示项目",
    systemPrompt: "指令",
    templateKey: null,
    ownerId: 1,
    sessionId: 1,
    createdAt: "2026-10-26T00:00:00.000Z",
    updatedAt: "2026-10-26T00:00:00.000Z",
    ...overrides,
  };
}

function planItemDto(
  overrides: Partial<PlanItemRecordDto> = {},
): PlanItemRecordDto {
  return {
    id: 1,
    projectId: 1,
    title: "事项一",
    description: "",
    aiSummary: "",
    status: "not_started",
    priority: "P1",
    assigneeId: 1,
    tags: [],
    customFields: {},
    startDate: "",
    dueDate: "",
    source: "manual",
    sortOrder: 0,
    createdById: 1,
    createdAt: "2026-10-26T00:00:00.000Z",
    updatedAt: "2026-10-26T00:00:00.000Z",
    ...overrides,
  };
}

describe("project.store", () => {
  beforeEach(() => {
    connMock.activeTransport.mockReset();
    connMock.activeConnId = "c1";
    connMock.capabilities = ["chat", "project"];
    connMock.transport = null;
    connMock.activeTransport.mockImplementation(() => connMock.transport);
    useProjectStore.getState().resetForTest();
  });

  it("load 走 project/query 并解析项目列表", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody([projectDto()]));
    connMock.activeTransport.mockReturnValue(t);
    await useProjectStore.getState().load();
    const s = useProjectStore.getState();
    expect(s.projects).toHaveLength(1);
    expect(s.hub.initialized).toBe(true);
    expect(t.request).toHaveBeenCalledWith("POST", ENDPOINTS.project.query, null);
  });

  it("create 走 project/create 且写后重拉 hub 列表", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody(null));
    connMock.activeTransport.mockReturnValue(t);
    const ok = await useProjectStore
      .getState()
      .create({ name: "新项目", systemPrompt: "指令" });
    expect(ok).toBe(true);
    const calls = t.request.mock.calls.map((call) => [call[1], call[2]]);
    expect(calls[0]).toEqual([
      ENDPOINTS.project.create,
      { name: "新项目", systemPrompt: "指令" },
    ]);
    expect(calls[1]).toEqual([ENDPOINTS.project.query, null]);
  });

  it("rename/updateInstruction 走 project/update 不同载荷", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody(null));
    connMock.activeTransport.mockReturnValue(t);
    await useProjectStore.getState().rename(1, "改名");
    await useProjectStore.getState().updateInstruction(1, "新指令");
    const calls = t.request.mock.calls
      .filter((call) => call[1] === ENDPOINTS.project.update)
      .map((call) => call[2]);
    expect(calls).toEqual([
      { id: 1, name: "改名" },
      { id: 1, systemPrompt: "新指令" },
    ]);
  });

  it("loadMine 走 planItem/listMine 并推断 currentUserId", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(
      successBody([
        planItemDto({ id: 1, assigneeId: 7, createdById: 7 }),
        planItemDto({ id: 2, assigneeId: 8, createdById: 7 }),
      ]),
    );
    connMock.activeTransport.mockReturnValue(t);
    await useProjectStore.getState().loadMine();
    const s = useProjectStore.getState();
    expect(s.mine).toHaveLength(2);
    expect(s.currentUserId).toBe(7);
    expect(t.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.planItem.listMine,
      null,
    );
  });

  it("loadPlan 三联并联：list + fieldsList + planView/list", async () => {
    const t = makeTransport();
    t.request
      .mockResolvedValueOnce(successBody([planItemDto()]))
      .mockResolvedValueOnce(successBody([{ name: "风险", type: "text" }]))
      .mockResolvedValueOnce(successBody([]));
    connMock.activeTransport.mockReturnValue(t);
    await useProjectStore.getState().loadPlan(5);
    const s = useProjectStore.getState();
    expect(s.items).toHaveLength(1);
    expect(s.fields).toEqual([{ name: "风险", type: "text" }]);
    expect(t.request).toHaveBeenCalledWith("POST", ENDPOINTS.planItem.list, {
      projectId: 5,
    });
    expect(t.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.planItem.fieldsList,
      { projectId: 5 },
    );
    expect(t.request).toHaveBeenCalledWith("POST", ENDPOINTS.planView.list, {
      projectId: 5,
    });
    expect(s.currentProjectId).toBe(5);
  });

  it("createItem/updateItem/moveItem/removeItem 端点与载荷", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody(null));
    connMock.activeTransport.mockReturnValue(t);
    const store = useProjectStore.getState();
    await store.createItem({ title: "新事项", projectId: 5 });
    await store.updateItem({ id: 1, title: "改题" });
    await store.moveItem(1, "done", 9);
    await store.removeItem(1);
    // 每次写后重拉计划面（planItem/list）——滤掉刷新只比对写面调用
    const calls = t.request.mock.calls
      .filter((call) => call[1] !== ENDPOINTS.planItem.list)
      .map((call) => [call[1], call[2]]);
    expect(calls).toEqual([
      [ENDPOINTS.planItem.create, { title: "新事项", projectId: 5 }],
      [ENDPOINTS.planItem.update, { id: 1, title: "改题" }],
      [ENDPOINTS.planItem.move, { id: 1, status: "done", sortOrder: 9 }],
      [ENDPOINTS.planItem.delete, { id: 1 }],
    ]);
  });

  it("loadAssets/loadStorage/readAssetImage 端点与载荷", async () => {
    const t = makeTransport();
    t.request
      .mockResolvedValueOnce(
        successBody([
          { name: "报告.md", type: "file", size: 10, updatedAt: "", ext: "md" },
        ]),
      )
      .mockResolvedValueOnce(successBody({ usedBytes: 1, quotaBytes: 100 }))
      .mockResolvedValueOnce(
        successBody({ mime: "image/png", dataBase64: "QUJD" }),
      );
    connMock.activeTransport.mockReturnValue(t);
    await useProjectStore.getState().loadAssets(5, ["docs"]);
    expect(t.request).toHaveBeenCalledWith("POST", ENDPOINTS.projectAsset.list, {
      projectId: 5,
      path: "docs",
    });
    expect(useProjectStore.getState().folderPath).toEqual(["docs"]);
    await useProjectStore.getState().loadStorage(5);
    expect(t.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.projectAsset.storage,
      { projectId: 5 },
    );
    expect(useProjectStore.getState().storage).toEqual({
      usedBytes: 1,
      quotaBytes: 100,
    });
    await expect(
      useProjectStore.getState().readAssetImage(5, ["docs", "a.png"]),
    ).resolves.toEqual({ mime: "image/png", dataBase64: "QUJD" });
    expect(t.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.projectAsset.readImage,
      { projectId: 5, path: "docs/a.png" },
    );
  });

  it("资产写族端点：createFolder/rename/delete", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody(null));
    connMock.activeTransport.mockReturnValue(t);
    await useProjectStore.getState().loadAssets(5, ["docs"]);
    t.request.mockClear();
    await useProjectStore.getState().createFolder(5, "子目录");
    await useProjectStore.getState().renameAsset(5, ["docs"], "新名");
    await useProjectStore.getState().removeAsset(5, ["docs", "旧文件.md"]);
    const calls = t.request.mock.calls
      .filter(
        (call) =>
          !String(call[1]).startsWith("projectAsset/list") &&
          call[1] !== ENDPOINTS.projectAsset.storage,
      )
      .map((call) => [call[1], call[2]]);
    expect(calls).toEqual([
      [
        ENDPOINTS.projectAsset.createFolder,
        { projectId: 5, parentPath: "docs", name: "子目录" },
      ],
      [
        ENDPOINTS.projectAsset.rename,
        { projectId: 5, path: "docs", newName: "新名" },
      ],
      [
        ENDPOINTS.projectAsset.delete,
        { projectId: 5, path: "docs/旧文件.md" },
      ],
    ]);
  });

  it("loadDetail 并联 getDetail + listMembers", async () => {
    const t = makeTransport();
    t.request
      .mockResolvedValueOnce(
        successBody({
          project: projectDto(),
          assetWorkspaceId: 9,
          bindings: [],
          sessionId: 1,
        }),
      )
      .mockResolvedValueOnce(
        successBody([
          { userId: 1, nickname: "我", username: "me", role: "owner" },
        ]),
      );
    connMock.activeTransport.mockReturnValue(t);
    await useProjectStore.getState().loadDetail(1);
    const s = useProjectStore.getState();
    expect(s.detail?.assetWorkspaceId).toBe(9);
    expect(s.members).toHaveLength(1);
    expect(t.request).toHaveBeenCalledWith("POST", ENDPOINTS.project.getDetail, {
      id: 1,
    });
    expect(t.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.project.listMembers,
      { projectId: 1 },
    );
  });

  it("附件三端点：attachmentList/attachmentCreate/attachmentDelete", async () => {
    const t = makeTransport();
    t.request
      .mockResolvedValueOnce(
        successBody([
          {
            id: 3,
            planItemId: 1,
            fileName: "报告.md",
            assetPath: "报告.md",
            createdAt: "2026-10-26T00:00:00.000Z",
          },
        ]),
      )
      .mockResolvedValue(successBody(null));
    connMock.activeTransport.mockReturnValue(t);
    await expect(useProjectStore.getState().listAttachments(1)).resolves.toEqual([
      {
        id: 3,
        planItemId: 1,
        fileName: "报告.md",
        assetPath: "报告.md",
        createdAt: "2026-10-26T00:00:00.000Z",
      },
    ]);
    expect(t.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.planItem.attachmentList,
      { planItemId: 1 },
    );
    await useProjectStore
      .getState()
      .createAttachment(1, "报告.md", "报告.md");
    await useProjectStore.getState().removeAttachment(3);
    const calls = t.request.mock.calls
      .filter((call) => String(call[1]).startsWith("planItem/attachment"))
      .map((call) => [call[1], call[2]]);
    expect(calls).toEqual([
      [ENDPOINTS.planItem.attachmentList, { planItemId: 1 }],
      [
        ENDPOINTS.planItem.attachmentCreate,
        { planItemId: 1, fileName: "报告.md", assetPath: "报告.md" },
      ],
      [ENDPOINTS.planItem.attachmentDelete, { id: 3 }],
    ]);
  });

  it("写操作串行且旧写完成不提前清除 saving", async () => {
    const t = makeTransport();
    connMock.activeTransport.mockReturnValue(t);
    const firstResponse = deferred<unknown>();
    const secondResponse = deferred<unknown>();
    t.request
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise);
    const first = useProjectStore.getState().rename(1, "a");
    const second = useProjectStore.getState().rename(1, "b");
    await Promise.resolve();
    expect(t.request).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().saving).toBe(true);
    firstResponse.resolve(successBody(null));
    await first;
    await Promise.resolve();
    expect(t.request).toHaveBeenCalledTimes(2);
    expect(useProjectStore.getState().saving).toBe(true);
    secondResponse.resolve(successBody(null));
    await second;
    expect(useProjectStore.getState().saving).toBe(false);
  });

  it("wire 业务错 → hub.error 置位且返回 false", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue({
      status: 200,
      body: { code: "5000", success: false, data: null, message: "重名" },
    });
    connMock.activeTransport.mockReturnValue(t);
    const ok = await useProjectStore.getState().create({ name: "x" });
    expect(ok).toBe(false);
    expect(useProjectStore.getState().hub.error).toBe("重名");
  });

  it("切连接后丢弃旧主机迟到的 load 响应", async () => {
    const transportA = makeTransport();
    const transportB = makeTransport();
    const responseA = deferred<unknown>();
    const responseB = deferred<unknown>();
    transportA.request.mockReturnValue(responseA.promise);
    transportB.request.mockReturnValue(responseB.promise);
    connMock.transport = transportA;
    const loadA = useProjectStore.getState().load();
    connMock.activeConnId = "c2";
    connMock.transport = transportB;
    const loadB = useProjectStore.getState().load();
    responseB.resolve(successBody([projectDto({ name: "B项目" })]));
    await loadB;
    responseA.resolve(successBody([projectDto({ name: "A项目" })]));
    await loadA;
    expect(useProjectStore.getState().projects[0].name).toBe("B项目");
  });

  it("无 project 能力/无连接时不发请求", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody([]));
    connMock.activeTransport.mockReturnValue(t);
    connMock.capabilities = ["chat"];
    await useProjectStore.getState().load();
    const ok = await useProjectStore.getState().create({ name: "x" });
    expect(t.request).not.toHaveBeenCalled();
    expect(ok).toBe(false);
    expect(useProjectStore.getState().hub.initialized).toBe(false);
    connMock.capabilities = ["project"];
    connMock.activeConnId = null;
    await useProjectStore.getState().load();
    expect(t.request).not.toHaveBeenCalled();
  });
});

describe("project.store 纯函数", () => {
  it("inferUserId 取 assigneeId/createdById 众数；空列表 null", () => {
    const items = [
      planItemDto({ assigneeId: 7, createdById: 7 }),
      planItemDto({ id: 2, assigneeId: 8, createdById: 7 }),
      planItemDto({ id: 3, assigneeId: null, createdById: 7 }),
    ];
    expect(inferUserId(items)).toBe(7);
    expect(inferUserId([])).toBeNull();
  });

  it("filterMine 范围/来源/标题三重过滤", () => {
    const items = [
      planItemDto({ id: 1, title: "修 bug", assigneeId: 7, createdById: 7 }),
      planItemDto({
        id: 2,
        title: "写文档",
        projectId: null,
        assigneeId: null,
        createdById: 7,
      }),
      planItemDto({
        id: 3,
        title: "帮别人",
        assigneeId: 8,
        createdById: 9,
      }),
    ];
    // 范围：指派给我的（userId=7）
    expect(
      filterMine(items, "assigned", "all", "", 7).map((i) => i.id),
    ).toEqual([1]);
    // 范围：我创建的
    expect(filterMine(items, "created", "all", "", 7).map((i) => i.id)).toEqual([
      1, 2,
    ]);
    // 来源：本地任务
    expect(filterMine(items, "all", "local", "", 7).map((i) => i.id)).toEqual([
      2,
    ]);
    // 标题过滤（大小写不敏感）
    expect(
      filterMine(items, "all", "all", "BUG", 7).map((i) => i.id),
    ).toEqual([1]);
    // userId 未知退化：assigned=已指派行、created=未指派行
    expect(filterMine(items, "assigned", "all", "", null).map((i) => i.id))
      .toEqual([1, 3]);
    expect(filterMine(items, "created", "all", "", null).map((i) => i.id))
      .toEqual([2]);
  });

  it("resolveActiveView 按 sortOrder 首条 + 本地记忆优先", () => {
    const views = [
      { id: 2, sortOrder: 2 },
      { id: 1, sortOrder: 1 },
    ] as never[];
    expect(resolveActiveView(views, null)?.id).toBe(1);
    expect(resolveActiveView(views, 2)?.id).toBe(2);
    // 记忆 id 不存在时回落首条
    expect(resolveActiveView(views, 99)?.id).toBe(1);
  });
});

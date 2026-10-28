import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENDPOINTS, type LibraryItemDto } from "@tianshu/protocol";

const connMock = vi.hoisted(() => ({
  activeTransport: vi.fn(),
  activeConnId: "c1" as string | null,
  capabilities: ["chat", "library"] as string[] | null,
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

import { useLibraryStore } from "./library.store";

function makeTransport() {
  return { request: vi.fn() };
}

function itemDto(overrides: Partial<LibraryItemDto> = {}): LibraryItemDto {
  return {
    id: 1,
    parentId: null,
    name: "笔记.md",
    kind: "file",
    fileType: "markdown",
    mimeType: "text/markdown",
    size: 128,
    url: null,
    favorite: false,
    lastViewedAt: null,
    location: [],
    createdAt: "2026-10-26T00:00:00.000Z",
    updatedAt: "2026-10-26T00:00:00.000Z",
    ...overrides,
  };
}

const FOLDER = itemDto({
  id: 2,
  name: "资料",
  kind: "folder",
  fileType: null,
  mimeType: null,
  size: null,
});

const LIST_RESULT = {
  items: [itemDto(), FOLDER],
  breadcrumbs: [],
};

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

describe("library.store", () => {
  beforeEach(() => {
    connMock.activeTransport.mockReset();
    connMock.activeConnId = "c1";
    connMock.capabilities = ["chat", "library"];
    connMock.transport = null;
    connMock.activeTransport.mockImplementation(() => connMock.transport);
    useLibraryStore.getState().resetForTest();
  });

  it("load 解包 items+breadcrumbs 并置 browse 态", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody(LIST_RESULT));
    connMock.activeTransport.mockReturnValue(t);
    await useLibraryStore.getState().load();
    const s = useLibraryStore.getState();
    expect(s.items).toHaveLength(2);
    expect(s.breadcrumbs).toEqual([]);
    expect(s.mode).toBe("browse");
    expect(s.initialized).toBe(true);
    expect(t.request).toHaveBeenCalledWith("POST", ENDPOINTS.library.list, {
      parentId: null,
    });
  });

  it("load(parentId) 带目录 id 请求", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody(LIST_RESULT));
    connMock.activeTransport.mockReturnValue(t);
    await useLibraryStore.getState().load(7);
    expect(t.request).toHaveBeenCalledWith("POST", ENDPOINTS.library.list, {
      parentId: 7,
    });
    expect(useLibraryStore.getState().currentParentId).toBe(7);
  });

  it("search 走 library/search 并清面包屑", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody([itemDto()]));
    connMock.activeTransport.mockReturnValue(t);
    await useLibraryStore.getState().load();
    await useLibraryStore.getState().search("笔记");
    const s = useLibraryStore.getState();
    expect(s.mode).toBe("search");
    expect(s.keyword).toBe("笔记");
    expect(s.items).toHaveLength(1);
    expect(s.breadcrumbs).toEqual([]);
    expect(t.request).toHaveBeenCalledWith("POST", ENDPOINTS.library.search, {
      keyword: "笔记",
    });
  });

  it("loadRecent 首次拉取、非脏二次进入不重拉", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody([itemDto()]));
    connMock.activeTransport.mockReturnValue(t);
    await useLibraryStore.getState().loadRecent();
    expect(t.request).toHaveBeenCalledTimes(1);
    expect(t.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.library.listRecent,
      null,
    );
    expect(useLibraryStore.getState().mode).toBe("recent");
    await useLibraryStore.getState().loadRecent();
    expect(t.request).toHaveBeenCalledTimes(1);
  });

  it("loadFavorites 走 listFavorites；写后脏标记触发重拉", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody([itemDto()]));
    connMock.activeTransport.mockReturnValue(t);
    await useLibraryStore.getState().loadFavorites();
    expect(t.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.library.listFavorites,
      null,
    );
    await useLibraryStore.getState().loadFavorites();
    expect(t.request).toHaveBeenCalledTimes(1);
    // 收藏态写（toggleFavorite）→ favorites 置脏 → 下次进入重拉
    await useLibraryStore.getState().toggleFavorite(1);
    await useLibraryStore.getState().loadFavorites();
    expect(t.request).toHaveBeenCalledTimes(3);
  });

  it("createFolder 走 createFolder 且浏览态写后重拉当前目录", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody(null));
    connMock.activeTransport.mockReturnValue(t);
    await useLibraryStore.getState().load(3);
    t.request.mockClear();
    const ok = await useLibraryStore.getState().createFolder("新目录");
    expect(ok).toBe(true);
    expect(t.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.library.createFolder,
      { name: "新目录", parentId: 3 },
    );
    // 写后局部刷新：重拉当前目录（browse 态）
    expect(t.request).toHaveBeenCalledWith("POST", ENDPOINTS.library.list, {
      parentId: 3,
    });
  });

  it("createFile/addLink/rename/move/remove/markViewed 端点与载荷", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody(null));
    connMock.activeTransport.mockReturnValue(t);
    await useLibraryStore.getState().load();
    t.request.mockClear();
    await useLibraryStore.getState().createFile("新笔记.md");
    await useLibraryStore.getState().addLink("https://a.test", "标题");
    await useLibraryStore.getState().rename(1, "改名.md");
    await useLibraryStore.getState().move([1, 2], 9);
    await useLibraryStore.getState().remove([1]);
    await useLibraryStore.getState().markViewed(1);
    // 浏览态每次写后都会重拉当前目录——滤掉 list 刷新只比对写面调用
    const calls = t.request.mock.calls
      .filter((call) => call[1] !== ENDPOINTS.library.list)
      .map((call) => [call[1], call[2]]);
    expect(calls).toEqual([
      [ENDPOINTS.library.createFile, { name: "新笔记.md", parentId: null }],
      [
        ENDPOINTS.library.addLink,
        { url: "https://a.test", title: "标题", parentId: null },
      ],
      [ENDPOINTS.library.rename, { id: 1, name: "改名.md" }],
      [ENDPOINTS.library.move, { ids: [1, 2], targetParentId: 9 }],
      [ENDPOINTS.library.delete, { ids: [1] }],
      [ENDPOINTS.library.markViewed, { id: 1 }],
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
    const first = useLibraryStore.getState().rename(1, "a.md");
    const second = useLibraryStore.getState().rename(1, "b.md");
    await Promise.resolve();
    expect(t.request).toHaveBeenCalledTimes(1);
    expect(useLibraryStore.getState().saving).toBe(true);
    firstResponse.resolve(successBody(null));
    await first;
    await Promise.resolve();
    expect(t.request).toHaveBeenCalledTimes(2);
    expect(useLibraryStore.getState().saving).toBe(true);
    secondResponse.resolve(successBody(null));
    await second;
    expect(useLibraryStore.getState().saving).toBe(false);
  });

  it("wire 业务错 → error 置位且返回 false", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue({
      status: 200,
      body: { code: "5000", success: false, data: null, message: "重名" },
    });
    connMock.activeTransport.mockReturnValue(t);
    const ok = await useLibraryStore.getState().createFolder("x");
    expect(ok).toBe(false);
    expect(useLibraryStore.getState().error).toBe("重名");
  });

  it("切连接后丢弃旧主机迟到的 load 响应", async () => {
    const transportA = makeTransport();
    const transportB = makeTransport();
    const responseA = deferred<unknown>();
    const responseB = deferred<unknown>();
    transportA.request.mockReturnValue(responseA.promise);
    transportB.request.mockReturnValue(responseB.promise);
    connMock.transport = transportA;
    const loadA = useLibraryStore.getState().load();
    connMock.activeConnId = "c2";
    connMock.transport = transportB;
    const loadB = useLibraryStore.getState().load();
    responseB.resolve(
      successBody({ ...LIST_RESULT, items: [itemDto({ name: "B.md" })] }),
    );
    await loadB;
    responseA.resolve(
      successBody({ ...LIST_RESULT, items: [itemDto({ name: "A.md" })] }),
    );
    await loadA;
    expect(useLibraryStore.getState().items[0].name).toBe("B.md");
  });

  it("无 library 能力/无连接时不发请求", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody(LIST_RESULT));
    connMock.activeTransport.mockReturnValue(t);
    connMock.capabilities = ["chat"];
    await useLibraryStore.getState().load();
    await useLibraryStore.getState().search("x");
    const ok = await useLibraryStore.getState().createFolder("x");
    expect(t.request).not.toHaveBeenCalled();
    expect(ok).toBe(false);
    expect(useLibraryStore.getState().initialized).toBe(false);
    connMock.capabilities = ["library"];
    connMock.activeConnId = null;
    await useLibraryStore.getState().load();
    expect(t.request).not.toHaveBeenCalled();
  });

  it("toggleFavorite 即时乐观翻转行，失败回滚", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody(LIST_RESULT));
    connMock.activeTransport.mockReturnValue(t);
    await useLibraryStore.getState().load();
    const pending = useLibraryStore.getState().toggleFavorite(1);
    expect(
      useLibraryStore.getState().items.find((item) => item.id === 1)?.favorite,
    ).toBe(true);
    await pending;
    // 浏览态写后重拉当前目录——服务端回包即权威态（mock 中 favorite=false）
    const before = useLibraryStore
      .getState()
      .items.find((item) => item.id === 1)?.favorite;
    t.request.mockResolvedValue({
      status: 200,
      body: { code: "5000", success: false, data: null, message: "失败" },
    });
    const failed = await useLibraryStore.getState().toggleFavorite(1);
    expect(failed).toBe(false);
    // 失败回滚到本次调用前的行态
    expect(
      useLibraryStore.getState().items.find((item) => item.id === 1)?.favorite,
    ).toBe(before);
  });

  it("readText 解包 content；失败抛错带 message", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(
      successBody({ kind: "text", content: "# 你好" }),
    );
    connMock.activeTransport.mockReturnValue(t);
    await expect(useLibraryStore.getState().readText(1)).resolves.toBe(
      "# 你好",
    );
    expect(t.request).toHaveBeenCalledWith("POST", ENDPOINTS.library.read, {
      id: 1,
    });
    t.request.mockResolvedValue({
      status: 200,
      body: {
        code: "LIBRARY_TOO_LARGE",
        success: false,
        data: null,
        message: "文件过大",
      },
    });
    await expect(useLibraryStore.getState().readText(1)).rejects.toThrow(
      "文件过大",
    );
  });

  it("readImage 解包 mime+dataBase64", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(
      successBody({ mime: "image/png", dataBase64: "QUJD" }),
    );
    connMock.activeTransport.mockReturnValue(t);
    await expect(useLibraryStore.getState().readImage(1)).resolves.toEqual({
      mime: "image/png",
      dataBase64: "QUJD",
    });
    expect(t.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.library.readImage,
      { id: 1 },
    );
  });

  it("loadTree 拍平返回全部条目；subtreeCount 返回数字", async () => {
    const t = makeTransport();
    t.request
      .mockResolvedValueOnce(successBody([FOLDER, itemDto()]))
      .mockResolvedValueOnce(successBody(5));
    connMock.activeTransport.mockReturnValue(t);
    const tree = await useLibraryStore.getState().loadTree();
    expect(tree).toHaveLength(2);
    expect(t.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.library.tree,
      null,
    );
    await expect(useLibraryStore.getState().subtreeCount(2)).resolves.toBe(5);
    expect(t.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.library.subtreeCount,
      { id: 2 },
    );
  });

  it("writeContent 走 writeContent 端点；成功回传刷新行就地更新 size/updatedAt", async () => {
    const t = makeTransport();
    t.request
      .mockResolvedValueOnce(successBody(LIST_RESULT))
      .mockResolvedValueOnce(
        successBody(
          itemDto({ size: 12, updatedAt: "2026-10-26T09:00:00.000Z" }),
        ),
      );
    connMock.activeTransport.mockReturnValue(t);
    await useLibraryStore.getState().load();
    t.request.mockClear();
    const row = await useLibraryStore.getState().writeContent(1, "新内容");
    expect(t.request).toHaveBeenCalledTimes(1);
    expect(t.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.library.writeContent,
      { id: 1, content: "新内容" },
    );
    expect(row.size).toBe(12);
    // 浏览态不重拉列表——行补丁已足够（尺寸/时间即时可见）
    const line = useLibraryStore.getState().items.find((i) => i.id === 1);
    expect(line?.size).toBe(12);
    expect(line?.updatedAt).toBe("2026-10-26T09:00:00.000Z");
  });

  it("writeContent 非浏览态成功置脏，下次进入该模式重拉", async () => {
    const t = makeTransport();
    t.request
      .mockResolvedValueOnce(successBody([itemDto()]))
      .mockResolvedValueOnce(successBody(itemDto()))
      .mockResolvedValue(successBody([itemDto()]));
    connMock.activeTransport.mockReturnValue(t);
    await useLibraryStore.getState().search("笔记");
    t.request.mockClear();
    await useLibraryStore.getState().writeContent(1, "x");
    expect(t.request).toHaveBeenCalledTimes(1);
    expect(useLibraryStore.getState().stale.search).toBe(true);
    await useLibraryStore.getState().search("笔记");
    expect(t.request).toHaveBeenCalledTimes(2);
  });

  it("writeContent 失败抛 codedError 带服务端码且不重拉；链不阻断后续写", async () => {
    const t = makeTransport();
    t.request
      .mockResolvedValueOnce(successBody(LIST_RESULT))
      .mockResolvedValueOnce({
        status: 200,
        body: {
          code: "LIBRARY_WRITE_FAILED",
          success: false,
          data: null,
          message: "写入失败",
        },
      })
      .mockResolvedValue(successBody(null));
    connMock.activeTransport.mockReturnValue(t);
    await useLibraryStore.getState().load();
    t.request.mockClear();
    const failure = await useLibraryStore
      .getState()
      .writeContent(1, "x")
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect((failure as { code?: string }).code).toBe("LIBRARY_WRITE_FAILED");
    expect((failure as Error).message).toBe("写入失败");
    expect(useLibraryStore.getState().error).toBe("LIBRARY_WRITE_FAILED");
    // 失败不重拉 + 串行链未断：后续 rename 照常执行
    expect(
      t.request.mock.calls.every((call) => call[1] !== ENDPOINTS.library.list),
    ).toBe(true);
    const ok = await useLibraryStore.getState().rename(1, "y.md");
    expect(ok).toBe(true);
  });

  it("writeContent 响应非法形状抛错不重拉", async () => {
    const t = makeTransport();
    t.request
      .mockResolvedValueOnce(successBody(LIST_RESULT))
      .mockResolvedValueOnce(successBody({ nope: true }));
    connMock.activeTransport.mockReturnValue(t);
    await useLibraryStore.getState().load();
    t.request.mockClear();
    await expect(
      useLibraryStore.getState().writeContent(1, "x"),
    ).rejects.toThrow("Invalid library writeContent response");
    expect(t.request).toHaveBeenCalledTimes(1);
  });

  it("writeContent 切连接后丢弃旧主机迟到响应（防迟到，error 不置位）", async () => {
    const transportA = makeTransport();
    const transportB = makeTransport();
    const responseA = deferred<unknown>();
    transportA.request.mockReturnValue(responseA.promise);
    transportB.request.mockResolvedValue(successBody(LIST_RESULT));
    connMock.transport = transportA;
    const pending = useLibraryStore.getState().writeContent(1, "x");
    connMock.activeConnId = "c2";
    connMock.transport = transportB;
    responseA.resolve(successBody(itemDto()));
    await expect(pending).rejects.toThrow("stale response");
    expect(useLibraryStore.getState().error).toBeNull();
  });

  it("uploadFile 走 uploadFile 端点；浏览态就地插入新行不重拉", async () => {
    const t = makeTransport();
    const uploaded = itemDto({ id: 9, name: "报告.pdf", size: 2048 });
    t.request
      .mockResolvedValueOnce(successBody(LIST_RESULT))
      .mockResolvedValueOnce(successBody(uploaded));
    connMock.activeTransport.mockReturnValue(t);
    await useLibraryStore.getState().load();
    t.request.mockClear();
    const row = await useLibraryStore
      .getState()
      .uploadFile(null, "报告.pdf", "QUJD");
    expect(t.request).toHaveBeenCalledTimes(1);
    expect(t.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.library.uploadFile,
      { parentId: undefined, name: "报告.pdf", base64: "QUJD" },
    );
    expect(row.id).toBe(9);
    // 行补丁：新行就地插入列表首行，无 list 重拉
    const s = useLibraryStore.getState();
    expect(s.items[0].id).toBe(9);
    expect(s.items).toHaveLength(3);
  });

  it("uploadFile 传 folder id；目标目录非当前目录不重插行", async () => {
    const t = makeTransport();
    t.request
      .mockResolvedValueOnce(successBody(LIST_RESULT))
      .mockResolvedValueOnce(successBody(itemDto({ id: 8, parentId: 2 })));
    connMock.activeTransport.mockReturnValue(t);
    await useLibraryStore.getState().load(null);
    t.request.mockClear();
    await useLibraryStore.getState().uploadFile(2, "a.txt", "QQ==");
    expect(t.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.library.uploadFile,
      { parentId: 2, name: "a.txt", base64: "QQ==" },
    );
    // 当前在根目录，上传到 folder 2 的行不回插当前列表
    expect(useLibraryStore.getState().items).toHaveLength(2);
  });

  it("uploadFile 非浏览态成功置脏，下次进入该模式重拉", async () => {
    const t = makeTransport();
    t.request
      .mockResolvedValueOnce(successBody([itemDto()]))
      .mockResolvedValueOnce(successBody(itemDto({ id: 5 })))
      .mockResolvedValue(successBody([itemDto()]));
    connMock.activeTransport.mockReturnValue(t);
    await useLibraryStore.getState().search("笔记");
    t.request.mockClear();
    await useLibraryStore.getState().uploadFile(null, "b.bin", "Qg==");
    expect(t.request).toHaveBeenCalledTimes(1);
    expect(useLibraryStore.getState().stale.search).toBe(true);
    // 行不回插非浏览态列表
    expect(useLibraryStore.getState().items).toHaveLength(1);
    await useLibraryStore.getState().search("笔记");
    expect(t.request).toHaveBeenCalledTimes(2);
  });

  it("uploadFile 失败抛 codedError（LIBRARY_UPLOAD_INVALID）不重拉；链不阻断", async () => {
    const t = makeTransport();
    t.request
      .mockResolvedValueOnce(successBody(LIST_RESULT))
      .mockResolvedValueOnce({
        status: 200,
        body: {
          code: "LIBRARY_UPLOAD_INVALID",
          success: false,
          data: null,
          message: "上传内容非法",
        },
      })
      .mockResolvedValue(successBody(null));
    connMock.activeTransport.mockReturnValue(t);
    await useLibraryStore.getState().load();
    t.request.mockClear();
    const failure = await useLibraryStore
      .getState()
      .uploadFile(null, "x.bin", "QQ==")
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect((failure as { code?: string }).code).toBe("LIBRARY_UPLOAD_INVALID");
    expect((failure as Error).message).toBe("上传内容非法");
    expect(useLibraryStore.getState().error).toBe("LIBRARY_UPLOAD_INVALID");
    expect(
      t.request.mock.calls.every((call) => call[1] !== ENDPOINTS.library.list),
    ).toBe(true);
    const ok = await useLibraryStore.getState().rename(1, "y.md");
    expect(ok).toBe(true);
  });

  it("uploadFile 响应非法形状抛错；无连接/无能力抛 no connection", async () => {
    const t = makeTransport();
    t.request
      .mockResolvedValueOnce(successBody(LIST_RESULT))
      .mockResolvedValueOnce(successBody({ nope: true }));
    connMock.activeTransport.mockReturnValue(t);
    await useLibraryStore.getState().load();
    t.request.mockClear();
    await expect(
      useLibraryStore.getState().uploadFile(null, "x.bin", "QQ=="),
    ).rejects.toThrow("Invalid library uploadFile response");
    expect(t.request).toHaveBeenCalledTimes(1);
    connMock.activeConnId = null;
    await expect(
      useLibraryStore.getState().uploadFile(null, "x.bin", "QQ=="),
    ).rejects.toThrow("no connection");
  });

  it("uploadFile 串行排队且切连接后丢弃迟到响应（防迟到）", async () => {
    const t = makeTransport();
    connMock.activeTransport.mockReturnValue(t);
    const firstResponse = deferred<unknown>();
    const secondResponse = deferred<unknown>();
    t.request
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise);
    const first = useLibraryStore.getState().rename(1, "a.md");
    const second = useLibraryStore
      .getState()
      .uploadFile(null, "x.bin", "QQ==")
      .then(
        () => null,
        (error: unknown) => error,
      );
    await Promise.resolve();
    expect(t.request).toHaveBeenCalledTimes(1);
    firstResponse.resolve(successBody(null));
    await first;
    await Promise.resolve();
    expect(t.request).toHaveBeenCalledTimes(2);
    // 第二写发出后切连接：迟到响应被丢弃（stale response，error 不置位）
    connMock.activeConnId = "c2";
    secondResponse.resolve(successBody(itemDto()));
    const failure = await second;
    expect((failure as Error).message).toBe("stale response");
    expect(useLibraryStore.getState().error).toBeNull();
  });
});

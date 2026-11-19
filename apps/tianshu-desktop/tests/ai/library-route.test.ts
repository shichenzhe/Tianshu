// @vitest-environment jsdom
// 资料库主机路由化（automation/library 批 2026-11-10）：
// - 本地主机：LibraryApi 读写面 invoke 原通道参数逐字（零行为变化）
// - 远程主机：结构 CRUD + 收藏/打点 + 内容读写经 remote-catalog 适配器
//   → 无头端 library 端点（RemoteLibraryApi mock 为边界）；行形状
//   storagePath/originalPath 兜 null（server wire 刻意剔除，spec §1.4）
// - 深水功能门控：addFiles/importFolder/revealItem 远程态 throw
// - 链接外开与 webview/直链预览为组件层分支（本测只测 api 面）
import { describe, expect, it, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  on: () => () => {},
}));

const remoteLibraryApi = vi.hoisted(() => ({
  list: vi.fn(),
  tree: vi.fn(),
  search: vi.fn(),
  listRecent: vi.fn(),
  listFavorites: vi.fn(),
  createFolder: vi.fn(),
  createFile: vi.fn(),
  addLink: vi.fn(),
  rename: vi.fn(),
  move: vi.fn(),
  delete: vi.fn(),
  subtreeCount: vi.fn(),
  toggleFavorite: vi.fn(),
  markViewed: vi.fn(),
  read: vi.fn(),
  readImage: vi.fn(),
  writeContent: vi.fn(),
}));
vi.mock("../../src-react/domains/ai/server/api/library.api", () => ({
  default: remoteLibraryApi,
}));

vi.mock("../../src-react/domains/ai/server/api/server.api", () => ({
  default: { listConnections: vi.fn() },
  requestRemote: vi.fn(),
  LOCAL_CONNECTION_ID: "local",
  newConnectionId: vi.fn(() => "conn-x"),
  on: () => () => {},
  onRemoteChunk: () => () => {},
  onRemoteEvent: () => () => {},
}));

import {
  useHostStore,
  LOCAL_HOST_CAPS,
} from "../../src-react/domains/ai/data-source/host.store";
import {
  remoteLibraryImage,
  remoteLibraryText,
} from "../../src-react/domains/ai/data-source/remote-catalog";
import LibraryApi from "../../src-react/domains/ai/library/api/library.api";

const REMOTE_ITEM = {
  id: 7,
  parentId: null,
  name: "远程笔记.md",
  kind: "file",
  fileType: "md",
  mimeType: "text/markdown",
  size: 12,
  url: null,
  favorite: false,
  lastViewedAt: null,
  location: [],
  createdAt: "2026-11-10T00:00:00.000Z",
  updatedAt: "2026-11-10T01:00:00.000Z",
};

function switchRemote(): void {
  useHostStore.setState({
    activeHost: { kind: "remote", connId: "conn-x" },
    caps: LOCAL_HOST_CAPS,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useHostStore.setState({
    activeHost: { kind: "local" },
    caps: LOCAL_HOST_CAPS,
  });
});

describe("资料库本地主机（零行为变化）", () => {
  it("list/search/tree/writeFileContent：invoke 原通道参数逐字", async () => {
    invoke.mockResolvedValue({ items: [], breadcrumbs: [] });
    await LibraryApi.list(5);
    expect(invoke).toHaveBeenCalledWith("library:list", 5);
    invoke.mockResolvedValue([]);
    await LibraryApi.search("kw");
    expect(invoke).toHaveBeenCalledWith("library:search", "kw");
    await LibraryApi.tree();
    expect(invoke).toHaveBeenCalledWith("library:tree");
    invoke.mockResolvedValue(REMOTE_ITEM);
    await LibraryApi.writeFileContent(7, "内容");
    expect(invoke).toHaveBeenCalledWith("library:writeFileContent", 7, "内容");
    expect(remoteLibraryApi.list).not.toHaveBeenCalled();
  });

  it("addFiles/revealItem 本地可用（不 throw）", async () => {
    invoke.mockResolvedValue({ added: [], failed: [] });
    await expect(LibraryApi.addFiles(["/tmp/a.md"])).resolves.toEqual({
      added: [],
      failed: [],
    });
    invoke.mockResolvedValue(null);
    await expect(LibraryApi.revealItem(7)).resolves.toBeNull();
  });
});

describe("资料库远程主机（适配器映射）", () => {
  beforeEach(switchRemote);

  it("list：直达端点 → storagePath/originalPath 兜 null", async () => {
    remoteLibraryApi.list.mockResolvedValue({
      items: [REMOTE_ITEM],
      breadcrumbs: [],
    });
    const result = await LibraryApi.list();
    expect(remoteLibraryApi.list).toHaveBeenCalledWith(null, "conn-x");
    expect(result.items[0]).toMatchObject({
      id: 7,
      name: "远程笔记.md",
      storagePath: null,
      originalPath: null,
    });
  });

  it("search/tree/listRecent：读面直达（行形状同款兜底）", async () => {
    remoteLibraryApi.search.mockResolvedValue([REMOTE_ITEM]);
    const rows = await LibraryApi.search("笔记");
    expect(remoteLibraryApi.search).toHaveBeenCalledWith("笔记", "conn-x");
    expect(rows[0].storagePath).toBeNull();

    remoteLibraryApi.tree.mockResolvedValue([REMOTE_ITEM]);
    await LibraryApi.tree();
    expect(remoteLibraryApi.tree).toHaveBeenCalledWith("conn-x");
  });

  it("createFolder/createFile/addLink/rename/move/delete：写面直达", async () => {
    remoteLibraryApi.createFolder.mockResolvedValue(REMOTE_ITEM);
    await LibraryApi.createFolder("新夹", 2);
    expect(remoteLibraryApi.createFolder).toHaveBeenCalledWith(
      "新夹",
      2,
      "conn-x",
    );

    remoteLibraryApi.rename.mockResolvedValue(REMOTE_ITEM);
    await LibraryApi.rename(7, "改名");
    expect(remoteLibraryApi.rename).toHaveBeenCalledWith(7, "改名", "conn-x");

    remoteLibraryApi.move.mockResolvedValue(null);
    await LibraryApi.move([7], 3);
    expect(remoteLibraryApi.move).toHaveBeenCalledWith([7], 3, "conn-x");

    remoteLibraryApi.delete.mockResolvedValue(null);
    await LibraryApi.delete([7]);
    expect(remoteLibraryApi.delete).toHaveBeenCalledWith([7], "conn-x");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("toggleFavorite/markViewed/subtreeCount/writeFileContent：元数据写面直达", async () => {
    remoteLibraryApi.toggleFavorite.mockResolvedValue(REMOTE_ITEM);
    await LibraryApi.toggleFavorite(7);
    expect(remoteLibraryApi.toggleFavorite).toHaveBeenCalledWith(7, "conn-x");

    remoteLibraryApi.subtreeCount.mockResolvedValue(3);
    await expect(LibraryApi.subtreeCount(7)).resolves.toBe(3);

    remoteLibraryApi.writeContent.mockResolvedValue(REMOTE_ITEM);
    await LibraryApi.writeFileContent(7, "新内容");
    expect(remoteLibraryApi.writeContent).toHaveBeenCalledWith(
      7,
      "新内容",
      "conn-x",
    );
  });

  it("内容读：read 文本 / readImage 拼 dataUrl（按 id，无路径凭证）", async () => {
    remoteLibraryApi.read.mockResolvedValue({ kind: "text", content: "# hi" });
    await expect(remoteLibraryText(7, "conn-x")).resolves.toBe("# hi");
    expect(remoteLibraryApi.read).toHaveBeenCalledWith(7, "conn-x");

    remoteLibraryApi.readImage.mockResolvedValue({
      mime: "image/png",
      dataBase64: "aGk=",
    });
    await expect(remoteLibraryImage(7, "conn-x")).resolves.toBe(
      "data:image/png;base64,aGk=",
    );
  });
});

describe("资料库跨端上传与深水门控", () => {
  beforeEach(switchRemote);

  it("addFiles 远程态走主进程组合通道（跨端上传，挂账收口）", async () => {
    invoke.mockResolvedValue({
      added: [REMOTE_ITEM],
      failed: [{ path: "/tmp/big.bin", reason: "超过 3MB 上限" }],
    });
    const result = await LibraryApi.addFiles(["/tmp/a.md", "/tmp/big.bin"], 2);
    expect(invoke).toHaveBeenCalledWith(
      "server:libraryAddFiles",
      { paths: ["/tmp/a.md", "/tmp/big.bin"], parentId: 2 },
      "conn-x",
    );
    expect(result.added[0]).toMatchObject({
      id: 7,
      storagePath: null,
    });
    expect(result.failed[0]).toMatchObject({ reason: "超过 3MB 上限" });
  });

  it("importFolder 远程态走组合通道（目录树跨端导入，挂账收口）", async () => {
    invoke.mockResolvedValue({
      added: [REMOTE_ITEM],
      failed: [],
    });
    const result = await LibraryApi.importFolder("/tmp/docs", 2);
    expect(invoke).toHaveBeenCalledWith(
      "server:libraryImportFolder",
      { dirPath: "/tmp/docs", parentId: 2 },
      "conn-x",
    );
    expect(result.added[0]).toMatchObject({ id: 7 });
  });

  it("revealItem：远程态 throw 且不落本地通道", async () => {
    await expect(LibraryApi.revealItem(7)).rejects.toThrowError(
      /远程主机暂不支持/,
    );
    expect(invoke).not.toHaveBeenCalledWith(
      "library:revealItem",
      expect.anything(),
    );
  });
});

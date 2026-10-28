// A5 资料库批（spec 2026-10-26 §3）：library-tap 实现直测——内存 repo 替身
// 断言 DTO 路径剔除 + 参数序映射；read/readImage 守卫全错误码 + 真临时
// 目录（TIANSHU_DATA_ROOT 隔离）读写闭环。repo 真身禁测（构造注册 IPC）。
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: {
    getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`),
    getAppPath: vi.fn(() => `/tmp/tianshu-test-app-${process.pid}`),
    isPackaged: false,
  },
}));
vi.mock("../../../electron/commons/Log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  createLibraryFace,
  FaceLibraryError,
} from "../../../electron/domains/server-face/library-tap";
import type { LibraryItem } from "../../../src-react/domains/ai/library/api/library.api";

const UID = 7;
let dataRoot = "";

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(os.tmpdir(), "face-library-"));
  process.env.TIANSHU_DATA_ROOT = dataRoot;
});

afterEach(() => {
  delete process.env.TIANSHU_DATA_ROOT;
  rmSync(dataRoot, { recursive: true, force: true });
});

/** 全字段仓储行（含远程 DTO 应剔除的 storagePath/originalPath） */
function makeItem(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: 7,
    parentId: 2,
    name: "笔记.md",
    kind: "file",
    fileType: "markdown",
    mimeType: "text/markdown",
    size: 6,
    originalPath: "/Users/evil/origin.md",
    url: null,
    favorite: false,
    lastViewedAt: null,
    location: ["资料", "工作"],
    storagePath: "/Users/evil/.tianshu/dev/library/7/笔记.md",
    createdAt: "2026-10-26T00:00:00.000Z",
    updatedAt: "2026-10-26T00:00:00.000Z",
    ...overrides,
  };
}

/** 内存 repo 替身：全方法缺省桩，overrides 按需覆写（含调用断言） */
function fakeRepo(overrides: Record<string, unknown> = {}) {
  const item = makeItem();
  const base = {
    get: vi.fn(async () => item),
    list: vi.fn(async () => ({ items: [item], breadcrumbs: [item] })),
    tree: vi.fn(async () => [item]),
    search: vi.fn(async () => [item]),
    listRecent: vi.fn(async () => [item]),
    listFavorites: vi.fn(async () => [item]),
    createFolder: vi.fn(async () => item),
    createFile: vi.fn(async () => item),
    addLink: vi.fn(async () => item),
    rename: vi.fn(async () => item),
    move: vi.fn(async () => null),
    delete: vi.fn(async () => null),
    subtreeCount: vi.fn(async () => 3),
    toggleFavorite: vi.fn(async () => item),
    markViewed: vi.fn(async () => item),
    writeFileContent: vi.fn(async () => item),
    uploadFileBuffer: vi.fn(async () => item),
  };
  return {
    repo: { ...base, ...overrides } as unknown as Parameters<
      typeof createLibraryFace
    >[0],
    base,
  };
}

const DTO_SHAPE = {
  id: 7,
  parentId: 2,
  name: "笔记.md",
  kind: "file",
  fileType: "markdown",
  mimeType: "text/markdown",
  size: 6,
  url: null,
  favorite: false,
  lastViewedAt: null,
  location: ["资料", "工作"],
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
};

/** 落盘文件到 {dataRoot}/dev/library/{id}/{name} 并返回对应条目 */
function seedDiskFile(id: number, name: string, content: Buffer | string) {
  const dir = path.join(dataRoot, "dev", "library", String(id));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), content);
  return makeItem({ id, name });
}

describe("library-tap 实现（A5 桌面被控面）", () => {
  it("DTO 剔除：list/tree/search/recent/favorites 出参无 storagePath/originalPath", async () => {
    const { repo } = fakeRepo();
    const face = createLibraryFace(repo);

    const list = await face.list(UID, 2);
    expect(list.items[0]).toEqual(DTO_SHAPE);
    expect(list.breadcrumbs[0]).toEqual(DTO_SHAPE);
    for (const dto of [list.items[0], list.breadcrumbs[0]]) {
      expect(dto).not.toHaveProperty("storagePath");
      expect(dto).not.toHaveProperty("originalPath");
    }
    expect(await face.tree(UID)).toEqual([DTO_SHAPE]);
    expect(await face.search(UID, "笔记")).toEqual([DTO_SHAPE]);
    expect(await face.listRecent(UID)).toEqual([DTO_SHAPE]);
    expect(await face.listFavorites(UID)).toEqual([DTO_SHAPE]);
  });

  it("userId 前置映射：repo 方法按 (业务参..., userId) 旧序调用", async () => {
    const { repo, base } = fakeRepo();
    const face = createLibraryFace(repo);

    await face.createFolder(UID, " 新夹 ", null);
    expect(base.createFolder).toHaveBeenCalledWith(" 新夹 ", null, UID);
    await face.addLink(UID, "https://a.com", null, 2);
    expect(base.addLink).toHaveBeenCalledWith("https://a.com", null, 2, UID);
    await face.rename(UID, 5, "x");
    expect(base.rename).toHaveBeenCalledWith(5, "x", UID);
    await face.move(UID, [1, 2], null);
    expect(base.move).toHaveBeenCalledWith([1, 2], null, UID);
    await face.delete(UID, [9]);
    expect(base.delete).toHaveBeenCalledWith([9], UID);
    await face.subtreeCount(UID, 4);
    expect(base.subtreeCount).toHaveBeenCalledWith(4, UID);
    await face.toggleFavorite(UID, 6);
    expect(base.toggleFavorite).toHaveBeenCalledWith(6, UID);
    await face.markViewed(UID, 6);
    expect(base.markViewed).toHaveBeenCalledWith(6, UID);
    await face.list(UID, null);
    expect(base.list).toHaveBeenCalledWith(null, UID);
  });

  it("read：真临时目录读文本；不存在 LIBRARY_NOT_FOUND；folder LIBRARY_NOT_FILE", async () => {
    seedDiskFile(7, "笔记.md", "你好世界");
    const { repo } = fakeRepo();
    const face = createLibraryFace(repo);
    expect(await face.read(UID, 7)).toEqual({
      kind: "text",
      content: "你好世界",
    });

    const missing = fakeRepo({ get: vi.fn(async () => null) });
    await expect(
      createLibraryFace(missing.repo).read(UID, 7),
    ).rejects.toMatchObject({ code: "LIBRARY_NOT_FOUND" });
    const folder = fakeRepo({
      get: vi.fn(async () => makeItem({ kind: "folder" })),
    });
    await expect(
      createLibraryFace(folder.repo).read(UID, 7),
    ).rejects.toMatchObject({ code: "LIBRARY_NOT_FILE" });
  });

  it("read：>512KB LIBRARY_TOO_LARGE；NUL 字节 LIBRARY_BINARY；磁盘缺失 LIBRARY_READ_FAILED", async () => {
    const bigItem = seedDiskFile(7, "big.md", Buffer.alloc(512 * 1024 + 1, 65));
    const bigRepo = fakeRepo({ get: vi.fn(async () => bigItem) });
    await expect(
      createLibraryFace(bigRepo.repo).read(UID, 7),
    ).rejects.toMatchObject({ code: "LIBRARY_TOO_LARGE" });

    const binItem = seedDiskFile(8, "bin.md", Buffer.from([104, 105, 0, 1]));
    const binRepo = fakeRepo({ get: vi.fn(async () => binItem) });
    await expect(
      createLibraryFace(binRepo.repo).read(UID, 8),
    ).rejects.toMatchObject({ code: "LIBRARY_BINARY" });

    const ghost = makeItem({ id: 404, name: "ghost.md" });
    const ghostRepo = fakeRepo({ get: vi.fn(async () => ghost) });
    await expect(
      createLibraryFace(ghostRepo.repo).read(UID, 404),
    ).rejects.toMatchObject({ code: "LIBRARY_READ_FAILED" });
  });

  it("readImage：png happy path 出 mime+base64；非白名单扩展 LIBRARY_BINARY", async () => {
    const png = Buffer.from([137, 80, 78, 71, 1, 2, 3]);
    const item = seedDiskFile(7, "pic.png", png);
    const { repo } = fakeRepo({ get: vi.fn(async () => item) });
    const face = createLibraryFace(repo);
    expect(await face.readImage(UID, 7)).toEqual({
      mime: "image/png",
      dataBase64: png.toString("base64"),
    });

    const txt = seedDiskFile(9, "t.txt", "hi");
    const txtRepo = fakeRepo({ get: vi.fn(async () => txt) });
    await expect(
      createLibraryFace(txtRepo.repo).readImage(UID, 9),
    ).rejects.toMatchObject({ code: "LIBRARY_BINARY" });
  });

  it("readImage：svg 放行（A5 尾，出 mime image/svg+xml）；bmp/ico 仍拒", async () => {
    const svgContent = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    const svg = seedDiskFile(8, "v.svg", svgContent);
    const svgRepo = fakeRepo({ get: vi.fn(async () => svg) });
    expect(await createLibraryFace(svgRepo.repo).readImage(UID, 8)).toEqual({
      mime: "image/svg+xml",
      dataBase64: Buffer.from(svgContent, "utf8").toString("base64"),
    });

    const bmp = seedDiskFile(9, "pic.bmp", Buffer.from([66, 77, 1, 2]));
    const bmpRepo = fakeRepo({ get: vi.fn(async () => bmp) });
    await expect(
      createLibraryFace(bmpRepo.repo).readImage(UID, 9),
    ).rejects.toMatchObject({ code: "LIBRARY_BINARY" });
    const ico = seedDiskFile(10, "favicon.ico", Buffer.from([0, 0, 1, 0]));
    const icoRepo = fakeRepo({ get: vi.fn(async () => ico) });
    await expect(
      createLibraryFace(icoRepo.repo).readImage(UID, 10),
    ).rejects.toMatchObject({ code: "LIBRARY_BINARY" });
  });

  it("readImage：>10MB LIBRARY_TOO_LARGE；folder 先行 LIBRARY_NOT_FILE", async () => {
    const big = seedDiskFile(7, "big.png", Buffer.alloc(10 * 1024 * 1024 + 1));
    const { repo } = fakeRepo({ get: vi.fn(async () => big) });
    await expect(
      createLibraryFace(repo).readImage(UID, 7),
    ).rejects.toMatchObject({ code: "LIBRARY_TOO_LARGE" });

    const folder = fakeRepo({
      get: vi.fn(async () => makeItem({ kind: "folder" })),
    });
    await expect(
      createLibraryFace(folder.repo).readImage(UID, 7),
    ).rejects.toMatchObject({ code: "LIBRARY_NOT_FILE" });
  });

  it("writeContent：覆写成功回传刷新 DTO（size/updatedAt 来自 repo 写后行）", async () => {
    const item = seedDiskFile(7, "笔记.md", "旧内容");
    const updated = makeItem({
      id: 7,
      size: 9,
      updatedAt: "2026-10-26T08:00:00.000Z",
    });
    const writeFileContent = vi.fn(async () => updated);
    const { repo } = fakeRepo({
      get: vi.fn(async () => item),
      writeFileContent,
    });
    const face = createLibraryFace(repo);

    const dto = await face.writeContent(UID, 7, "新内容啊");
    // repo 单写路径：(id, content, userId) 旧序 + 回传 DTO 剔除本机路径
    expect(writeFileContent).toHaveBeenCalledWith(7, "新内容啊", UID);
    expect(dto).toEqual({
      ...DTO_SHAPE,
      size: 9,
      updatedAt: updated.updatedAt,
    });
    expect(dto).not.toHaveProperty("storagePath");
    expect(dto).not.toHaveProperty("originalPath");
  });

  it("writeContent：归属拒——不存在 LIBRARY_NOT_FOUND；folder LIBRARY_NOT_FILE（写路径不触达）", async () => {
    const missing = fakeRepo({
      get: vi.fn(async () => null),
    });
    await expect(
      createLibraryFace(missing.repo).writeContent(UID, 7, "x"),
    ).rejects.toMatchObject({ code: "LIBRARY_NOT_FOUND" });
    expect(missing.base.writeFileContent).not.toHaveBeenCalled();

    const folder = fakeRepo({
      get: vi.fn(async () => makeItem({ kind: "folder" })),
    });
    await expect(
      createLibraryFace(folder.repo).writeContent(UID, 7, "x"),
    ).rejects.toMatchObject({ code: "LIBRARY_NOT_FILE" });
    expect(folder.base.writeFileContent).not.toHaveBeenCalled();
  });

  it("writeContent：>512KiB（utf8 字节）LIBRARY_TOO_LARGE 前置拦截不写盘", async () => {
    const item = seedDiskFile(7, "笔记.md", "旧内容");
    const { repo, base } = fakeRepo({
      get: vi.fn(async () => item),
    });
    // 513KiB 全 "a"（单字节字符，字节数=字符数）
    const oversize = "a".repeat(512 * 1024 + 1);
    await expect(
      createLibraryFace(repo).writeContent(UID, 7, oversize),
    ).rejects.toMatchObject({ code: "LIBRARY_TOO_LARGE" });
    expect(base.writeFileContent).not.toHaveBeenCalled();
  });

  it("writeContent：写盘失败 LIBRARY_WRITE_FAILED（repo 抛错兜底新码）", async () => {
    const item = seedDiskFile(7, "笔记.md", "旧内容");
    const writeFileContent = vi.fn(async () => {
      throw new Error("磁盘只读");
    });
    const { repo } = fakeRepo({
      get: vi.fn(async () => item),
      writeFileContent,
    });
    await expect(
      createLibraryFace(repo).writeContent(UID, 7, "新内容"),
    ).rejects.toMatchObject({
      code: "LIBRARY_WRITE_FAILED",
      message: "写入失败",
    });
    expect(writeFileContent).toHaveBeenCalledTimes(1);
  });

  it("FaceLibraryError 携带稳定 code（routes 层透传 bizError 信封）", () => {
    const error = new FaceLibraryError("LIBRARY_NOT_FOUND", "资料库条目不存在");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("LIBRARY_NOT_FOUND");
    expect(error.message).toBe("资料库条目不存在");
  });
});

describe("library-tap uploadFile（资料库上传批）", () => {
  const PNG_BUF = Buffer.from([137, 80, 78, 71, 1, 2, 3]);
  const PNG_B64 = PNG_BUF.toString("base64");

  it("解码达 repo：buffer + 清洗名 + parentId 旧序调用；DTO 回传剔除本机路径", async () => {
    const uploaded = makeItem({
      name: "pic.png",
      fileType: "image",
      mimeType: "image/png",
      size: PNG_BUF.length,
    });
    const uploadFileBuffer = vi.fn(async () => uploaded);
    const { repo } = fakeRepo({ uploadFileBuffer });
    const face = createLibraryFace(repo);

    const dto = await face.uploadFile(UID, {
      parentId: 3,
      name: "pic.png",
      base64: PNG_B64,
    });
    // 解码后字节内容一致；参数序 (name, buf, folderId, userId) 同 repo 惯例
    const [nameArg, bufArg, folderArg, uidArg] = uploadFileBuffer.mock.calls[0];
    expect(nameArg).toBe("pic.png");
    expect((bufArg as Buffer).equals(PNG_BUF)).toBe(true);
    expect(folderArg).toBe(3);
    expect(uidArg).toBe(UID);
    expect(dto).toEqual({
      ...DTO_SHAPE,
      name: "pic.png",
      fileType: "image",
      mimeType: "image/png",
      size: PNG_BUF.length,
    });
    expect(dto).not.toHaveProperty("storagePath");
    expect(dto).not.toHaveProperty("originalPath");

    // parentId 缺省 → null 根层
    await face.uploadFile(UID, { name: "a.txt", base64: "" });
    expect(uploadFileBuffer.mock.calls[1][2]).toBeNull();
  });

  it("超限拒：解码 >3MB LIBRARY_UPLOAD_INVALID，repo 不触达", async () => {
    const { repo, base } = fakeRepo();
    const big = Buffer.alloc(3 * 1024 * 1024 + 1, 65).toString("base64");
    await expect(
      createLibraryFace(repo).uploadFile(UID, {
        name: "big.bin",
        base64: big,
      }),
    ).rejects.toMatchObject({
      code: "LIBRARY_UPLOAD_INVALID",
      message: "文件超过 3MB 上限",
    });
    expect(base.uploadFileBuffer).not.toHaveBeenCalled();
  });

  it("坏 base64 拒（字符集非法/不对齐/填充位错）；同码 LIBRARY_UPLOAD_INVALID", async () => {
    const { repo, base } = fakeRepo();
    for (const bad of ["a$==", "abc", "QU=JD", "===="]) {
      await expect(
        createLibraryFace(repo).uploadFile(UID, {
          name: "a.txt",
          base64: bad,
        }),
      ).rejects.toMatchObject({ code: "LIBRARY_UPLOAD_INVALID" });
    }
    expect(base.uploadFileBuffer).not.toHaveBeenCalled();
  });

  it("空名/非法文件名拒：清洗后为空 LIBRARY_UPLOAD_INVALID，repo 不触达", async () => {
    const { repo, base } = fakeRepo();
    for (const badName of ["   ", "???", String.fromCharCode(0)]) {
      await expect(
        createLibraryFace(repo).uploadFile(UID, {
          name: badName,
          base64: PNG_B64,
        }),
      ).rejects.toMatchObject({
        code: "LIBRARY_UPLOAD_INVALID",
        message: "文件名非法",
      });
    }
    expect(base.uploadFileBuffer).not.toHaveBeenCalled();
  });

  it("分类推断随 repo 建行：DTO fileType/mime 透传（推断本体在 repo/utils 已钉）", async () => {
    const uploaded = makeItem({
      name: "数据.csv",
      fileType: "spreadsheet",
      mimeType: "text/csv",
    });
    const uploadFileBuffer = vi.fn(async () => uploaded);
    const { repo } = fakeRepo({ uploadFileBuffer });
    const dto = await createLibraryFace(repo).uploadFile(UID, {
      name: "数据.csv",
      base64: PNG_B64,
    });
    expect(dto.fileType).toBe("spreadsheet");
    expect(dto.mimeType).toBe("text/csv");
  });

  it("归属拒沿用 LIBRARY_NOT_FOUND：parentId 不存在/非文件夹，repo 抛错映射", async () => {
    const missing = fakeRepo({
      uploadFileBuffer: vi.fn(async () => {
        throw new Error("条目不存在");
      }),
    });
    await expect(
      createLibraryFace(missing.repo).uploadFile(UID, {
        parentId: 999,
        name: "a.txt",
        base64: PNG_B64,
      }),
    ).rejects.toMatchObject({
      code: "LIBRARY_NOT_FOUND",
      message: "资料库条目不存在",
    });

    const notFolder = fakeRepo({
      uploadFileBuffer: vi.fn(async () => {
        throw new Error("上级必须是文件夹");
      }),
    });
    await expect(
      createLibraryFace(notFolder.repo).uploadFile(UID, {
        parentId: 5,
        name: "a.txt",
        base64: PNG_B64,
      }),
    ).rejects.toMatchObject({ code: "LIBRARY_NOT_FOUND" });
  });

  it("写盘失败 repo 错误收 LIBRARY_WRITE_FAILED（对齐无头端上传面口径）", async () => {
    const boom = fakeRepo({
      uploadFileBuffer: vi.fn(async () => {
        throw new Error("磁盘只读");
      }),
    });
    await expect(
      createLibraryFace(boom.repo).uploadFile(UID, {
        name: "a.txt",
        base64: PNG_B64,
      }),
    ).rejects.toMatchObject({
      code: "LIBRARY_WRITE_FAILED",
      message: expect.stringContaining("磁盘只读"),
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-document-picker", () => ({
  getDocumentAsync: vi.fn(),
}));

vi.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: vi.fn(),
}));

// 图片分流链替身（image-pick：uri → {name, base64}；超限抛 ImageTooLargeError）
vi.mock("./image-pick", () => {
  class ImageTooLargeError extends Error {}
  return {
    ImageTooLargeError,
    imageUriAsBase64: vi.fn(),
  };
});

import { ImageTooLargeError, imageUriAsBase64 } from "./image-pick";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { FILE_LIMIT_BYTES, isImageFile, isTextLike, pickLocalFiles } from "./file-pick";

const getDocumentAsync = vi.mocked(DocumentPicker.getDocumentAsync);
const imageUriAsBase64Mock = vi.mocked(imageUriAsBase64);
const launchImageLibraryAsync = vi.mocked(ImagePicker.launchImageLibraryAsync);

/** fetch stub 数据面：uri → { ok?, size, text }（blob 替身字段；ok=false
 *  模拟读取失败 → fetchBlob 抛 FETCH_xxx → 拒绝原因 read） */
type FakeBlob = { size: number; text: string; ok?: boolean };
let fetchFiles: Record<string, FakeBlob>;
const fetchMock = vi.fn(async (uri: string) => {
  const f = fetchFiles[uri];
  if (f == null || f.ok === false) {
    return {
      ok: false,
      status: 500,
      blob: async () => {
        throw new Error("no blob");
      },
    };
  }
  return { ok: true, status: 200, blob: async () => f };
});

/** 简版 FileReader 替身（node 环境无原生 FileReader）：构造函数接受
 *  blob 存实例字段，readAs* 同步触发 onload；dataURL 形如
 *  data:application/octet-stream;base64,<base64>，text 直接回内容 */
class FileReaderStub {
  result: string | ArrayBuffer | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  blob: FakeBlob | null = null;
  constructor(blob?: FakeBlob | null) {
    this.blob = blob ?? null;
  }
  readAsDataURL(blob: FakeBlob): void {
    this.blob = blob;
    this.result =
      "data:application/octet-stream;base64," +
      Buffer.from(blob.text, "utf8").toString("base64");
    this.onload?.();
  }
  readAsText(blob: FakeBlob): void {
    this.blob = blob;
    this.result = blob.text;
    this.onload?.();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchFiles = {};
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("FileReader", FileReaderStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("file-pick 文本判定与上限（对齐桌面 pickAndRead 守卫）", () => {
  it("512KB 上限对齐桌面 READ_LIMIT", () => {
    expect(FILE_LIMIT_BYTES).toBe(512 * 1024);
  });

  it("isTextLike：纯文本过、含 NUL（二进制）拒", () => {
    expect(isTextLike("你好，world\n第二行")).toBe(true);
    expect(isTextLike("abc def")).toBe(true);
    expect(isTextLike("abc\u0000def")).toBe(false);
    expect(isTextLike("文本\u0000尾部")).toBe(false);
  });
});

describe("file-pick 图片分流（融合批：单入口按类型分流）", () => {
  it("isImageFile：mime 优先、缺省回落扩展名（大小写不敏感）", () => {
    expect(isImageFile("a.png", "image/png")).toBe(true);
    expect(isImageFile("a.txt", "image/jpeg")).toBe(true); // mime 优先于扩展名
    expect(isImageFile("photo.JPG")).toBe(true);
    expect(isImageFile("photo.webp", null)).toBe(true);
    expect(isImageFile("noext", null)).toBe(false);
    expect(isImageFile("a.txt", "text/plain")).toBe(false);
    expect(isImageFile("a.txt", null)).toBe(false);
    expect(isImageFile("a.dat", "")).toBe(false); // 空 mime 回落扩展名
  });

  it("图片文件走多模态链（不 UTF-8 读取）、文本文件走注入链，互不干扰", async () => {
    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [
        { uri: "file://img.jpg", name: "img.jpg", mimeType: "image/jpeg" },
        { uri: "file://doc.md", name: "doc.md", mimeType: "text/markdown" },
      ],
    } as never);
    imageUriAsBase64Mock.mockResolvedValue({ name: "img.jpg", base64: "QUJD" });
    fetchFiles["file://doc.md"] = { size: 10, text: "markdown 内容" };

    const r = await pickLocalFiles();
    expect(r?.images).toHaveLength(1);
    expect(r?.picked).toEqual([{ name: "doc.md", content: "markdown 内容" }]);
    expect(r?.rejected).toEqual([]);
    // 图片不进文本读取（不 fetch）；文本不进图片链（size 探测 + 读取各一次）
    expect(imageUriAsBase64Mock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      "file://doc.md",
      "file://doc.md",
    ]);
  });

  it("图片链超限（压缩尽力后仍超 3MB）→ rejected imageTooLarge", async () => {
    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file://huge.png", name: "huge.png" }],
    } as never);
    imageUriAsBase64Mock.mockRejectedValue(new ImageTooLargeError());

    const r = await pickLocalFiles();
    expect(r?.images).toEqual([]);
    expect(r?.rejected).toEqual([{ name: "huge.png", reason: "imageTooLarge" }]);
  });

  it("文本链拒绝语义不变：超 512KB → tooLarge；NUL → binary；读炸 → read", async () => {
    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [
        { uri: "file://big.txt", name: "big.txt" },
        { uri: "file://bin.pdf", name: "bin.pdf" },
        { uri: "file://err.md", name: "err.md" },
      ],
    } as never);
    fetchFiles["file://big.txt"] = { size: FILE_LIMIT_BYTES + 1, text: "" };
    fetchFiles["file://bin.pdf"] = { size: 10, text: "a\u0000b" };
    fetchFiles["file://err.md"] = { size: 10, text: "", ok: false };

    const r = await pickLocalFiles();
    expect(r?.picked).toEqual([]);
    expect(r?.rejected).toEqual([
      { name: "big.txt", reason: "tooLarge" },
      { name: "bin.pdf", reason: "binary" },
      { name: "err.md", reason: "read" },
    ]);
  });

  it("取消/空选返回 null", async () => {
    getDocumentAsync.mockResolvedValue({ canceled: true, assets: [] } as never);
    await expect(pickLocalFiles()).resolves.toBeNull();
  });
});

describe("file-pick document-picker 拒绝回退相册（真机选图失败收敛）", () => {
  it("getDocumentAsync reject + 相册选图成功 → images 填充且走 imageUriAsBase64 链", async () => {
    getDocumentAsync.mockRejectedValue(new Error("iCloud 拷贝失败"));
    launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: "ph://lib/IMG-001", fileName: "IMG-001.jpg" }],
    } as never);
    imageUriAsBase64Mock.mockResolvedValue({ name: "IMG-001.jpg", base64: "cGhvdG8=" });

    const r = await pickLocalFiles();
    expect(r).toEqual({
      picked: [],
      images: [{ name: "IMG-001.jpg", base64: "cGhvdG8=" }],
      rejected: [],
    });
    expect(launchImageLibraryAsync).toHaveBeenCalledWith({
      mediaTypes: ["images"],
      quality: 1,
      allowsMultipleSelection: false,
    });
    expect(imageUriAsBase64Mock).toHaveBeenCalledTimes(1);
    expect(imageUriAsBase64Mock).toHaveBeenCalledWith("ph://lib/IMG-001", "IMG-001.jpg");
  });

  it("getDocumentAsync reject + 相册取消 → 视为整体取消返回 null", async () => {
    getDocumentAsync.mockRejectedValue(new Error("iCloud 拷贝失败"));
    launchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: [] } as never);

    await expect(pickLocalFiles()).resolves.toBeNull();
    expect(imageUriAsBase64Mock).not.toHaveBeenCalled();
  });
});

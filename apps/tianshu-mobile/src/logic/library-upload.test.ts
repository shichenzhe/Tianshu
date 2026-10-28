import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-document-picker", () => ({
  getDocumentAsync: vi.fn(),
}));

import * as DocumentPicker from "expo-document-picker";
import {
  LIBRARY_UPLOAD_LIMIT_BYTES,
  hasValidExtension,
  pickLibraryFile,
} from "./library-upload";

const getDocumentAsync = vi.mocked(DocumentPicker.getDocumentAsync);

/** fetch stub 数据面：uri → { ok?, size, text }（blob 替身字段） */
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

/** FileReader 替身（node 无原生 FileReader；dataURL 带 data: 前缀，
 *  验证剥前缀逻辑） */
class FileReaderStub {
  result: string | ArrayBuffer | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(blob: FakeBlob): void {
    this.result =
      "data:application/octet-stream;base64," +
      Buffer.from(blob.text, "utf8").toString("base64");
    this.onload?.();
  }
  readAsText(blob: FakeBlob): void {
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

describe("library-upload 文件选择链（资料库上传批）", () => {
  it("3MB 上限对齐 skills zip / files uploadImage 口径", () => {
    expect(LIBRARY_UPLOAD_LIMIT_BYTES).toBe(3 * 1024 * 1024);
  });

  it("hasValidExtension：拒无扩展名/点开头/尾点，收多级扩展名", () => {
    expect(hasValidExtension("报告.pdf")).toBe(true);
    expect(hasValidExtension("archive.tar.gz")).toBe(true);
    expect(hasValidExtension("README")).toBe(false);
    expect(hasValidExtension("archive.")).toBe(false);
    expect(hasValidExtension(".gitignore")).toBe(false);
    expect(hasValidExtension("")).toBe(false);
  });

  it("选 .pdf → fetch blob → FileReader base64（剥 data: 前缀）", async () => {
    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file://report.pdf", name: "report.pdf" }],
    } as never);
    fetchFiles["file://report.pdf"] = { size: 10, text: "pdf-bytes" };

    const result = await pickLibraryFile();
    expect(result).toEqual({
      name: "report.pdf",
      base64: Buffer.from("pdf-bytes", "utf8").toString("base64"),
    });
    expect(getDocumentAsync).toHaveBeenCalledWith({
      copyToCacheDirectory: true,
    });
  });

  it("扩展名守卫：无扩展名返回 invalid 且不读文件", async () => {
    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file://README", name: "README" }],
    } as never);

    await expect(pickLibraryFile()).resolves.toBe("invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("name 缺失时回退 uri 尾段做扩展名守卫", async () => {
    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file://no-name.bin" }],
    } as never);
    fetchFiles["file://no-name.bin"] = { size: 3, text: "x" };

    const result = await pickLibraryFile();
    expect(result).toMatchObject({ name: "no-name.bin" });
  });

  it("超 3MB 返回 tooLarge（不读 base64）", async () => {
    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file://big.zip", name: "big.zip" }],
    } as never);
    fetchFiles["file://big.zip"] = {
      size: LIBRARY_UPLOAD_LIMIT_BYTES + 1,
      text: "",
    };

    await expect(pickLibraryFile()).resolves.toBe("tooLarge");
  });

  it("取消/空选返回 null", async () => {
    getDocumentAsync.mockResolvedValue({
      canceled: true,
      assets: [],
    } as never);
    await expect(pickLibraryFile()).resolves.toBeNull();
  });

  it("uri 读取失败（fetch 非 ok）抛错交调用方 toast", async () => {
    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file://err.pdf", name: "err.pdf" }],
    } as never);
    fetchFiles["file://err.pdf"] = { size: 1, text: "", ok: false };

    await expect(pickLibraryFile()).rejects.toThrow("FETCH_500");
  });
});

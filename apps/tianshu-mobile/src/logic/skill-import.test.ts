import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-document-picker", () => ({
  getDocumentAsync: vi.fn(),
}));

import * as DocumentPicker from "expo-document-picker";
import { SKILL_ZIP_LIMIT_BYTES, pickSkillZip } from "./skill-import";

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

describe("skill-import zip 选择链（A3 尾）", () => {
  it("3MB 上限对齐 files/uploadImage 口径", () => {
    expect(SKILL_ZIP_LIMIT_BYTES).toBe(3 * 1024 * 1024);
  });

  it("选 .zip → fetch blob → FileReader base64（剥 data: 前缀）", async () => {
    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file://pkg.zip", name: "pkg.zip" }],
    } as never);
    fetchFiles["file://pkg.zip"] = { size: 10, text: "zip-bytes" };

    const result = await pickSkillZip();
    expect(result).toEqual({
      name: "pkg.zip",
      base64: Buffer.from("zip-bytes", "utf8").toString("base64"),
    });
    expect(getDocumentAsync).toHaveBeenCalledWith({
      copyToCacheDirectory: true,
    });
  });

  it("扩展名守卫：非 .zip（大小写敏感判 .ZIP 合法）返回 invalid", async () => {
    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file://doc.txt", name: "doc.txt" }],
    } as never);

    await expect(pickSkillZip()).resolves.toBe("invalid");
    expect(fetchMock).not.toHaveBeenCalled();

    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file://pkg.ZIP", name: "pkg.ZIP" }],
    } as never);
    fetchFiles["file://pkg.ZIP"] = { size: 3, text: "x" };
    const result = await pickSkillZip();
    expect(result).toMatchObject({ name: "pkg.ZIP" });
  });

  it("超 3MB 返回 tooLarge（不读 base64）", async () => {
    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file://big.zip", name: "big.zip" }],
    } as never);
    fetchFiles["file://big.zip"] = {
      size: SKILL_ZIP_LIMIT_BYTES + 1,
      text: "",
    };

    await expect(pickSkillZip()).resolves.toBe("tooLarge");
  });

  it("取消/空选返回 null", async () => {
    getDocumentAsync.mockResolvedValue({
      canceled: true,
      assets: [],
    } as never);
    await expect(pickSkillZip()).resolves.toBeNull();
  });

  it("uri 读取失败（fetch 非 ok）抛错交调用方 toast", async () => {
    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file://err.zip", name: "err.zip" }],
    } as never);
    fetchFiles["file://err.zip"] = { size: 1, text: "", ok: false };

    await expect(pickSkillZip()).rejects.toThrow("FETCH_500");
  });
});

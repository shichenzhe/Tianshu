import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-document-picker", () => ({
  getDocumentAsync: vi.fn(),
}));

// file-pick 依赖链替身（isTextLike 复用；expo 真身触 __DEV__ 全局未定义，
// image-pick 真身拉 react-native Flow 入口——同 file-pick.test 双 mock 口径）
vi.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: vi.fn(),
}));

vi.mock("./image-pick", () => ({
  imageUriAsBase64: vi.fn(),
  ImageTooLargeError: class ImageTooLargeError extends Error {},
}));

import * as DocumentPicker from "expo-document-picker";
import {
  EXPERT_EXPORT_KIND,
  EXPERT_JSON_LIMIT_BYTES,
  ExpertImportFileError,
  parseExpertImportPreview,
  pickExpertJsonFile,
} from "./expert-import";

const getDocumentAsync = vi.mocked(DocumentPicker.getDocumentAsync);

/** fetch stub 数据面：uri → { size, text }（blob 替身字段） */
type FakeBlob = { size: number; text: string };
let fetchFiles: Record<string, FakeBlob>;
const fetchMock = vi.fn(async (uri: string) => {
  const f = fetchFiles[uri];
  if (f == null) {
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

/** 简版 FileReader 替身（node 环境无原生 FileReader） */
class FileReaderStub {
  result: string | ArrayBuffer | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsText(blob: FakeBlob): void {
    this.result = blob.text;
    this.onload?.();
  }
}

const VALID_JSON = JSON.stringify({
  kind: EXPERT_EXPORT_KIND,
  version: 1,
  name: "翻译专家",
  description: "中英互译",
  systemPrompt: "你是翻译专家",
});

describe("parseExpertImportPreview", () => {
  it("合法导出 JSON 透出名称与描述", () => {
    const result = parseExpertImportPreview(VALID_JSON);
    expect(result).toEqual({
      ok: true,
      name: "翻译专家",
      description: "中英互译",
    });
  });

  it("描述缺省回退 null（可选字段）", () => {
    const result = parseExpertImportPreview(
      JSON.stringify({
        kind: EXPERT_EXPORT_KIND,
        version: 1,
        name: "翻译专家",
        systemPrompt: "x",
      }),
    );
    expect(result).toEqual({
      ok: true,
      name: "翻译专家",
      description: null,
    });
  });

  it("坏 JSON 拒绝（badJson）", () => {
    expect(parseExpertImportPreview("{oops")).toEqual({
      ok: false,
      reason: "badJson",
    });
  });

  it("kind 不符拒绝（badKind）", () => {
    expect(
      parseExpertImportPreview(
        JSON.stringify({ kind: "other", version: 1, name: "x" }),
      ),
    ).toEqual({ ok: false, reason: "badKind" });
  });

  it("非对象 JSON 拒绝（badKind）", () => {
    expect(parseExpertImportPreview('"just a string"')).toEqual({
      ok: false,
      reason: "badKind",
    });
  });

  it("缺 name / name 空白拒绝（missingName）", () => {
    expect(
      parseExpertImportPreview(
        JSON.stringify({ kind: EXPERT_EXPORT_KIND, version: 1 }),
      ),
    ).toEqual({ ok: false, reason: "missingName" });
    expect(
      parseExpertImportPreview(
        JSON.stringify({ kind: EXPERT_EXPORT_KIND, version: 1, name: "  " }),
      ),
    ).toEqual({ ok: false, reason: "missingName" });
  });
});

describe("pickExpertJsonFile", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("FileReader", FileReaderStub);
    getDocumentAsync.mockReset();
    fetchMock.mockClear();
    fetchFiles = {};
  });

  it("单选 .json 读取文本并回文件名（mime 过滤 + 单选参数）", async () => {
    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file:///a/expert.json", name: "expert.json", size: 10 }],
    } as unknown as DocumentPicker.DocumentPickerResult);
    fetchFiles["file:///a/expert.json"] = { size: 10, text: VALID_JSON };
    const picked = await pickExpertJsonFile();
    expect(getDocumentAsync).toHaveBeenCalledWith(
      expect.objectContaining({ multiple: false }),
    );
    expect(picked?.fileName).toBe("expert.json");
    expect(picked?.content).toBe(VALID_JSON);
  });

  it("取消返回 null", async () => {
    getDocumentAsync.mockResolvedValue({
      canceled: true,
      assets: [],
    } as unknown as DocumentPicker.DocumentPickerResult);
    expect(await pickExpertJsonFile()).toBeNull();
  });

  it("超 512KB 拒绝（tooLarge）", async () => {
    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file:///big.json", name: "big.json" }],
    } as unknown as DocumentPicker.DocumentPickerResult);
    fetchFiles["file:///big.json"] = {
      size: EXPERT_JSON_LIMIT_BYTES + 1,
      text: "",
    };
    await expect(pickExpertJsonFile()).rejects.toMatchObject({
      reason: "tooLarge",
    });
  });

  it("二进制内容拒绝（binary——NUL 守卫）", async () => {
    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file:///bin.json", name: "bin.json" }],
    } as unknown as DocumentPicker.DocumentPickerResult);
    fetchFiles["file:///bin.json"] = { size: 4, text: "a\u0000b\u0000" };
    try {
      await pickExpertJsonFile();
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ExpertImportFileError);
      expect((error as ExpertImportFileError).reason).toBe("binary");
    }
  });

  it("读取失败拒绝（read）", async () => {
    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file:///missing.json", name: "missing.json" }],
    } as unknown as DocumentPicker.DocumentPickerResult);
    await expect(pickExpertJsonFile()).rejects.toMatchObject({
      reason: "read",
    });
  });
});

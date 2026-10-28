import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-image-manipulator", () => ({
  manipulateAsync: vi.fn(),
  SaveFormat: { JPEG: "jpeg" },
}));

vi.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: vi.fn(),
}));

import * as ImageManipulator from "expo-image-manipulator";
import {
  IMAGE_LIMIT_BYTES,
  ImageTooLargeError,
  assertWithinLimit,
  decodedBytesOf,
  imageUriAsBase64,
} from "./image-pick";

const manipulateAsync = vi.mocked(ImageManipulator.manipulateAsync);

/** fetch stub 数据面：uri → { size, text }（blob 替身字段） */
type FakeBlob = { size: number; text: string };
let fetchFiles: Record<string, FakeBlob>;
const fetchMock = vi.fn(async (uri: string) => ({
  ok: true,
  status: 200,
  blob: async () => fetchFiles[uri],
}));

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

describe("image-pick 上限", () => {
  it("3MB 边界：等值过、超一拒（消息含 3MB 提示）", () => {
    expect(IMAGE_LIMIT_BYTES).toBe(3 * 1024 * 1024);
    expect(() => assertWithinLimit(IMAGE_LIMIT_BYTES)).not.toThrow();
    expect(() => assertWithinLimit(IMAGE_LIMIT_BYTES + 1)).toThrowError(/3MB/);
  });

  it("decodedBytesOf：padding 折算（无 pad/一 pad/两 pad）", () => {
    // "aGVsbG8=" 8 字符 1 pad → 解码 5 字节
    expect(decodedBytesOf("aGVsbG8=")).toBe(5);
    expect(decodedBytesOf("aGVsbG8h")).toBe(6);
    expect(decodedBytesOf("aGVs")).toBe(3);
  });
});

describe("image-pick imageUriAsBase64（fetch+blob 读取链，真机修复 2026-10-24）", () => {
  it("小图直读：不压缩、base64 直出、名字规整 .jpg", async () => {
    fetchFiles["file://small.png"] = { size: 100, text: "hello" };

    await expect(imageUriAsBase64("file://small.png", "photo.png")).resolves.toEqual(
      { name: "photo.jpg", base64: "aGVsbG8=" },
    );
    expect(manipulateAsync).not.toHaveBeenCalled();
    // 单次 fetch 直读（无压缩轮）
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("file://small.png");
  });

  it("超限自动压缩：原始超 3MB → 压缩链一轮达标 → 读压缩产物", async () => {
    fetchFiles["file://huge.jpg"] = { size: IMAGE_LIMIT_BYTES + 1, text: "x" };
    fetchFiles["file://c1.jpg"] = { size: 200, text: "compressed" };
    manipulateAsync.mockResolvedValue({ uri: "file://c1.jpg" } as never);

    await expect(imageUriAsBase64("file://huge.jpg", "huge.jpg")).resolves.toEqual(
      { name: "huge.jpg", base64: "Y29tcHJlc3NlZA==" },
    );
    expect(manipulateAsync).toHaveBeenCalledTimes(1);
  });

  it("压缩尽力（四轮）仍超 3MB → ImageTooLargeError", async () => {
    fetchFiles["file://huge.jpg"] = { size: IMAGE_LIMIT_BYTES + 1, text: "x" };
    fetchFiles["file://c1.jpg"] = { size: IMAGE_LIMIT_BYTES + 1, text: "x" };
    manipulateAsync.mockResolvedValue({ uri: "file://c1.jpg" } as never);

    await expect(imageUriAsBase64("file://huge.jpg", "huge.jpg")).rejects.toThrow(
      ImageTooLargeError,
    );
    expect(manipulateAsync).toHaveBeenCalledTimes(4);
  });
});

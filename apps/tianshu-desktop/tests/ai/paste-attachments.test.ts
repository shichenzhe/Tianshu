// tests/ai/paste-attachments.test.ts
/**
 * 粘贴附件分流纯函数（WorkBuddy 剪贴板工程经验移植）：
 * - collectPasteFiles：DataTransfer items 只收 kind=file（截图 blob/Finder
 *   文件），文本项与 getAsFile 空项忽略
 * - categorizePastedFiles：可解出磁盘路径 → pathEntries（授权随 preload
 *   getPathForFile 自动登记）；无路径图片 → imageBlobs（钉字节转 base64
 *   落盘）；size-0 图片（macOS 截图坑）→ needsClipboardFallback 走主进程
 *   clipboard.readImage 兜底
 * - isOverLimit：10MB 上限（与 HTTP 节点 binary 同口径）
 * - blobToBase64：无前缀 base64（IPC 直传主进程写盘）
 */
import { describe, expect, it } from "vitest";
import {
  blobToBase64,
  categorizePastedFiles,
  collectPasteFiles,
  isOverLimit,
  PASTED_IMAGE_LIMIT_BYTES,
} from "../../src-react/domains/ai/chat/lib/paste-attachments";

/** DataTransfer.items 鸭子构造（jsdom 无原生实现） */
const dtItems = (
  ...entries: Array<{
    kind: string;
    type?: string;
    file?: File | null;
  }>
) =>
  entries.map((e) => ({
    kind: e.kind,
    type: e.type ?? "",
    getAsFile: () => e.file ?? null,
  })) as unknown as DataTransferItemList;

const pngBlob = (name = "image.png", size = 100, type = "image/png") =>
  new File([new Uint8Array(size)], name, { type });

describe("collectPasteFiles", () => {
  it("只收 kind=file 项；文本项与 getAsFile 空项忽略", () => {
    const file = pngBlob();
    const files = collectPasteFiles(
      dtItems(
        { kind: "string", type: "text/plain" },
        { kind: "file", type: "image/png", file },
        { kind: "file", type: "image/png", file: null },
      ),
    );
    expect(files).toEqual([file]);
  });

  it("空 items 返回空数组", () => {
    expect(collectPasteFiles(dtItems())).toEqual([]);
  });
});

describe("categorizePastedFiles", () => {
  it("可解出路径的文件 → pathEntries（原样 File 传桥，防 JS 构造 File 解不出路径）", () => {
    const file = pngBlob("a.txt", 10, "text/plain");
    const { pathEntries, imageBlobs, needsClipboardFallback } =
      categorizePastedFiles([file], (f) =>
        f === file ? "/Users/x/a.txt" : "",
      );
    expect(pathEntries).toEqual([{ name: "a.txt", path: "/Users/x/a.txt" }]);
    expect(imageBlobs).toEqual([]);
    expect(needsClipboardFallback).toBe(false);
  });

  it("无路径图片 blob → imageBlobs（钉字节落盘）；非图片无路径忽略", () => {
    const shot = pngBlob();
    const orphan = new File([new Uint8Array(4)], "b.bin", {
      type: "application/octet-stream",
    });
    const { pathEntries, imageBlobs } = categorizePastedFiles(
      [shot, orphan],
      () => "",
    );
    expect(pathEntries).toEqual([]);
    expect(imageBlobs).toEqual([shot]);
  });

  it("size-0 图片（macOS 截图坑：getAsFile 拿不到字节）→ needsClipboardFallback", () => {
    const empty = pngBlob("shot.png", 0);
    const { imageBlobs, needsClipboardFallback } = categorizePastedFiles(
      [empty],
      () => "",
    );
    expect(imageBlobs).toEqual([]);
    expect(needsClipboardFallback).toBe(true);
  });

  it("有路径的 size-0 图片仍走路径（磁盘 backing 在，路径优先）", () => {
    const file = pngBlob("shot.png", 0);
    const { pathEntries, needsClipboardFallback } = categorizePastedFiles(
      [file],
      () => "/Users/x/shot.png",
    );
    expect(pathEntries).toHaveLength(1);
    expect(needsClipboardFallback).toBe(false);
  });
});

describe("isOverLimit", () => {
  it("10MB 边界：等于不超、大于超", () => {
    expect(PASTED_IMAGE_LIMIT_BYTES).toBe(10 * 1024 * 1024);
    expect(isOverLimit(PASTED_IMAGE_LIMIT_BYTES)).toBe(false);
    expect(isOverLimit(PASTED_IMAGE_LIMIT_BYTES + 1)).toBe(true);
  });
});

describe("blobToBase64", () => {
  it("已知字节 → 无前缀 base64", async () => {
    const bytes = new Uint8Array([104, 105]); // "hi"
    expect(await blobToBase64(new Blob([bytes]))).toBe("aGk=");
  });
});

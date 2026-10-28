import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { blobToBase64, blobToText, fetchBlob } from "./file-read";

/** 简版 FileReader 替身（node 环境无原生 FileReader）：构造函数接受
 *  blob 存实例字段，readAs* 同步触发 onload；dataURL 形如
 *  data:application/octet-stream;base64,<base64>，text 直接回内容 */
class FileReaderStub {
  result: string | ArrayBuffer | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  blob: Blob | null = null;
  constructor(blob?: Blob | null) {
    this.blob = blob ?? null;
  }
  readAsDataURL(blob: Blob): void {
    this.blob = blob;
    this.result = "data:application/octet-stream;base64,aGVsbG8=";
    this.onload?.();
  }
  readAsText(blob: Blob): void {
    this.blob = blob;
    this.result = "你好，world";
    this.onload?.();
  }
}

/** 失败替身：readAs* 触发 onerror（不产 result） */
class FileReaderFailStub extends FileReaderStub {
  readAsDataURL(): void {
    this.onerror?.();
  }
  readAsText(): void {
    this.onerror?.();
  }
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      blob: async () => new Blob(["hello"]),
    })),
  );
  vi.stubGlobal("FileReader", FileReaderStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("file-read fetchBlob（RN 内建 fetch 本地 URI）", () => {
  it("成功路径：透传 resp.blob() 产物", async () => {
    const blob = new Blob(["hello"]);
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, blob: async () => blob }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchBlob("file://a.txt")).resolves.toBe(blob);
    expect(fetchMock).toHaveBeenCalledWith("file://a.txt");
  });

  it("resp.ok=false 抛 FETCH_<status>", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, blob: async () => new Blob() })),
    );

    await expect(fetchBlob("file://missing.txt")).rejects.toThrowError("FETCH_404");
  });
});

describe("file-read blobToBase64（FileReader.readAsDataURL 剥前缀）", () => {
  it("剥 data: 前缀只留 base64 段", async () => {
    await expect(blobToBase64(new Blob(["hello"]))).resolves.toBe("aGVsbG8=");
  });

  it("dataURL 无逗号时原样返回", async () => {
    class NoCommaStub extends FileReaderStub {
      readAsDataURL(): void {
        this.result = "notADataUrl";
        this.onload?.();
      }
    }
    vi.stubGlobal("FileReader", NoCommaStub);

    await expect(blobToBase64(new Blob(["x"]))).resolves.toBe("notADataUrl");
  });

  it("onerror 拒绝 FILEREADER_FAILED", async () => {
    vi.stubGlobal("FileReader", FileReaderFailStub);

    await expect(blobToBase64(new Blob(["x"]))).rejects.toThrowError("FILEREADER_FAILED");
  });
});

describe("file-read blobToText（FileReader.readAsText UTF-8）", () => {
  it("回读文本内容", async () => {
    await expect(blobToText(new Blob(["你好，world"]))).resolves.toBe("你好，world");
  });

  it("onerror 拒绝 FILEREADER_FAILED", async () => {
    vi.stubGlobal("FileReader", FileReaderFailStub);

    await expect(blobToText(new Blob(["x"]))).rejects.toThrowError("FILEREADER_FAILED");
  });
});

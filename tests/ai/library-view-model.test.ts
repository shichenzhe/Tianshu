import { describe, expect, it } from "vitest";
import {
  fileUrlOf,
  filterByType,
  formatSize,
  previewModeOf,
  sortItems,
} from "../../src-react/domains/ai/library/lib/library-view-model";
import type { LibraryItem } from "../../src-react/domains/ai/library/api/library.api";

function item(partial: Partial<LibraryItem>): LibraryItem {
  return {
    id: 1,
    parentId: null,
    name: "x",
    kind: "file",
    fileType: null,
    mimeType: null,
    size: null,
    originalPath: null,
    storagePath: null,
    createdAt: "2026-09-18T00:00:00Z",
    updatedAt: "2026-09-18T00:00:00Z",
    ...partial,
  };
}

describe("sortItems", () => {
  const items = [
    item({ id: 1, name: "b.txt", kind: "file" }),
    item({ id: 2, name: "folder-z", kind: "folder" }),
    item({ id: 3, name: "a.txt", kind: "file" }),
  ];
  it("folder 恒置前，同类按名升序", () => {
    expect(sortItems(items, "name", "asc").map((i) => i.id)).toEqual([2, 3, 1]);
  });
  it("时间降序时 folder 仍置前", () => {
    const withTime = [
      item({ id: 1, name: "a", updatedAt: "2026-01-01T00:00:00Z" }),
      item({
        id: 2,
        name: "f",
        kind: "folder",
        updatedAt: "2026-02-01T00:00:00Z",
      }),
      item({ id: 3, name: "b", updatedAt: "2026-03-01T00:00:00Z" }),
    ];
    expect(sortItems(withTime, "updatedAt", "desc").map((i) => i.id)).toEqual([
      2, 3, 1,
    ]);
  });
});

describe("filterByType", () => {
  const items = [
    item({ id: 1, fileType: "pdf" }),
    item({ id: 2, fileType: "text" }),
    item({ id: 3, kind: "folder" }),
  ];
  it("类型命中文件 + folder 恒保留；all 原样", () => {
    expect(filterByType(items, "pdf").map((i) => i.id)).toEqual([1, 3]);
    expect(filterByType(items, "all")).toHaveLength(3);
  });
});

describe("previewModeOf", () => {
  it("html/pdf/audio/video → webview；image → 内联；md → markdown", () => {
    expect(previewModeOf({ fileType: "pdf", name: "a.pdf" })).toBe("webview");
    expect(previewModeOf({ fileType: "html", name: "a.html" })).toBe("webview");
    expect(previewModeOf({ fileType: "image", name: "a.png" })).toBe(
      "inline-image",
    );
    expect(previewModeOf({ fileType: "text", name: "a.md" })).toBe("inline-md");
    expect(previewModeOf({ fileType: "text", name: "a.txt" })).toBe(
      "inline-text",
    );
    expect(previewModeOf({ fileType: "code", name: "a.ts" })).toBe(
      "inline-text",
    );
    expect(previewModeOf({ fileType: "document", name: "a.docx" })).toBe(
      "finder",
    );
    expect(previewModeOf({ fileType: null, name: "noext" })).toBe("finder");
  });
});

describe("fileUrlOf / formatSize", () => {
  it("file:// 逐段编码空格", () => {
    expect(fileUrlOf("/a b/c#d.txt")).toBe("file:///a%20b/c%23d.txt");
  });
  it("容量格式化与 null 占位", () => {
    expect(formatSize(null)).toBe("—");
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

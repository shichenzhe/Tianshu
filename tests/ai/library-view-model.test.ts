import { describe, expect, it } from "vitest";
import {
  activityTimeOf,
  buildFolderTree,
  fileUrlOf,
  filterByType,
  formatLocation,
  formatSize,
  isNewItem,
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
    favorite: false,
    lastViewedAt: null,
    location: [],
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
      item({ id: 1, name: "a", createdAt: "2026-01-01T00:00:00Z" }),
      item({
        id: 2,
        name: "f",
        kind: "folder",
        createdAt: "2026-02-01T00:00:00Z",
      }),
      item({ id: 3, name: "b", createdAt: "2026-03-01T00:00:00Z" }),
    ];
    expect(sortItems(withTime, "activity", "desc").map((i) => i.id)).toEqual([
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
  it("win32 反斜杠归一为 / 且盘符段原样保留（不编码成 C%3A）", () => {
    expect(fileUrlOf("C:\\Users\\a b\\img 1.png")).toBe(
      "file://C:/Users/a%20b/img%201.png",
    );
    expect(fileUrlOf("D:\\Reports\\汇总#1.md")).toBe(
      "file://D:/Reports/%E6%B1%87%E6%80%BB%231.md",
    );
  });
  it("容量格式化与 null 占位", () => {
    expect(formatSize(null)).toBe("—");
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("buildFolderTree 组树", () => {
  it("平铺 → 嵌套；层内按名称排序（ASCII 断言——不依赖环境 collation）", () => {
    const tree = buildFolderTree([
      { id: 1, parentId: null, name: "docs" },
      { id: 2, parentId: null, name: "assets" },
      { id: 3, parentId: 1, name: "img" },
      { id: 4, parentId: 1, name: "doc" },
    ]);
    expect(tree.map((n) => n.name)).toEqual(["assets", "docs"]);
    expect(tree[1].children.map((c) => c.name)).toEqual(["doc", "img"]);
  });

  it("中文层内排序稳定且层级正确", () => {
    const tree = buildFolderTree([
      { id: 1, parentId: null, name: "资料" },
      { id: 2, parentId: 1, name: "图片" },
      { id: 3, parentId: 1, name: "文档" },
    ]);
    expect(tree).toHaveLength(1);
    const names = tree[0].children.map((c) => c.name);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
  });

  it("孤儿（parent 不在集合）挂根；自环防御性落根", () => {
    const tree = buildFolderTree([
      { id: 1, parentId: 99, name: "孤儿" },
      { id: 2, parentId: 2, name: "自环" },
    ]);
    expect(tree.map((n) => n.id).sort()).toEqual([1, 2]);
  });

  it("空输入返回空数组", () => {
    expect(buildFolderTree([])).toEqual([]);
  });
});

describe("isNewItem", () => {
  it("file 且从未访问 → true；访问过或 folder → false", () => {
    expect(isNewItem({ kind: "file", lastViewedAt: null })).toBe(true);
    expect(
      isNewItem({ kind: "file", lastViewedAt: "2026-01-01T00:00:00Z" }),
    ).toBe(false);
    expect(isNewItem({ kind: "folder", lastViewedAt: null })).toBe(false);
  });
});

describe("activityTimeOf", () => {
  it("lastViewedAt 优先，缺省回落 createdAt", () => {
    expect(
      activityTimeOf({
        lastViewedAt: "2026-02-01T00:00:00Z",
        createdAt: "2026-01-01T00:00:00Z",
      }),
    ).toBe("2026-02-01T00:00:00Z");
    expect(
      activityTimeOf({ lastViewedAt: null, createdAt: "2026-01-01T00:00:00Z" }),
    ).toBe("2026-01-01T00:00:00Z");
  });
});

describe("formatLocation", () => {
  it("空链显示根名；非空以「 / 」连接（根名不打头）", () => {
    expect(formatLocation([], "我的资料")).toBe("我的资料");
    expect(formatLocation(["F1", "F2"], "我的资料")).toBe("F1 / F2");
  });
});

describe("sortItems activity", () => {
  it("folder 恒置前，file 按 activityTimeOf 升降序", () => {
    const items = [
      { kind: "file", name: "a", createdAt: "2026-01-01", lastViewedAt: null },
      {
        kind: "folder",
        name: "z",
        createdAt: "2026-03-01",
        lastViewedAt: null,
      },
      { kind: "file", name: "b", createdAt: "2026-02-01", lastViewedAt: null },
    ] as LibraryItem[];
    expect(sortItems(items, "activity", "asc").map((i) => i.name)).toEqual([
      "z",
      "a",
      "b",
    ]);
    expect(sortItems(items, "activity", "desc").map((i) => i.name)).toEqual([
      "z",
      "b",
      "a",
    ]);
  });
});

import { describe, expect, it } from "vitest";
import {
  buildBreadcrumbChain,
  classifyFileType,
  collectSubtreeIds,
  compareLibraryItems,
  isDescendantOrSelf,
  mimeOf,
  sanitizeLibraryName,
  storageDirOf,
  uniqueDbName,
  type ItemRow,
} from "../../electron/domains/ai/library/library.utils";

const rows: ItemRow[] = [
  { id: 1, parentId: null, name: "工作", kind: "folder" },
  { id: 2, parentId: 1, name: "2026", kind: "folder" },
  { id: 3, parentId: 2, name: "周报.md", kind: "file" },
  { id: 4, parentId: null, name: "a.txt", kind: "file" },
];

describe("sanitizeLibraryName", () => {
  it("剥离 Windows 保留字符与控制字符，修剪首尾空白/点号", () => {
    expect(sanitizeLibraryName(" a<b>:c?.txt ")).toBe("abc.txt");
  });
  it("清洗后为空抛错", () => {
    expect(() => sanitizeLibraryName(" /? ")).toThrow();
  });
});

describe("uniqueDbName", () => {
  it("未占用原样返回", () => {
    expect(uniqueDbName(new Set(["b.txt"]), "a.txt")).toBe("a.txt");
  });
  it("占用时追加序号并保留扩展名", () => {
    expect(uniqueDbName(new Set(["a.txt"]), "a.txt")).toBe("a (2).txt");
    expect(
      uniqueDbName(new Set(["a.txt", "a (2).txt"]), "a.txt"),
    ).toBe("a (3).txt");
  });
});

describe("collectSubtreeIds / isDescendantOrSelf", () => {
  it("收集含自身的整棵子树", () => {
    expect(collectSubtreeIds(rows, [1])).toEqual([1, 2, 3]);
  });
  it("后代判定：1 是 3 的祖先、3 不是 1 的祖先", () => {
    expect(isDescendantOrSelf(rows, 1, 3)).toBe(true);
    expect(isDescendantOrSelf(rows, 3, 1)).toBe(false);
  });
});

describe("buildBreadcrumbChain", () => {
  it("根→叶链", () => {
    expect(buildBreadcrumbChain(rows, 3).map((r) => r.id)).toEqual([1, 2, 3]);
  });
});

describe("classifyFileType / mimeOf", () => {
  it("扩展名小写分类，未命中归 other", () => {
    expect(classifyFileType("A.PDF")).toBe("pdf");
    expect(classifyFileType("x.html")).toBe("html");
    expect(classifyFileType("a.md")).toBe("text");
    expect(classifyFileType("app.tsx")).toBe("code");
    expect(classifyFileType("movie.Mp4")).toBe("video");
    expect(classifyFileType("noext")).toBe("other");
  });
  it("mime 常见表命中，未命中 null", () => {
    expect(mimeOf("a.md")).toBe("text/markdown");
    expect(mimeOf("b.xyz")).toBeNull();
  });
});

describe("compareLibraryItems / storageDirOf", () => {
  it("folder 置前，同类按名升序", () => {
    const items = [
      { kind: "file", name: "b" },
      { kind: "folder", name: "z" },
      { kind: "file", name: "a" },
    ];
    expect([...items].sort(compareLibraryItems).map((i) => i.name)).toEqual([
      "z",
      "a",
      "b",
    ]);
  });
  it("ID 寻址目录", () => {
    expect(storageDirOf("/root", 7)).toBe("/root/7");
  });
});

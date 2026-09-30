import { describe, expect, it } from "vitest";
import {
  activityTimeOf,
  buildFolderTree,
  fileUrlOf,
  filterByType,
  formatActivityTime,
  formatLocation,
  formatSize,
  groupArtifacts,
  isNewItem,
  nextArtifactSort,
  parseCsv,
  previewModeOf,
  serializeCsv,
  sortArtifactFiles,
  sortItems,
  splitFileName,
  toCsvGrid,
  type ArtifactSortState,
} from "../../src-react/domains/ai/library/lib/library-view-model";
import type { LibraryItem } from "../../src-react/domains/ai/library/api/library.api";
import type { ArtifactListItem } from "../../src-react/domains/ai/api/artifact.api";

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
  it("html/pdf/audio/video → webview；image → 内联；text 纯文本（md 分类另见下）", () => {
    expect(previewModeOf({ fileType: "pdf", name: "a.pdf" })).toBe("webview");
    expect(previewModeOf({ fileType: "html", name: "a.html" })).toBe("webview");
    expect(previewModeOf({ fileType: "image", name: "a.png" })).toBe(
      "inline-image",
    );
    expect(previewModeOf({ fileType: "text", name: "a.md" })).toBe(
      "inline-text",
    );
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

  it("markdown 分类（classifyFileType 对 .md/.markdown 的落点）→ md 渲染；csv → 表格；xls/xlsx → finder", () => {
    expect(previewModeOf({ fileType: "markdown", name: "a.md" })).toBe(
      "inline-md",
    );
    expect(previewModeOf({ fileType: "markdown", name: "notes.markdown" })).toBe(
      "inline-md",
    );
    expect(
      previewModeOf({ fileType: "spreadsheet", name: "data.csv" }),
    ).toBe("inline-csv");
    expect(
      previewModeOf({ fileType: "spreadsheet", name: "data.xlsx" }),
    ).toBe("finder");
  });
});

describe("parseCsv / serializeCsv", () => {
  it("基础逗号分隔与多行；末行无换行不产生空行", () => {
    expect(parseCsv("a,b\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(parseCsv("a,b\nc,d\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(parseCsv("a,b\r\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("引号字段：内嵌逗号/换行/转义引号（RFC 4180）", () => {
    expect(parseCsv('"a,b",c')).toEqual([["a,b", "c"]]);
    expect(parseCsv('"line1\nline2","x""y"')).toEqual([
      ["line1\nline2", 'x"y'],
    ]);
    // 引号内 \r\n 保留原样
    expect(parseCsv('"r1\r\nr2",b')).toEqual([["r1\r\nr2", "b"]]);
  });

  it("空文本与空行", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("\n\n")).toEqual([]);
  });

  it("字段缺省补齐：行内逗号连续（空字段）", () => {
    expect(parseCsv("a,,c")).toEqual([["a", "", "c"]]);
    expect(parseCsv(",")).toEqual([["", ""]]);
  });

  it("serializeCsv：特殊字段引号包裹 + 引号翻倍；与 parseCsv 往返等价", () => {
    expect(serializeCsv([["a", "b,c", 'd"e', "f\ng"]])).toBe(
      'a,"b,c","d""e","f\ng"',
    );
    expect(serializeCsv([["plain", "123"], ["x", "y"]])).toBe(
      "plain,123\nx,y",
    );
    const rows = [
      ["名称", "备注,含逗号", '说"明', "多行\n说明"],
      ["2", "", "x", "y"],
    ];
    expect(parseCsv(serializeCsv(rows))).toEqual(rows);
  });

  it("toCsvGrid：短行补空对齐最长行；空输入回落单格", () => {
    expect(toCsvGrid([])).toEqual([[""]]);
    expect(toCsvGrid([[]])).toEqual([[""]]);
    expect(
      toCsvGrid([
        ["a", "b", "c"],
        ["x"],
      ]),
    ).toEqual([
      ["a", "b", "c"],
      ["x", "", ""],
    ]);
    // 正常网格原样（新数组不改入参）
    const input = [
      ["1", "2"],
      ["3", "4"],
    ];
    expect(toCsvGrid(input)).toEqual(input);
    expect(toCsvGrid(input)).not.toBe(input);
  });

  it("splitFileName：扩展名剥离待拼回；无扩展/首字符点整名为主干", () => {
    expect(splitFileName("note.md")).toEqual({ stem: "note", ext: ".md" });
    expect(splitFileName("a.b.c.txt")).toEqual({
      stem: "a.b.c",
      ext: ".txt",
    });
    expect(splitFileName("README")).toEqual({ stem: "README", ext: "" });
    expect(splitFileName(".gitignore")).toEqual({
      stem: ".gitignore",
      ext: "",
    });
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
  it("平铺 → 嵌套；层内 folder 恒前、同 kind 按名称排序（ASCII 断言——不依赖环境 collation）", () => {
    const tree = buildFolderTree([
      { id: 1, parentId: null, name: "docs", kind: "folder" },
      { id: 2, parentId: null, name: "assets", kind: "folder" },
      { id: 3, parentId: 1, name: "img", kind: "folder" },
      { id: 4, parentId: 1, name: "doc", kind: "folder" },
    ]);
    expect(tree.map((n) => n.name)).toEqual(["assets", "docs"]);
    expect(tree[1].children.map((c) => c.name)).toEqual(["doc", "img"]);
  });

  it("文件/链接作叶子挂父文件夹下，且排在同层文件夹之后", () => {
    const tree = buildFolderTree([
      { id: 1, parentId: null, name: "docs", kind: "folder" },
      { id: 2, parentId: 1, name: "z-folder", kind: "folder" },
      { id: 3, parentId: 1, name: "a.md", kind: "file" },
      { id: 4, parentId: 1, name: "b.md", kind: "file" },
      { id: 5, parentId: 1, name: "site", kind: "link" },
      { id: 6, parentId: null, name: "root.md", kind: "file" },
    ]);
    // 根层：文件夹前文件后
    expect(tree.map((n) => [n.name, n.kind])).toEqual([
      ["docs", "folder"],
      ["root.md", "file"],
    ]);
    // docs 层：文件夹 → 文件（名排序）→ 链接
    expect(tree[0].children.map((c) => [c.name, c.kind])).toEqual([
      ["z-folder", "folder"],
      ["a.md", "file"],
      ["b.md", "file"],
      ["site", "link"],
    ]);
    // 叶子无子层
    expect(tree[0].children[1].children).toEqual([]);
  });

  it("中文层内排序稳定且层级正确", () => {
    const tree = buildFolderTree([
      { id: 1, parentId: null, name: "资料", kind: "folder" },
      { id: 2, parentId: 1, name: "图片", kind: "folder" },
      { id: 3, parentId: 1, name: "文档", kind: "folder" },
    ]);
    expect(tree).toHaveLength(1);
    const names = tree[0].children.map((c) => c.name);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
  });

  it("孤儿（parent 不在集合）挂根；自环防御性落根", () => {
    const tree = buildFolderTree([
      { id: 1, parentId: 99, name: "孤儿", kind: "folder" },
      { id: 2, parentId: 2, name: "自环", kind: "folder" },
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

describe("formatActivityTime（最近时间列格式化，本机时区 Asia/Shanghai）", () => {
  it("zh：2026年9月19日 09:03", () => {
    expect(formatActivityTime("2026-09-19T01:03:00Z", "zh-CN")).toBe(
      "2026年9月19日 09:03",
    );
  });
  it("en：Sep 19, 2026 09:03", () => {
    expect(formatActivityTime("2026-09-19T01:03:00Z", "en-US")).toBe(
      "Sep 19, 2026 09:03",
    );
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

const artifact = (partial: Partial<ArtifactListItem>): ArtifactListItem => ({
  path: `/tmp/${partial.name ?? "x"}`,
  relPath: partial.name ?? "x",
  name: partial.name ?? "x",
  fileType: "text",
  workspaceId: 1,
  workspaceName: "空间A",
  sessionId: 10,
  sessionTitle: "任务一",
  writtenAt: "2026-09-20T10:00:00Z",
  size: 100,
  favorite: false,
  ...partial,
});

describe("groupArtifacts（本地产物树分组）", () => {
  it("按工作空间→任务两级分组，空枝剔除", () => {
    const groups = groupArtifacts(
      [
        artifact({ name: "a.md", workspaceId: 1, sessionId: 10 }),
        artifact({
          name: "b.md",
          workspaceId: 1,
          sessionId: 11,
          sessionTitle: "任务二",
        }),
        artifact({
          name: "c.md",
          workspaceId: 2,
          workspaceName: "空间B",
          sessionId: 20,
        }),
      ],
      { keyword: "", fileType: "all" },
    );
    expect(groups.map((g) => g.name)).toEqual(["空间A", "空间B"]);
    expect(groups[0]?.sessions.map((s) => s.title)).toEqual([
      "任务一",
      "任务二",
    ]);
    expect(groups[1]?.sessions[0]?.files.map((f) => f.name)).toEqual(["c.md"]);
  });

  it("会话与工作空间按组内最新写入时间降序", () => {
    const groups = groupArtifacts(
      [
        artifact({
          name: "old.md",
          sessionId: 10,
          writtenAt: "2026-09-01T00:00:00Z",
        }),
        artifact({
          name: "new.md",
          sessionId: 11,
          sessionTitle: "任务二",
          writtenAt: "2026-09-22T00:00:00Z",
        }),
      ],
      { keyword: "", fileType: "all" },
    );
    expect(groups[0]?.sessions.map((s) => s.title)).toEqual([
      "任务二",
      "任务一",
    ]);
  });

  it("关键字命中文件名/任务标题/工作空间名任一即保留", () => {
    const items = [
      // 文件名命中「周」
      artifact({ name: "周报.md", sessionId: 10 }),
      // 任务标题命中
      artifact({ name: "note.md", sessionId: 11, sessionTitle: "周报任务" }),
      // 工作空间名命中
      artifact({ name: "memo.md", workspaceId: 2, workspaceName: "周边空间" }),
      // 三者均不命中——剔除
      artifact({ name: "other.md", sessionId: 12, sessionTitle: "无关" }),
    ];
    const groups = groupArtifacts(items, { keyword: "周", fileType: "all" });
    const names = groups.flatMap((g) =>
      g.sessions.flatMap((s) => s.files.map((f) => f.name)),
    );
    expect(names.sort()).toEqual(["memo.md", "note.md", "周报.md"]);
  });

  it("类型过滤仅保留命中 fileType 的文件", () => {
    const items = [
      artifact({ name: "a.md", fileType: "text" }),
      artifact({ name: "b.png", fileType: "image" }),
    ];
    const groups = groupArtifacts(items, { keyword: "", fileType: "image" });
    expect(
      groups
        .flatMap((g) => g.sessions.flatMap((s) => s.files))
        .map((f) => f.name),
    ).toEqual(["b.png"]);
  });

  it("favoriteOnly 仅保留收藏文件，空组整枝剔除", () => {
    const items = [
      artifact({ name: "fav.md", favorite: true }),
      artifact({
        name: "plain.md",
        favorite: false,
        sessionId: 11,
        sessionTitle: "任务二",
      }),
    ];
    const groups = groupArtifacts(items, {
      keyword: "",
      fileType: "all",
      favoriteOnly: true,
    });
    expect(
      groups
        .flatMap((g) => g.sessions.flatMap((s) => s.files))
        .map((f) => f.name),
    ).toEqual(["fav.md"]);
  });
});

describe("nextArtifactSort（表头三态循环）", () => {
  it("同字段 default→asc→desc→default 循环", () => {
    expect(nextArtifactSort("default", "name")).toBe("nameAsc");
    expect(nextArtifactSort("nameAsc", "name")).toBe("nameDesc");
    expect(nextArtifactSort("nameDesc", "name")).toBe("default");
    expect(nextArtifactSort("default", "time")).toBe("timeAsc");
    expect(nextArtifactSort("timeAsc", "time")).toBe("timeDesc");
    expect(nextArtifactSort("timeDesc", "time")).toBe("default");
  });

  it("换字段重置到该字段升序", () => {
    expect(nextArtifactSort("nameDesc", "time")).toBe("timeAsc");
    expect(nextArtifactSort("timeAsc", "name")).toBe("nameAsc");
  });
});

describe("sortArtifactFiles（组内文件行排序）", () => {
  const files = [
    { name: "b.md", writtenAt: "2026-09-02T00:00:00Z" },
    { name: "a.md", writtenAt: "2026-09-03T00:00:00Z" },
    { name: "c.md", writtenAt: "2026-09-01T00:00:00Z" },
  ].map((p) => artifact(p));

  const cases: Array<[ArtifactSortState, string[]]> = [
    ["default", ["b.md", "a.md", "c.md"]],
    ["nameAsc", ["a.md", "b.md", "c.md"]],
    ["nameDesc", ["c.md", "b.md", "a.md"]],
    ["timeAsc", ["c.md", "b.md", "a.md"]],
    ["timeDesc", ["a.md", "b.md", "c.md"]],
  ];

  it.each(cases)("%s → %j", (state, expected) => {
    expect(sortArtifactFiles(files, state).map((f) => f.name)).toEqual(
      expected,
    );
  });

  it("返回新数组，不 mutate 入参", () => {
    sortArtifactFiles(files, "nameDesc");
    expect(files.map((f) => f.name)).toEqual(["b.md", "a.md", "c.md"]);
  });
});

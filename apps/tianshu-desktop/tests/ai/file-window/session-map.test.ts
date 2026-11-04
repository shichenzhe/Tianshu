// @vitest-environment jsdom
/**
 * 文件→会话历史映射（spec §12 项 4）：localStorage
 * `tianshu-file-window-session-map` 存 Record<dedupeKey, sessionId[]>——
 * pushSession 去重置顶 + 每文件 10 上限；recentSessionOf 取最近（无记录/
 * 损坏 JSON → null）；removeSession 摘单个会话（摘空清键），
 * 供发送报 SESSION_NOT_FOUND 时清绑定防误用。sessionResourceIndex
 * 反转映射（spec §19 项 1 主窗跳文件窗）：逐键反转 + 多键共指后键
 * 覆盖 + 损坏键/条目跳过。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// localStorage stub：与 tests/ai/edit-bar.test.tsx 同款内存 stub（本仓库
// 测试环境不依赖原生 localStorage；映射读写全走它）
vi.hoisted(() => {
  const memory = new Map<string, string>();
  const stub = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => void memory.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: stub,
    configurable: true,
    writable: true,
  });
});

import {
  pushSession,
  recentSessionOf,
  removeSession,
  sessionResourceIndex,
} from "../../../src-react/domains/ai/file-window/lib/session-map";

const KEY = "tianshu-file-window-session-map";
const WS_A = { kind: "workspace", workspaceId: 7, path: "docs/a.md" } as const;
const WS_B = { kind: "workspace", workspaceId: 7, path: "docs/b.md" } as const;
const LIB = { kind: "library", itemId: 3 } as const;

const getIds = (resource: typeof WS_A | typeof WS_B | typeof LIB) =>
  JSON.parse(localStorage.getItem(KEY) ?? "{}")[
    resource.kind === "workspace"
      ? `w:7:${resource.path}`
      : resource.kind === "library"
        ? "l:3"
        : ""
  ];

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("pushSession：去重置顶 + 每文件 10 上限", () => {
  it("顺序 push 新者在前；重复 push 置顶不重复", () => {
    pushSession(WS_A, 1);
    pushSession(WS_A, 2);
    pushSession(WS_A, 3);
    expect(getIds(WS_A)).toEqual([3, 2, 1]);
    pushSession(WS_A, 2);
    expect(getIds(WS_A)).toEqual([2, 3, 1]);
  });

  it("第 11 个挤掉最旧尾部（每文件最近 10）", () => {
    for (let i = 1; i <= 11; i++) pushSession(WS_A, i);
    expect(getIds(WS_A)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  });

  it("按 dedupeKey 隔离（不同文件/不同空间互不串）", () => {
    pushSession(WS_A, 1);
    pushSession(WS_B, 2);
    pushSession(LIB, 3);
    expect(getIds(WS_A)).toEqual([1]);
    expect(getIds(WS_B)).toEqual([2]);
    expect(getIds(LIB)).toEqual([3]);
  });
});

describe("recentSessionOf：取最近", () => {
  it("无记录 → null；有记录 → 数组首位", () => {
    expect(recentSessionOf(WS_A)).toBeNull();
    pushSession(WS_A, 54);
    pushSession(WS_A, 55);
    expect(recentSessionOf(WS_A)).toBe(55);
  });

  it("损坏 JSON / 非对象 JSON → null 兜底", () => {
    localStorage.setItem(KEY, "{not-json");
    expect(recentSessionOf(WS_A)).toBeNull();
    localStorage.setItem(KEY, "[1,2]");
    expect(recentSessionOf(WS_A)).toBeNull();
    localStorage.setItem(KEY, JSON.stringify({ "w:7:docs/a.md": "corrupt" }));
    expect(recentSessionOf(WS_A)).toBeNull();
  });

  it("损坏 JSON 后 push 覆写修复（不因坏数据阻断写入）", () => {
    localStorage.setItem(KEY, "{not-json");
    pushSession(WS_A, 7);
    expect(recentSessionOf(WS_A)).toBe(7);
  });
});

describe("removeSession：摘单个会话", () => {
  it("摘中间/首位，其余保留原序", () => {
    pushSession(WS_A, 1);
    pushSession(WS_A, 2);
    pushSession(WS_A, 3);
    removeSession(WS_A, 2);
    expect(getIds(WS_A)).toEqual([3, 1]);
    removeSession(WS_A, 3);
    expect(getIds(WS_A)).toEqual([1]);
  });

  it("摘空清键；不存在的会话/无记录文件不抛不建键", () => {
    pushSession(WS_A, 1);
    removeSession(WS_A, 1);
    expect(getIds(WS_A)).toBeUndefined();
    expect(() => removeSession(WS_A, 99)).not.toThrow();
    expect(getIds(WS_A)).toBeUndefined();
    expect(() => removeSession(WS_B, 1)).not.toThrow();
    expect(localStorage.getItem(KEY)).toBe("{}");
  });
});

describe("sessionResourceIndex：反转映射（spec §19 项 1 主窗跳文件窗）", () => {
  it("逐键反转：session → resource（path 还原 + 库条目）", () => {
    pushSession(WS_A, 1);
    pushSession(WS_B, 2);
    pushSession(LIB, 3);
    const index = sessionResourceIndex();
    expect(index.size).toBe(3);
    expect(index.get(1)).toEqual({
      kind: "workspace",
      workspaceId: 7,
      path: "docs/a.md",
    });
    expect(index.get(2)).toEqual({
      kind: "workspace",
      workspaceId: 7,
      path: "docs/b.md",
    });
    expect(index.get(3)).toEqual({ kind: "library", itemId: 3 });
  });

  it("多文件共指同一 session 取最近（后键覆盖——键序为时序近似）", () => {
    pushSession(WS_A, 5);
    pushSession(WS_B, 5); // 移窗：B 后写 → 5 解析到 B
    const index = sessionResourceIndex();
    expect(index.get(5)).toEqual({
      kind: "workspace",
      workspaceId: 7,
      path: "docs/b.md",
    });
  });

  it("path 含冒号：首个分隔符后整体作 path（与生成端对齐）", () => {
    localStorage.setItem(KEY, JSON.stringify({ "w:7:a:b.md": [11] }));
    expect(sessionResourceIndex().get(11)).toEqual({
      kind: "workspace",
      workspaceId: 7,
      path: "a:b.md",
    });
  });

  it("损坏键/条目跳过：非法前缀、非数字 id、空 path、非数组值、非法 sessionId", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        "x:1:a.md": [9], // 未知前缀
        "w:notnum:a.md": [8], // workspaceId 非数字
        "w:7:": [7], // 空 path
        "l:bad": [6], // itemId 非数字
        "w:7:corrupt.md": "not-array", // 值非数组
        "w:7:ok.md": [4, "x", 3.5, 0, -2, NaN], // 非法 sessionId 混入
      }),
    );
    const index = sessionResourceIndex();
    expect(index.size).toBe(1);
    expect(index.get(4)).toEqual({
      kind: "workspace",
      workspaceId: 7,
      path: "ok.md",
    });
  });

  it("空映射 / 损坏 JSON → 空索引不抛", () => {
    expect(sessionResourceIndex().size).toBe(0);
    localStorage.setItem(KEY, "{not-json");
    expect(sessionResourceIndex().size).toBe(0);
    localStorage.setItem(KEY, "[1,2]");
    expect(sessionResourceIndex().size).toBe(0);
  });
});

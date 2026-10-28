// @vitest-environment jsdom
/**
 * useSidebarExpand 侧栏展开态持久化测试（对齐 WorkBuddy expanded-state）：
 * - 无存储回落默认（空间区开、组展开、可见条数默认 5）
 * - 组折叠/空间区开关写 localStorage，重新挂载读回
 * - showMoreGroup 落盘扩档值；collapseGroup 删记录回默认（≤ 默认不落盘）
 * - 活跃保底 syncActiveVisible 事件落盘（选中超界扩档；visibleCountOf
 *   纯读存储——收起动作不被渲染派生推翻）
 * - 损坏 JSON / 非法字段防御回落默认
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// localStorage stub：jsdom 全局经 defineProperty 注入内存实现（项目惯例，
// 消除 Node 原生全局 ExperimentalWarning）
vi.hoisted(() => {
  const memory = new Map<string, string>();
  const stub = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => memory.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: stub,
    configurable: true,
    writable: true,
  });
});

import { useSidebarExpand } from "../../src-react/domains/ai/layout/hooks/use-sidebar-expand";

const STORAGE_KEY = "tianshu-sidebar-expand";

beforeEach(() => {
  localStorage.clear();
});

describe("useSidebarExpand 默认态", () => {
  it("无存储：空间区开、组展开、可见条数默认 5", () => {
    const { result } = renderHook(() => useSidebarExpand());
    expect(result.current.spacesOpen).toBe(true);
    expect(result.current.isSpaceCollapsed(2)).toBe(false);
    expect(result.current.isProjectCollapsed(11)).toBe(false);
    expect(result.current.visibleCountOf("w:2")).toBe(5);
  });

  it("损坏 JSON 回落默认不炸", () => {
    localStorage.setItem(STORAGE_KEY, "not-json{");
    const { result } = renderHook(() => useSidebarExpand());
    expect(result.current.spacesOpen).toBe(true);
  });

  it("非法字段被过滤：非布尔折叠值、低于默认的可见条数不生效", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        spacesOpen: "yes",
        spaceCollapsed: { "w:2": true, "w:3": 1 },
        groupVisibleCount: { "w:2": 2, "w:4": 25 },
      }),
    );
    const { result } = renderHook(() => useSidebarExpand());
    expect(result.current.spacesOpen).toBe(true); // 非布尔回落默认开
    expect(result.current.isSpaceCollapsed(2)).toBe(true);
    expect(result.current.isSpaceCollapsed(3)).toBe(false); // 非布尔过滤
    expect(result.current.visibleCountOf("w:2")).toBe(5); // 低于默认不生效
    expect(result.current.visibleCountOf("w:4")).toBe(25);
  });
});

describe("useSidebarExpand 持久化读写", () => {
  it("toggleSpaceGroup/toggleProjectGroup/toggleSpaces 落盘且重挂载读回", () => {
    const first = renderHook(() => useSidebarExpand());
    act(() => first.result.current.toggleSpaceGroup(2));
    act(() => first.result.current.toggleProjectGroup(11));
    act(() => first.result.current.toggleSpaces());

    const second = renderHook(() => useSidebarExpand());
    expect(second.result.current.isSpaceCollapsed(2)).toBe(true);
    expect(second.result.current.isProjectCollapsed(11)).toBe(true);
    expect(second.result.current.spacesOpen).toBe(false);

    // 再切回：折叠记录删除（true → false 即无记录）
    act(() => second.result.current.toggleSpaceGroup(2));
    expect(
      JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}").spaceCollapsed,
    ).toEqual({});
  });

  it("showMoreGroup 落盘扩档值；collapseGroup 删记录回默认", () => {
    const { result } = renderHook(() => useSidebarExpand());
    act(() => result.current.showMoreGroup("w:2", 5, 60));
    expect(result.current.visibleCountOf("w:2")).toBe(25);

    const reopened = renderHook(() => useSidebarExpand());
    expect(reopened.result.current.visibleCountOf("w:2")).toBe(25);

    act(() => reopened.result.current.collapseGroup("w:2"));
    expect(reopened.result.current.visibleCountOf("w:2")).toBe(5);
    // ≤ 默认不落盘：收起后无该组记录
    expect(
      JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}").groupVisibleCount,
    ).toEqual({});
  });
});

describe("useSidebarExpand 活跃保底（syncActiveVisible 事件落盘）", () => {
  it("选中项超界时扩档落盘；界内/不在组内 no-op 不写盘", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ groupVisibleCount: { "w:2": 25 } }),
    );
    const { result } = renderHook(() => useSidebarExpand());
    // 界内（idx 24 < 25）与不在组内（-1）：不扩档
    act(() => result.current.syncActiveVisible("w:2", 24));
    act(() => result.current.syncActiveVisible("w:2", -1));
    expect(
      JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}").groupVisibleCount,
    ).toEqual({ "w:2": 25 });

    // 超界（idx 25）：5 + ceil(26/20)*20 = 45 落盘
    act(() => result.current.syncActiveVisible("w:2", 25));
    expect(result.current.visibleCountOf("w:2")).toBe(45);
  });

  it("收起不被保底推翻（visibleCountOf 纯读存储，无渲染期派生）", () => {
    // 保底落盘 25 后收起：删记录回默认 5——即使「选中项仍超界」也生效
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ groupVisibleCount: { "w:2": 25 } }),
    );
    const { result } = renderHook(() => useSidebarExpand());
    act(() => result.current.collapseGroup("w:2"));
    expect(result.current.visibleCountOf("w:2")).toBe(5);
  });

  it("showMoreGroup 以当前渲染值为基准步进（保底态展开继续 +20）", () => {
    const { result } = renderHook(() => useSidebarExpand());
    // 保底落盘态（45）下点展开更多：45 + 20 落盘
    act(() => result.current.syncActiveVisible("w:2", 40));
    act(() => result.current.showMoreGroup("w:2", 45, 60));
    expect(result.current.visibleCountOf("w:2")).toBe(60);
  });
});

// @vitest-environment jsdom
/**
 * 文件窗窗口域标记与主窗路由转发（T22，spec §13 项 3）：
 * - markFileWindowScope/isFileWindowScope：文件窗挂载期捕获 windowId
 *   （hash 导航后 query 会丢，模块级单例是路由跳回的唯一来源）
 * - forwardMainRoute：文件窗内主窗路由跳转 → invoke fileWindow:openRoute
 *   （主进程聚焦主窗 + navigate 事件）；主窗域恒 false 不转发
 * - fileWindowRoute：跳回本窗的路由（windowId 回填）
 * - registerMainWindowNavigate：主窗全局监听 fileWindow:navigate →
 *   router.navigate（hash 非 "/" 起始拒跳——主进程已校验，双保险）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
const listeners = vi.hoisted(
  () => new Map<string, (e: unknown, p: unknown) => void>(),
);
vi.mock("../../../src-react/lib/ipc", () => ({
  invoke: (...args: unknown[]) => {
    invokeMock(...args);
    return Promise.resolve(null);
  },
  on: (ch: string, cb: (e: unknown, p: unknown) => void) => {
    listeners.set(ch, cb);
    return () => listeners.delete(ch);
  },
}));

import {
  fileWindowRoute,
  forwardMainRoute,
  isFileWindowScope,
  markFileWindowScope,
} from "../../../src-react/domains/ai/file-window/lib/window-scope";
import { registerMainWindowNavigate } from "../../../src-react/domains/ai/file-window/lib/main-window-navigate";

beforeEach(() => {
  invokeMock.mockReset();
});
afterEach(() => {
  // 模块级单例回零（隔离用例间窗口域标记）
  markFileWindowScope("");
});

describe("文件窗窗口域（window-scope）", () => {
  it("未标记：isFileWindowScope false，forwardMainRoute 不转发", () => {
    expect(isFileWindowScope()).toBe(false);
    expect(forwardMainRoute("/module/ai/providers")).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("标记后：forwardMainRoute invoke fileWindow:openRoute { hash } 并返回 true", () => {
    markFileWindowScope("file-window:abc");
    expect(isFileWindowScope()).toBe(true);
    expect(forwardMainRoute("/module/ai/experts?tab=skills")).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("fileWindow:openRoute", {
      hash: "/module/ai/experts?tab=skills",
    });
  });

  it("invoke 失败静默（不抛——主窗缺失等场景由主进程兜底）", () => {
    markFileWindowScope("file-window:abc");
    invokeMock.mockReturnValue(Promise.reject(new Error("no main")));
    expect(() => forwardMainRoute("/module/ai/providers")).not.toThrow();
  });

  it("fileWindowRoute 回填捕获的 windowId", () => {
    markFileWindowScope("file-window:abc");
    expect(fileWindowRoute()).toBe("/file-window?windowId=file-window:abc");
  });
});

describe("主窗导航监听（registerMainWindowNavigate）", () => {
  it("合法 hash → router.navigate；非法载荷拒跳；off 退订", () => {
    const router = { navigate: vi.fn() };

    const off = registerMainWindowNavigate(router as never);
    const emit = listeners.get("fileWindow:navigate") as (
      e: unknown,
      p: unknown,
    ) => void;
    expect(typeof emit).toBe("function");

    emit({}, { hash: "/module/ai/providers" });
    expect(router.navigate).toHaveBeenCalledWith("/module/ai/providers");

    // 非 "/" 起始 / 非字符串载荷：不透传 router
    emit({}, { hash: "javascript:alert(1)" });
    emit({}, { hash: 123 });
    emit({}, undefined);
    expect(router.navigate).toHaveBeenCalledTimes(1);

    off();
    expect(listeners.has("fileWindow:navigate")).toBe(false);
  });
});

// @vitest-environment jsdom
/**
 * ModuleRouteGuard 集成测试（T22 审查 M3 建议补，T23 落）：经真实 router
 * 配置（routes/index.tsx）+ RouterProvider 渲染验证——文件窗渲染进程内
 * ChatPane 子组件内部 navigate 跳 /module/*（ModelPicker「配置模型」
 * PROVIDERS_ROUTE 直跳场景）→ 守卫转发主窗（invoke fileWindow:openRoute）
 * 并 <Navigate replace> 跳回本文件窗，本窗不驻留 /module 路由；主窗域
 * （未标记）守卫恒走 MainLayout 本地渲染，不转发。懒加载视图打桩隔离
 * 文件窗/侧边栏全家桶（守卫行为与视图内容无关，单测见 window-scope.test）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

// 模块级 router 单例 import 期即读初始 hash：hoisted 先行设为文件窗路由，
// 否则首个用例初始 "/" → /module/ai/new 重定向会在标记域内多转发一次
vi.hoisted(() => {
  window.location.hash = "#/file-window?windowId=t23";
});

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src-react/lib/ipc", () => ({
  invoke: (...args: unknown[]) => {
    invokeMock(...args);
    return Promise.resolve(null);
  },
  on: () => () => undefined,
}));

// LoadingFallback（Suspense 兜底）经 useTranslation：无 i18n 实例会告警
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});

// 懒加载视图打桩：FileWindowView 拉文件窗全家桶、MainLayout 渲染侧边栏
// 全家桶（守卫跳回 /module 时才挂载，本测试只验路由守卫行为）
vi.mock(
  "../../../src-react/domains/ai/file-window/views/FileWindowView",
  async () => {
    const { createElement } = await import("react");
    return {
      default: () =>
        createElement("div", { "data-testid": "file-window-view" }),
    };
  },
);
vi.mock("../../../src-react/components/layout/MainLayout", async () => {
  const { createElement } = await import("react");
  return {
    default: () => createElement("div", { "data-testid": "main-layout" }),
  };
});

import { RouterProvider } from "react-router-dom";

import { router } from "../../../src-react/routes";
import { markFileWindowScope } from "../../../src-react/domains/ai/file-window/lib/window-scope";

beforeEach(() => {
  invokeMock.mockReset();
  markFileWindowScope("");
});

afterEach(() => {
  cleanup();
  // 模块级窗口域标记回零（隔离用例间作用域；router 单例状态随用例内导航）
  markFileWindowScope("");
});

describe("ModuleRouteGuard（文件窗内 /module 导航，T22/T23）", () => {
  it("文件窗内触发 ModelPicker 路由：转发主窗 openRoute，本窗跳回文件窗不驻留 /module", async () => {
    // FileWindowView 挂载期同款标记（window-scope 模块级单例，与 URL 一致）
    markFileWindowScope("t23");
    render(<RouterProvider router={router} />);
    // lazy 首载（hoisted 初始路由即文件窗，起点不经守卫、不转发）
    await screen.findByTestId("file-window-view");
    expect(invokeMock).not.toHaveBeenCalled();

    // ModelPicker「配置模型」内部 navigate 同款（useNavigate → PROVIDERS_ROUTE）
    await act(() => router.navigate("/module/ai/providers"));

    // 转发主窗：invoke fileWindow:openRoute { hash: "/module/ai/providers" }
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("fileWindow:openRoute", {
        hash: "/module/ai/providers",
      }),
    );
    // 本窗不驻留 /module：守卫 <Navigate replace> 跳回文件窗路由（windowId 回填）
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/file-window"),
    );
    expect(router.state.location.search).toBe("?windowId=t23");
    await screen.findByTestId("file-window-view");
  });

  it("主窗域（未标记）：/module 导航照常本地渲染 MainLayout，不转发 openRoute", async () => {
    render(<RouterProvider router={router} />);
    await act(() => router.navigate("/module/ai/providers"));
    expect(await screen.findByTestId("main-layout")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/module/ai/providers");
    await new Promise((r) => setTimeout(r, 20));
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

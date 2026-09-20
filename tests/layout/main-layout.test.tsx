// @vitest-environment jsdom
/**
 * MainLayout 顶栏注入测试（jsdom + testing-library）：
 * - 折叠/全局搜索/时间筛选三按钮（AiTopbarActions）作用于全局侧边栏——
 *   所有 /module 路由注入（项目详情页同样可见，回归锚点：曾因 isAiRoute
 *   判断被限制在 /module/ai 导致项目页三按钮消失）
 * - 会话内搜索（SessionSearchBox）仍为 AI 会话专属
 * mock 骨架同 tests/ai/chat-input-todo.test.tsx：i18n 直返 key、
 * GlobalSidebar/UserMenu/LanguageSelector/AppLogo 重依赖
 * stub、user.store 固定有效登录态（verifyToken resolve）
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

// localStorage stub：persist 中间件模块加载即读取（Node 环境原生全局会打
// ExperimentalWarning）；同处补齐 TopBar 依赖的构建注入全局
// （__APP_VERSION__ 由 Vite define 提供）与 window.platform
vi.hoisted(() => {
  const memory = new Map<string, string>();
  const stub = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
    clear: () => memory.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: stub,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "__APP_VERSION__", {
    value: "0.0.0-test",
    configurable: true,
    writable: true,
  });
  Object.defineProperty(window, "platform", {
    value: "darwin",
    configurable: true,
    writable: true,
  });
});

vi.mock("@/i18n", () => ({
  default: { t: (key: string) => key },
}));
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});
vi.mock("sonner", () => ({ toast: { warning: vi.fn(), error: vi.fn() } }));

// 登录链路：store 固定有效态、token 校验恒通过（布局测试不关心认证）
vi.mock("@/domains/user/store/user.store", () => ({
  useUserStore: () => ({
    user: { token: "test-token" },
    isLoginValid: () => true,
    reset: vi.fn(),
  }),
}));
vi.mock("@/domains/user/api/user.api", () => ({
  UserApi: { verifyToken: () => Promise.resolve({ id: 1 }) },
}));

// 顶栏注入对象：marker 替身（断言的是 MainLayout 的注入决策）
vi.mock("@/domains/ai/layout/components/AiTopbarActions", () => ({
  default: () => <div data-testid="topbar-actions" />,
}));
vi.mock("@/domains/ai/layout/components/SessionSearchBox", () => ({
  default: () => <div data-testid="session-search" />,
}));

// 重依赖子组件 stub（折叠键接线/菜单/主题语言切换与注入逻辑无关）
vi.mock("../../src-react/components/layout/GlobalSidebar", () => ({
  default: () => null,
}));
vi.mock("../../src-react/components/layout/UserMenu", () => ({
  default: () => null,
}));
vi.mock("@/components/common/LanguageSelector", () => ({
  default: () => null,
}));
vi.mock("@/components/common/AppLogo", () => ({ default: () => null }));

import MainLayout from "../../src-react/components/layout/MainLayout";

/** 渲染 MainLayout 到指定路径（Outlet 内容以空节点占位） */
function renderLayout(pathname: string): void {
  render(
    <MemoryRouter initialEntries={[pathname]}>
      <Routes>
        <Route element={<MainLayout />}>
          <Route path="*" element={<div />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe("顶栏左侧按钮注入（全局侧边栏配套）", () => {
  it("项目详情页 /module/project/:id → 三按钮保持显示（AiTopbarActions 注入）", () => {
    renderLayout("/module/project/1");
    expect(screen.getByTestId("topbar-actions")).toBeTruthy();
  });

  it("AI 路由 /module/ai → 三按钮 + 会话内搜索均注入", () => {
    renderLayout("/module/ai");
    expect(screen.getByTestId("topbar-actions")).toBeTruthy();
    expect(screen.getByTestId("session-search")).toBeTruthy();
  });

  it("项目详情页 → 会话内搜索不注入（AI 会话专属）", () => {
    renderLayout("/module/project/1");
    expect(screen.queryByTestId("session-search")).toBeNull();
  });
});

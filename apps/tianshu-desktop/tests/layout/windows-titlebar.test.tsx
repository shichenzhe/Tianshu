// @vitest-environment jsdom
/** Windows 独立自绘标题栏：布局、窗口操作、状态同步与主题类 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toast } from "sonner";
import { MemoryRouter, useNavigate } from "react-router-dom";

const ipcMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(),
  unsubscribe: vi.fn(),
}));
vi.hoisted(() => {
  Object.defineProperty(window, "platform", {
    value: "win32",
    configurable: true,
    writable: true,
  });
});
vi.mock("@/lib/ipc", () => ({
  invoke: ipcMocks.invoke,
  on: ipcMocks.on,
}));
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/components/common/AppLogo", () => ({
  default: () => <div data-testid="titlebar-logo" />,
}));
vi.mock("@/domains/ai/layout/components/AiTopbarActions", () => ({
  default: () => <div data-testid="titlebar-actions" />,
}));

import WindowsTitleBar from "../../src-react/components/layout/windows-titlebar";
import { useAiUiStore } from "../../src-react/domains/ai/store/ai-ui.store";

function renderTitleBar(route = "/module/ai/new") {
  window.location.hash = route;
  return render(
    <MemoryRouter initialEntries={[route]}>
      <WindowsTitleBar />
    </MemoryRouter>,
  );
}

function NavigateToLibrary() {
  const navigate = useNavigate();
  return (
    <button onClick={() => navigate("/module/ai/library")}>进入资料库</button>
  );
}

type StateListener = (event: unknown, state: { maximized: boolean }) => void;

beforeEach(() => {
  window.platform = "win32";
  ipcMocks.invoke.mockImplementation((channel: string) => {
    if (channel === "window:toggleMaximize") {
      return Promise.resolve({ maximized: true });
    }
    return Promise.resolve(
      channel === "window:getState" ? { maximized: false } : undefined,
    );
  });
  ipcMocks.on.mockReturnValue(ipcMocks.unsubscribe);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAiUiStore.setState({ sidebarCollapsed: false });
});

describe("WindowsTitleBar", () => {
  it("侧栏路由显示操作按钮而非重复 Logo/应用名", () => {
    const { container } = renderTitleBar();
    const bar = container.querySelector("[data-windows-titlebar]")!;
    for (const className of [
      "h-8",
      "bg-transparent",
      "[-webkit-app-region:drag]",
    ]) {
      expect(bar.classList).toContain(className);
    }
    expect(screen.queryByTestId("titlebar-logo")).toBeNull();
    expect(screen.queryByText("common:appName")).toBeNull();
    expect(screen.getByTestId("titlebar-actions")).toBeTruthy();
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      expect(button.classList).toContain("w-[46px]");
      expect(button.classList).toContain("bg-transparent");
      expect(button.classList).toContain("[-webkit-app-region:no-drag]");
    }
  });

  it("侧栏路由左侧背景与侧栏同源并随折叠收缩，登录页无侧栏段", () => {
    const { container } = renderTitleBar();
    const segment = container.querySelector(
      "[data-titlebar-sidebar-bg]",
    ) as HTMLElement;
    expect(segment).not.toBeNull();
    expect(segment.classList).toContain("w-64");
    expect(segment.style.backgroundColor).toContain("--skin-sidebar-bg");

    act(() => useAiUiStore.setState({ sidebarCollapsed: true }));
    expect(segment.classList).toContain("w-0");
    cleanup();

    const login = renderTitleBar("/login");
    expect(
      login.container.querySelector("[data-titlebar-sidebar-bg]"),
    ).toBeNull();
    expect(screen.queryByTestId("titlebar-actions")).toBeNull();
  });

  it("从登录页进入模块路由后显示侧栏操作按钮", async () => {
    window.location.hash = "/login";
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <WindowsTitleBar />
        <NavigateToLibrary />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId("titlebar-actions")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "进入资料库" }));
    expect(await screen.findByTestId("titlebar-actions")).toBeTruthy();
  });

  it("非 Windows 不渲染且不初始化 IPC", () => {
    window.platform = "darwin";
    const { container } = renderTitleBar();
    expect(container.innerHTML).toBe("");
    expect(ipcMocks.invoke).not.toHaveBeenCalled();
  });

  it("初始化并订阅原生最大化状态，卸载取消监听", async () => {
    let listener: StateListener | undefined;
    ipcMocks.on.mockImplementation(
      (_channel: string, callback: StateListener) => {
        listener = callback;
        return ipcMocks.unsubscribe;
      },
    );
    const { unmount } = renderTitleBar();
    await screen.findByRole("button", { name: "common:windowMaximize" });
    act(() => listener?.({}, { maximized: true }));
    expect(
      screen.getByRole("button", { name: "common:windowRestore" }),
    ).toBeTruthy();
    const callsBeforeUnmount = ipcMocks.unsubscribe.mock.calls.length;
    unmount();
    expect(ipcMocks.unsubscribe.mock.calls.length).toBeGreaterThan(
      callsBeforeUnmount,
    );
  });

  it("点击执行窗口操作并更新最大化状态", async () => {
    renderTitleBar();
    fireEvent.click(
      await screen.findByRole("button", { name: "common:windowMinimize" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "common:windowMaximize" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "common:close" }));
    expect(
      await screen.findByRole("button", { name: "common:windowRestore" }),
    ).toBeTruthy();
    expect(ipcMocks.invoke).toHaveBeenCalledWith("window:minimize");
    expect(ipcMocks.invoke).toHaveBeenCalledWith("window:toggleMaximize");
    expect(ipcMocks.invoke).toHaveBeenCalledWith("window:close");
  });

  it("窗口操作失败显示错误提示", async () => {
    ipcMocks.invoke.mockImplementation((channel: string) =>
      channel === "window:minimize"
        ? Promise.reject(new Error("denied"))
        : Promise.resolve({ maximized: false }),
    );
    renderTitleBar();
    fireEvent.click(
      await screen.findByRole("button", { name: "common:windowMinimize" }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("common:windowControlFailed"),
    );
  });
});

// @vitest-environment jsdom
/** GlobalSidebar 平台 Logo 行：Windows 对齐 macOS，Linux 保持无 Logo 行 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.hoisted(() => {
  Object.defineProperty(globalThis, "__APP_VERSION__", {
    value: "0.0.0-test",
    configurable: true,
    writable: true,
  });
  Object.defineProperty(window, "platform", {
    value: "win32",
    configurable: true,
    writable: true,
  });
});

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});
vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn() }));
vi.mock("@/domains/ai/layout/hooks/use-ai-layout-keybindings", () => ({
  useAiLayoutKeybindings: vi.fn(),
}));
vi.mock("@/domains/ai/store/ai-ui.store", () => ({
  useAiUiStore: (selector: (state: { sidebarCollapsed: boolean }) => unknown) =>
    selector({ sidebarCollapsed: false }),
}));
vi.mock("@/domains/user/store/user.store", () => ({
  useUserStore: (selector: (state: { user: { id: number } }) => unknown) =>
    selector({ user: { id: 1 } }),
}));
vi.mock("@/domains/ai/layout/components/SessionTreePanel", () => ({
  default: () => null,
}));
vi.mock("../../src-react/components/layout/UserMenu", () => ({
  default: () => null,
}));
vi.mock("@/components/common/AppLogo", () => ({
  default: () => <div data-testid="app-logo" />,
}));
vi.mock("@/domains/ai/layout/components/HostSwitcher", () => ({
  default: ({ compact }: { compact?: boolean }) => (
    <div data-testid="host-switcher" data-compact={compact ? "1" : "0"} />
  ),
}));

import GlobalSidebar from "../../src-react/components/layout/GlobalSidebar";

function renderSidebar() {
  render(
    <MemoryRouter initialEntries={["/module/ai"]}>
      <GlobalSidebar />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe("GlobalSidebar Logo 行", () => {
  it.each(["win32", "darwin"] as const)(
    "%s 复用同一 Logo/应用名/版本首行",
    (platform) => {
      window.platform = platform;
      renderSidebar();
      const logo = screen.getByTestId("app-logo");
      const row = logo.parentElement!;
      expect(row.classList).toContain("h-9");
      expect(row.classList).toContain("px-3");
      expect(row.classList).toContain("border-b");
      expect(screen.getByText("common:appName")).toBeTruthy();
      expect(screen.getByText("0.0.0-test")).toBeTruthy();
    },
  );

  it("Windows 整体上移 44px 并延长底部，macOS 保持原位", () => {
    window.platform = "win32";
    const { container, unmount } = render(
      <MemoryRouter initialEntries={["/module/ai"]}>
        <GlobalSidebar />
      </MemoryRouter>,
    );
    const aside = container.querySelector("aside")!;
    expect(aside.classList).toContain("-mt-11");
    expect(aside.classList).toContain("h-[calc(100%+2.75rem)]");
    expect(aside.classList).toContain("z-[60]");
    unmount();

    window.platform = "darwin";
    const mac = render(
      <MemoryRouter initialEntries={["/module/ai"]}>
        <GlobalSidebar />
      </MemoryRouter>,
    );
    const macAside = mac.container.querySelector("aside")!;
    expect(macAside.classList).not.toContain("-mt-11");
    expect(macAside.classList).toContain("h-full");
  });

  it("Linux 不新增 Logo 行", () => {
    window.platform = "linux";
    renderSidebar();
    expect(screen.queryByTestId("app-logo")).toBeNull();
    expect(screen.queryByText("common:appName")).toBeNull();
    expect(screen.queryByText("0.0.0-test")).toBeNull();
  });
});

describe("GlobalSidebar Logo 行主机切换器（macOS 挪位批）", () => {
  it("darwin：主机切换器落在 Logo 行内（logo/名称/版本右侧）", () => {
    window.platform = "darwin";
    renderSidebar();
    const logo = screen.getByTestId("app-logo");
    const row = logo.parentElement!;
    const hostSwitcher = screen.getByTestId("host-switcher");
    // 切换器与 logo 同行（同一 h-9 首行容器内，外包 ml-auto 定位层）
    expect(row.contains(hostSwitcher)).toBe(true);
    // 视觉序：切换器由 ml-auto 推至行内末位（行最后一个子元素承载）
    expect(row.lastElementChild!.contains(hostSwitcher)).toBe(true);
  });

  it("darwin：品牌名永不截断（shrink-0）+ 切换器 compact 形态收紧主机名", () => {
    window.platform = "darwin";
    renderSidebar();
    // 品牌名 shrink-0：行内空间不足时被挤压的是切换器侧（其内部截断），
    // 天枢名称/版本恒完整（用户裁定：不要把 logo 的名称遮住）
    const appName = screen.getByText("common:appName");
    expect(appName.classList).toContain("shrink-0");
    // compact 透传：切换器内部主机名收紧 max-w-16 截断 + 冒泡全称
    expect(screen.getByTestId("host-switcher").getAttribute("data-compact")).toBe(
      "1",
    );
  });

  it("win32：Logo 行不含主机切换器（Windows 走自绘标题栏，避免双入口）", () => {
    window.platform = "win32";
    renderSidebar();
    expect(screen.getByTestId("app-logo")).toBeTruthy();
    expect(screen.queryByTestId("host-switcher")).toBeNull();
  });
});

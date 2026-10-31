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

// @vitest-environment jsdom
/**
 * AiTopbarActions 主机切换器平台/折叠门控（macOS 挪位批）：
 * - macOS 展开态：主机切换器在侧栏 Logo 行（GlobalSidebar），顶栏不渲染
 *   （双入口会让用户困惑数据源切换归属）
 * - macOS 折叠态：侧栏整体收起（Logo 行随之不可见），切换器回顶栏
 *   折叠键旁——保住「侧栏收起时主机切换器仍可达」既有不变量
 *   （AiTopbarActions 头注释：全局数据源切换与侧栏无关）
 * - Linux 展开态：logo 在 TopBar 内（非侧栏），切换器维持顶栏原位
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.hoisted(() => {
  Object.defineProperty(window, "platform", {
    value: "darwin",
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

// ai-ui store 可控态：模块级 mutable，用例内按需置 collapsed
const aiUiState = vi.hoisted(() => ({
  sidebarCollapsed: false,
  toggleSidebar: vi.fn(),
  setSearchOpen: vi.fn(),
}));
vi.mock("@/domains/ai/store/ai-ui.store", () => ({
  useAiUiStore: (selector: (state: typeof aiUiState) => unknown) =>
    selector(aiUiState),
}));

vi.mock("@/domains/ai/layout/components/HostSwitcher", () => ({
  default: () => <div data-testid="host-switcher" />,
}));
vi.mock("@/domains/ai/layout/components/FilterPopover", () => ({
  default: () => null,
}));
vi.mock("@/domains/ai/layout/components/GlobalSearchDialog", () => ({
  default: () => null,
}));

import AiTopbarActions from "../../src-react/domains/ai/layout/components/AiTopbarActions";

afterEach(() => {
  cleanup();
  aiUiState.sidebarCollapsed = false;
});

describe("AiTopbarActions 主机切换器门控", () => {
  it("darwin 展开态：顶栏不渲染主机切换器（已挪侧栏 Logo 行）", () => {
    window.platform = "darwin";
    aiUiState.sidebarCollapsed = false;
    render(<AiTopbarActions />);
    expect(screen.queryByTestId("host-switcher")).toBeNull();
    // 折叠/搜索/时间筛选仍在
    expect(screen.getByLabelText("layout:sidebar.collapse")).toBeTruthy();
    expect(screen.getByLabelText("layout:sidebar.search")).toBeTruthy();
  });

  it("darwin 折叠态：主机切换器回顶栏（侧栏 Logo 行已随收起不可见）", () => {
    window.platform = "darwin";
    aiUiState.sidebarCollapsed = true;
    render(<AiTopbarActions />);
    expect(screen.getByTestId("host-switcher")).toBeTruthy();
    expect(screen.getByLabelText("layout:sidebar.expand")).toBeTruthy();
  });

  it("linux 展开态：主机切换器维持顶栏（logo 在 TopBar 非侧栏）", () => {
    window.platform = "linux";
    aiUiState.sidebarCollapsed = false;
    render(<AiTopbarActions />);
    expect(screen.getByTestId("host-switcher")).toBeTruthy();
  });
});

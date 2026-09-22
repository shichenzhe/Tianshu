// @vitest-environment jsdom
/**
 * 资料库中间面板（树形栏）收起/展开回归测试：state 提升在
 * LibraryView——完整渲染走真实交互（点主区标题行左侧的收展切换
 * 按钮（单 toggle，PageTitle leading 槽；树栏内无此按钮）→ 窄条 →
 * 点窄条置顶的同源按钮展开形态 → 回展开态）。mock 骨架同
 * tests/layout/main-layout.test.tsx：i18n 直返 key、LibraryApi/invoke
 * stub。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/ipc", () => ({ invoke: vi.fn() }));
vi.mock("@/domains/ai/library/api/library.api", () => ({
  default: {
    list: vi.fn().mockResolvedValue({ items: [], breadcrumbs: [] }),
    search: vi.fn().mockResolvedValue([]),
    tree: vi.fn().mockResolvedValue([]),
    listRecent: vi.fn().mockResolvedValue([]),
    listFavorites: vi.fn().mockResolvedValue([]),
    toggleFavorite: vi.fn().mockResolvedValue(null),
    markViewed: vi.fn().mockResolvedValue(null),
    addFiles: vi.fn(),
    createFolder: vi.fn(),
    rename: vi.fn(),
    move: vi.fn(),
    delete: vi.fn(),
    revealItem: vi.fn(),
    subtreeCount: vi.fn(),
  },
}));

import LibraryView from "@/domains/ai/library/views/LibraryView";

function renderView() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <LibraryView />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("资料库树形栏收起/展开", () => {
  it("点主区标题行左侧切换按钮收起成窄条，再点窄条置顶按钮回展开态", async () => {
    renderView();

    // 展开态 → 收起按钮（toggle 的收起形态）在主区标题行标题左侧，
    // 树栏内不再有
    const sidebar = await screen.findByTestId("library-sidebar");
    const collapseBtn = await screen.findByLabelText(
      "chat:library.collapseSidebar",
    );
    expect(
      within(sidebar).queryByLabelText("chat:library.collapseSidebar"),
    ).toBeNull();
    fireEvent.click(collapseBtn);
    // 收起态 → 同一 toggle 的展开形态须在窄条首位（贴底 mt-auto 曾导致用户找不到入口）
    const rail = screen.getByTestId("library-sidebar-collapsed");
    const expandBtn = screen.getByLabelText("chat:library.expandSidebar");
    expect(rail.querySelector("button")).toBe(expandBtn);
    expect(rail.lastElementChild).not.toBe(expandBtn);

    // 收起态 → 点「展开侧边栏」
    fireEvent.click(expandBtn);
    await waitFor(() => {
      expect(screen.queryByTestId("library-sidebar-collapsed")).toBeNull();
    });
    // 收起按钮回到主区标题行（单按钮 toggle，可再次收起）
    expect(
      await screen.findByLabelText("chat:library.collapseSidebar"),
    ).toBeTruthy();
  });
});

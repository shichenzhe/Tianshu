// @vitest-environment jsdom
/**
 * 资料库中间面板（树形栏）收起/展开回归测试：state 提升在
 * LibraryView——完整渲染走真实交互（点主区标题行的收起按钮（Task 5
 * 移入 PageTitle children）→ 窄条 → 点窄条置顶展开按钮 → 回展开态）。
 * mock 骨架同 tests/layout/main-layout.test.tsx：i18n 直返 key、
 * LibraryApi/invoke stub。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
  it("点主区标题行收起按钮成窄条，再点窄条置顶展开按钮回展开态", async () => {
    renderView();

    // 展开态 → 点主区标题行的「收起侧边栏」（Task 5 起按钮在 PageTitle，
    // 树栏展开态顶部行不再有；默认视图「最近」下树栏无选中项）
    const collapseBtn = await screen.findByLabelText(
      "chat:library.collapseSidebar",
    );
    fireEvent.click(collapseBtn);
    // 收起态 → 展开按钮须在窄条首位（贴底 mt-auto 曾导致用户找不到入口）
    const rail = screen.getByTestId("library-sidebar-collapsed");
    const expandBtn = screen.getByLabelText("chat:library.expandSidebar");
    expect(rail.querySelector("button")).toBe(expandBtn);
    expect(rail.lastElementChild).not.toBe(expandBtn);

    // 收起态 → 点「展开侧边栏」
    fireEvent.click(expandBtn);
    await waitFor(() => {
      expect(screen.queryByTestId("library-sidebar-collapsed")).toBeNull();
    });
    expect(screen.getByTestId("library-sidebar")).toBeTruthy();
    // 收起按钮仍在主区标题行，可再次收起
    expect(
      await screen.findByLabelText("chat:library.collapseSidebar"),
    ).toBeTruthy();
  });
});

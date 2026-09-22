// @vitest-environment jsdom
/**
 * 资料库中间面板（树形栏）收起/展开回归测试：state 提升在
 * LibraryView——完整渲染走真实交互（点主区标题行左侧的收展开关
 * （唯一入口，PageTitle leading 槽，随态换 label/图标；收起态窄条
 * 无展开按钮——用户裁定多余）→ 窄条 → 再点同开关的展开形态 → 回
 * 展开态）。mock 骨架同 tests/layout/main-layout.test.tsx：i18n
 * 直返 key、LibraryApi/invoke stub。
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
  it("点主区标题行左侧开关收起成窄条，窄条无展开按钮，再点同开关展开", async () => {
    renderView();

    // 展开态 → 收起按钮（开关的收起形态）在主区标题行标题左侧，
    // 树栏内无此按钮
    const sidebar = await screen.findByTestId("library-sidebar");
    const collapseBtn = await screen.findByLabelText(
      "chat:library.collapseSidebar",
    );
    expect(
      within(sidebar).queryByLabelText("chat:library.collapseSidebar"),
    ).toBeNull();
    fireEvent.click(collapseBtn);

    // 收起态 → 窄条仅剩搜索入口（展开按钮已按用户裁定移除）；
    // 同一开关在主区标题行换为展开形态（唯一展开入口）
    const rail = screen.getByTestId("library-sidebar-collapsed");
    expect(
      within(rail).queryByLabelText("chat:library.expandSidebar"),
    ).toBeNull();
    const expandBtn = screen.getByLabelText("chat:library.expandSidebar");
    expect(rail.contains(expandBtn)).toBe(false);
    fireEvent.click(expandBtn);

    // 回展开态：开关换回收起形态，可再次收起
    await waitFor(() => {
      expect(screen.queryByTestId("library-sidebar-collapsed")).toBeNull();
    });
    expect(screen.getByLabelText("chat:library.collapseSidebar")).toBeTruthy();
  });
});

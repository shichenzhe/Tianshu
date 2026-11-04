// @vitest-environment jsdom
/**
 * 资料库中间面板（树形栏）收起/展开回归测试：state 提升在
 * LibraryView——完整渲染走真实交互（点 TopBar 中段（PageHeaderHost
 * 同树挂载的替身，page-header title 槽，竖分隔线后的主区侧）的收展
 * 开关（唯一入口，随态换 label/图标）→ 树栏彻底隐藏（无窄条、无搜索
 * 入口——用户裁定）→ 再点同开关的展开形态 → 回展开态）。mock 骨架
 * 同 tests/layout/main-layout.test.tsx：i18n 直返 key、LibraryApi/
 * invoke stub。
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
import { MemoryRouter } from "react-router-dom";

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
import PageHeaderHost, {
  PageHeaderRightHost,
} from "@/components/layout/PageHeaderHost";
import { usePageHeaderStore } from "@/components/layout/page-header.store";

function renderView() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      {/* 两个顶段替身同树挂载：中段=「资料库」标题、右段=主区顶部
          （开关所在，PageHeaderRightHost） */}
      <PageHeaderHost />
      <PageHeaderRightHost />
      <MemoryRouter>
        <LibraryView />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  // store 为模块级单例，防跨用例残留页面注册的顶行
  usePageHeaderStore.setState({ slot: null });
});

describe("资料库树形栏收起/展开", () => {
  it("点 TopBar 右段开关收起——树栏彻底隐藏（无窄条无搜索），再点同开关展开", async () => {
    renderView();

    // 展开态 → 收起按钮（开关的收起形态）在 TopBar 右段替身内，
    // 树栏内无此按钮
    const sidebar = await screen.findByTestId("library-sidebar");
    const collapseBtn = await screen.findByLabelText(
      "chat:library.collapseSidebar",
    );
    expect(
      within(sidebar).queryByLabelText("chat:library.collapseSidebar"),
    ).toBeNull();
    fireEvent.click(collapseBtn);

    // 收起态 → 树栏整体消失（无窄条、无搜索入口）；同一开关在
    // 主区标题行换为展开形态（唯一展开入口）
    await waitFor(() => {
      expect(screen.queryByTestId("library-sidebar")).toBeNull();
    });
    expect(screen.queryByTestId("library-sidebar-collapsed")).toBeNull();
    expect(screen.queryByLabelText("chat:library.searchLabel")).toBeNull();
    const expandBtn = screen.getByLabelText("chat:library.expandSidebar");
    fireEvent.click(expandBtn);

    // 回展开态：开关换回收起形态，树栏恢复
    await waitFor(() => {
      expect(screen.getByTestId("library-sidebar")).toBeTruthy();
    });
    expect(screen.getByLabelText("chat:library.collapseSidebar")).toBeTruthy();
  });
});

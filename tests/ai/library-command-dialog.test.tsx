// @vitest-environment jsdom
/**
 * 命令面板（spec §4）：空输入显示最近浏览（listRecent）、键盘 ↑↓ 选中、
 * Enter 触发 onSelect、输入 300ms 防抖转 search 且空结果显示未找到。
 * mock 骨架照 tests/ai/library-sidebar-collapse.test.tsx：i18n 直返 key、
 * LibraryApi 整体 mock（vi.hoisted 供用例内 mockResolvedValueOnce）+
 * QueryClientProvider + Radix jsdom 桩（scrollIntoView 亦被面板自身
 * 选中项跟随时调用，必须先于渲染 stub）。
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const { searchMock, listRecentMock } = vi.hoisted(() => ({
  searchMock: vi.fn(async () => []),
  listRecentMock: vi.fn(async () => [
    {
      id: 1,
      name: "a.md",
      kind: "file",
      location: [],
      favorite: false,
      lastViewedAt: "2026-01-01T00:00:00Z",
    },
    {
      id: 2,
      name: "b.md",
      kind: "file",
      location: ["F1"],
      favorite: false,
      lastViewedAt: "2026-01-02T00:00:00Z",
    },
  ]),
}));
vi.mock("@/domains/ai/library/api/library.api", () => ({
  default: {
    search: (...a: unknown[]) => searchMock(...a),
    listRecent: () => listRecentMock(),
  },
}));
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

// Radix Dialog 在 jsdom 的最小桩；scrollIntoView 兼面板选中项跟随调用
beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLElement.prototype.hasPointerCapture = () => false;
  window.HTMLElement.prototype.releasePointerCapture = () => {};
});

import LibraryCommandDialog from "@/domains/ai/library/components/LibraryCommandDialog";

function renderDialog(props?: {
  onClose?: () => void;
  onSelect?: (item: unknown) => void;
}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <LibraryCommandDialog
        open
        onClose={props?.onClose ?? (() => {})}
        onSelect={props?.onSelect ?? (() => {})}
      />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("LibraryCommandDialog", () => {
  it("空输入显示最近浏览两项", async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByText("b.md")).toBeTruthy());
    expect(screen.getByText("a.md")).toBeTruthy();
  });

  it("ArrowDown 移动选中，Enter 上报选中项", async () => {
    const onSelect = vi.fn();
    renderDialog({ onSelect });
    await waitFor(() => expect(screen.getByText("b.md")).toBeTruthy());
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "ArrowDown" }); // 0 -> 1
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 2 })),
    );
  });

  it("输入触发 search，无结果显示未找到", async () => {
    searchMock.mockResolvedValueOnce([]);
    renderDialog();
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "zzz" } });
    await waitFor(() =>
      expect(screen.getByText("chat:library.commandNoResult")).toBeTruthy(),
    );
  });
});

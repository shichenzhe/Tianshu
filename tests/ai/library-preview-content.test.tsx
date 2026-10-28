// @vitest-environment jsdom
/**
 * LibraryPreviewContent 工具行（T14）：文件条目恒有「在新窗口打开」
 * （fileWindow:open 投 library resource，成功 toast openedToast/失败
 * toast 原文）+ md/csv 编辑时保存状态指示共存；folder/link 条目无按钮。
 * md 编辑器桩化（LibraryMarkdownEditor），mock 骨架同 file-tab-content。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toast } from "sonner";

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock(
  "../../src-react/domains/ai/library/components/LibraryMarkdownEditor",
  () => ({
    default: ({ value }: { value: string }) => (
      <textarea aria-label="md" value={value} readOnly />
    ),
  }),
);

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("../../src-react/lib/ipc", () => ({ invoke: invokeMock }));

import LibraryPreviewContent from "../../src-react/domains/ai/library/components/LibraryPreviewContent";
import type { LibraryItem } from "../../src-react/domains/ai/library/api/library.api";

const FILE_ITEM = {
  id: 3,
  parentId: null,
  name: "note.md",
  kind: "file",
  fileType: "markdown",
  mimeType: "text/markdown",
  size: 12,
  originalPath: null,
  url: null,
  favorite: false,
  lastViewedAt: null,
  location: [],
  storagePath: "/root/library/3.md",
  createdAt: "2026-10-13T00:00:00.000Z",
  updatedAt: "2026-10-14T00:00:00.000Z",
} as unknown as LibraryItem;

const FOLDER_ITEM = {
  ...FILE_ITEM,
  id: 4,
  name: "docs",
  kind: "folder",
  fileType: null,
  storagePath: null,
} as unknown as LibraryItem;

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  vi.clearAllMocks();
});

describe("LibraryPreviewContent 工具行（T14 文件窗入口）", () => {
  it("文件条目：在新窗口打开 → fileWindow:open library resource；成功 toast", async () => {
    invokeMock.mockImplementation((ch: string) => {
      if (ch === "file:readExternalFile")
        return Promise.resolve({ kind: "text", content: "# 库文档" });
      if (ch === "fileWindow:open")
        return Promise.resolve({ windowId: "file-window:x" });
      return null;
    });
    render(<LibraryPreviewContent item={FILE_ITEM} />);
    await screen.findByRole("textbox", { name: "md" });
    // md 编辑：保存状态指示与新窗按钮同行共存
    expect(screen.getByText("chat:library.savedIndicator")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "chat:fileWindow.openInNewWindow" }),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("fileWindow:open", {
        resources: [{ kind: "library", itemId: 3 }],
      }),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("chat:fileWindow.openedToast"),
    );
  });

  it("打开失败 → toast 原文（详情不关）", async () => {
    invokeMock.mockImplementation((ch: string) => {
      if (ch === "file:readExternalFile")
        return Promise.resolve({ kind: "text", content: "# 库文档" });
      if (ch === "fileWindow:open")
        return Promise.reject(new Error("窗口开不了"));
      return null;
    });
    render(<LibraryPreviewContent item={FILE_ITEM} />);
    fireEvent.click(
      screen.getByRole("button", { name: "chat:fileWindow.openInNewWindow" }),
    );
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("窗口开不了"));
  });

  it("folder 条目无工具行按钮（无文件窗语义）", () => {
    render(<LibraryPreviewContent item={FOLDER_ITEM} />);
    expect(
      screen.queryByRole("button", { name: "chat:fileWindow.openInNewWindow" }),
    ).toBeNull();
  });
});

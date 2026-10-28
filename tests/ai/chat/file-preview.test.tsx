// @vitest-environment jsdom
/**
 * FilePreview 按类型预览测试（mock 骨架同 file-list-item.test.tsx：t 返回
 * key、sonner 桩、ArtifactApi.readFile 按用例返回；MarkdownView 轻桩）：
 * - md → MarkdownView；纯文本/代码 → 原文 <pre>
 * - webview 类 → <webview file:// partition>（src 由后端回的绝对路径编码）
 * - 读取失败 → 空态 + 「在 Finder 中显示」兜底
 * - 「在新窗口打开」：invoke fileWindow:open 成功后调 onOpenInNewWindow
 *   （移动语义关主窗 tab 由调用方）；失败 toast 不回调
 * - 「下载」（聊天导出批）：文本类 Blob+<a> 纯渲染层；webview 类无内容
 *   通道不展示按钮
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
import { toast } from "sonner";

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const readFileMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src-react/domains/ai/api/artifact.api", () => ({
  default: {
    readFile: readFileMock,
    revealFile: vi.fn(),
  },
}));

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src-react/lib/ipc", () => ({
  invoke: invokeMock,
}));

const downloadBlobMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src-react/lib/file-download", () => ({
  downloadBlob: downloadBlobMock,
}));

// fileChanged 订阅全局桩（listeners Map；T12 主窗缓存失效用例）
const listeners = new Map<string, (e: unknown, p: unknown) => void>();
vi.stubGlobal("ipcRenderer", {
  on: (ch: string, cb: (e: unknown, p: unknown) => void) => {
    listeners.set(ch, cb);
    return () => listeners.delete(ch);
  },
});

vi.mock("../../../src-react/domains/ai/chat/components/MarkdownView", () => ({
  default: ({ text }: { text: string }) => (
    <div data-testid="markdown-stub">{text}</div>
  ),
}));

import FilePreview from "../../../src-react/domains/ai/chat/components/artifacts/FilePreview";
import type { SessionFile } from "../../../src-react/domains/ai/chat/lib/artifacts";

// vitest 未开 globals，RTL 自动清理不生效，显式清理 + mock 重置
afterEach(() => {
  cleanup();
  readFileMock.mockReset();
  listeners.clear();
  downloadBlobMock.mockClear();
  invokeMock.mockReset();
});

const file = (path: string): SessionFile => ({
  path,
  group: "artifact",
  status: "written",
  messageId: 1,
});

function renderPreview(f: SessionFile) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <FilePreview file={f} workspaceId={7} onBack={() => {}} />
    </QueryClientProvider>,
  );
}

describe("FilePreview 按类型预览", () => {
  it("md → MarkdownView 渲染", async () => {
    readFileMock.mockResolvedValue({
      kind: "text",
      content: "# 标题",
      size: 5,
      mtime: 1,
    });
    renderPreview(file("readme.md"));
    expect(await screen.findByTestId("markdown-stub")).toBeTruthy();
    expect(screen.getByTestId("markdown-stub").textContent).toBe("# 标题");
  });

  it("代码/纯文本 → 原文 <pre>（不经 Markdown 解析）", async () => {
    readFileMock.mockResolvedValue({
      kind: "text",
      content: "    const a = 1;",
      size: 16,
      mtime: 1,
    });
    renderPreview(file("main.ts"));
    await waitFor(() =>
      expect(document.querySelector("pre")?.textContent).toBe(
        "    const a = 1;",
      ),
    );
    expect(screen.queryByTestId("markdown-stub")).toBeNull();
  });

  it("webview 类 → <webview file:// partition>（src 为编码后的绝对路径）", async () => {
    readFileMock.mockResolvedValue({
      kind: "webview",
      absPath: "/tmp/ws/report.pdf",
      size: 1024,
      mtime: 1,
    });
    const { container } = renderPreview(file("report.pdf"));
    await waitFor(() =>
      expect(container.querySelector("webview")).toBeTruthy(),
    );
    const view = container.querySelector("webview")!;
    expect(view.getAttribute("src")).toBe("file:///tmp/ws/report.pdf");
    expect(view.getAttribute("partition")).toBe("artifact-preview");
  });

  it("读取失败 → 空态 + 在 Finder 中显示兜底", async () => {
    readFileMock.mockRejectedValue(new Error("文件超过 512KB 预览上限"));
    renderPreview(file("big.log"));
    expect(
      await screen.findByText("chat:artifacts.previewFailed"),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "chat:artifacts.actionReveal" }),
    ).toBeTruthy();
  });

  it("「在新窗口打开」：invoke fileWindow:open 成功后调 onOpenInNewWindow", async () => {
    invokeMock.mockResolvedValue({ windowId: "fw:x" });
    const onOpenInNewWindow = vi.fn();
    readFileMock.mockResolvedValue({
      kind: "text",
      content: "x",
      size: 1,
      mtime: 1,
    });
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <FilePreview
          file={file("a.md")}
          workspaceId={7}
          onOpenInNewWindow={onOpenInNewWindow}
        />
      </QueryClientProvider>,
    );
    const btn = await screen.findByRole("button", {
      name: "chat:fileWindow.openInNewWindow",
    });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("fileWindow:open", {
        resources: [{ kind: "workspace", workspaceId: 7, path: "a.md" }],
      });
      expect(onOpenInNewWindow).toHaveBeenCalledTimes(1);
    });
  });

  it("「在新窗口打开」失败：toast 报错且不回调 onOpenInNewWindow", async () => {
    invokeMock.mockRejectedValue(new Error("窗口打开失败"));
    const onOpenInNewWindow = vi.fn();
    readFileMock.mockResolvedValue({
      kind: "text",
      content: "x",
      size: 1,
      mtime: 1,
    });
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <FilePreview
          file={file("a.md")}
          workspaceId={7}
          onOpenInNewWindow={onOpenInNewWindow}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "chat:fileWindow.openInNewWindow",
      }),
    );
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalled());
    expect(onOpenInNewWindow).not.toHaveBeenCalled();
  });

  it("workspace:fileChanged 同文件 → invalidate artifact-file；异路径不失效；卸载退订", async () => {
    readFileMock.mockResolvedValue({
      kind: "text",
      content: "x",
      size: 1,
      mtime: 1,
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const spy = vi.spyOn(client, "invalidateQueries");
    const { unmount } = render(
      <QueryClientProvider client={client}>
        <FilePreview file={file("a.md")} workspaceId={7} onBack={() => {}} />
      </QueryClientProvider>,
    );
    await screen.findByTestId("markdown-stub");
    const emit = (payload: unknown) =>
      listeners.get("workspace:fileChanged")?.(undefined, payload);
    // 异路径/异 workspace：各自过滤，不失效
    emit({ workspaceId: 7, path: "b.md" });
    emit({ workspaceId: 8, path: "a.md" });
    await new Promise((r) => setTimeout(r, 20));
    expect(spy).not.toHaveBeenCalled();
    // 同文件：失效精确键重取
    emit({ workspaceId: 7, path: "a.md" });
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({
        queryKey: ["artifact-file", 7, "a.md"],
      }),
    );
    // 卸载退订：事件不再失效
    unmount();
    spy.mockClear();
    emit({ workspaceId: 7, path: "a.md" });
    await new Promise((r) => setTimeout(r, 20));
    expect(spy).not.toHaveBeenCalled();
  });

  it("「下载」文本类：downloadBlob 纯渲染层落盘（文件名取 basename）", async () => {
    readFileMock.mockResolvedValue({
      kind: "text",
      content: "hello",
      size: 5,
      mtime: 1,
    });
    renderPreview(file("notes/todo.md"));
    const btn = await screen.findByRole("button", {
      name: "chat:artifacts.actionDownload",
    });
    fireEvent.click(btn);
    await waitFor(() => expect(downloadBlobMock).toHaveBeenCalledTimes(1));
    const [blob, name] = downloadBlobMock.mock.calls[0];
    expect(name).toBe("todo.md");
    expect(blob).toBeInstanceOf(Blob);
  });

  it("「下载」webview 类无内容通道：不展示按钮", async () => {
    readFileMock.mockResolvedValue({
      kind: "webview",
      absPath: "/tmp/ws/report.pdf",
      size: 1024,
      mtime: 1,
    });
    renderPreview(file("report.pdf"));
    await waitFor(() => expect(document.querySelector("webview")).toBeTruthy());
    expect(
      screen.queryByRole("button", { name: "chat:artifacts.actionDownload" }),
    ).toBeNull();
  });
});

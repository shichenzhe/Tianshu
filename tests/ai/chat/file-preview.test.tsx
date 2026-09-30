// @vitest-environment jsdom
/**
 * FilePreview 按类型预览测试（mock 骨架同 file-list-item.test.tsx：t 返回
 * key、sonner 桩、ArtifactApi.readFile 按用例返回；MarkdownView 轻桩）：
 * - md → MarkdownView；纯文本/代码 → 原文 <pre>
 * - webview 类 → <webview file:// partition>（src 由后端回的绝对路径编码）
 * - 读取失败 → 空态 + 「在 Finder 中显示」兜底
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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
      <FilePreview
        file={f}
        workspaceId={7}
        onBack={() => {}}
        fullscreen={false}
        onToggleFullscreen={() => {}}
      />
    </QueryClientProvider>,
  );
}

/** 全屏形态（window.platform stub 为 darwin 之外的默认值即可） */
function renderFullscreen(f: SessionFile) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <FilePreview
        file={f}
        workspaceId={7}
        onBack={() => {}}
        fullscreen
        onToggleFullscreen={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe("FilePreview 按类型预览", () => {
  it("md → MarkdownView 渲染", async () => {
    readFileMock.mockResolvedValue({
      kind: "text",
      content: "# 标题",
      size: 5,
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

  it("全屏为真全屏：Portal 到 body，fixed 盖整视口（含 TopBar，z 高于顶栏）", async () => {
    readFileMock.mockResolvedValue({ kind: "text", content: "x", size: 1 });
    renderFullscreen(file("a.md"));
    await waitFor(() =>
      expect(screen.getByTestId("markdown-stub")).toBeTruthy(),
    );
    // Portal 挂载点为 body（脱离 ChatView/main 祖先环境）
    const root = document.body.querySelector(".fixed.inset-0") as HTMLElement;
    expect(root).toBeTruthy();
    expect(root.className).toContain("z-[60]");
    expect(root.className).not.toContain("absolute");
    // no-drag 挖洞：TopBar drag 区吞鼠标事件的防御（Electron drag 命中
    // 不遵循 z-index，Esc 逃生之外的按钮可达性由它保证）
    expect(root.style.webkitAppRegion ?? root.style.WebkitAppRegion).toBe(
      "no-drag",
    );
    expect(root.style.zIndex).toBe("60");
  });
});

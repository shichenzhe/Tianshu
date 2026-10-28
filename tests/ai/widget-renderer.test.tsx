// tests/ai/widget-renderer.test.tsx
/**
 * WidgetRenderer（聊天面板可视化组件沙箱渲染）：
 * - buildWidgetSrcDoc：CSP（default-src 'none'、script/style 仅内联）、
 *   代码注入、resize 上报脚本齐备
 * - 组件：running 态显示加载占位（不注入 iframe）、done 后挂 sandbox
 *   iframe（allow-scripts 且无 allow-same-origin——srcDoc 唯一源隔离）
 * - 截图操作（聊天导出批）：done 后标题栏复制/下载按钮；点击经
 *   captureWidget（iframe rect DIP）→ 剪贴板共享件 / 另存对话框
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
      i18n: { language: "zh-CN" },
    }),
  };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const captureWidgetMock = vi.hoisted(() => vi.fn());
const saveImageFileMock = vi.hoisted(() => vi.fn());
vi.mock("@/domains/ai/api/chat.api", () => ({
  default: {
    captureWidget: captureWidgetMock,
    saveImageFile: saveImageFileMock,
  },
}));

const copyImageToClipboardMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/data-url", () => ({
  copyImageToClipboard: copyImageToClipboardMock,
}));

import WidgetRenderer, {
  buildWidgetSrcDoc,
} from "../../src-react/domains/ai/chat/components/WidgetRenderer";

afterEach(() => {
  cleanup();
  captureWidgetMock.mockReset();
  saveImageFileMock.mockReset();
  copyImageToClipboardMock.mockReset();
});

describe("buildWidgetSrcDoc（沙箱文档构造）", () => {
  it("含 CSP（default-src 'none' + 内联脚本/样式）、重置样式与代码本体", () => {
    const doc = buildWidgetSrcDoc("<canvas id='c'></canvas>");
    expect(doc).toContain('http-equiv="Content-Security-Policy"');
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("script-src 'unsafe-inline'");
    expect(doc).toContain("<canvas id='c'></canvas>");
    // 透明背景（融入聊天流，WorkBuddy 同款）
    expect(doc).toContain("background-color: transparent");
  });

  it("resize 上报脚本：postMessage widget:resize + 观察器（高度自适应）", () => {
    const doc = buildWidgetSrcDoc("<div>x</div>");
    expect(doc).toContain("widget:resize");
    expect(doc).toContain("ResizeObserver");
    expect(doc).toContain("MutationObserver");
  });
});

describe("WidgetRenderer 组件", () => {
  it("done：渲染标题栏 + sandbox iframe（allow-scripts、无 allow-same-origin）", () => {
    render(<WidgetRenderer title="销量图" code="<b>chart</b>" state="done" />);
    expect(screen.getByText("销量图")).toBeTruthy();
    const frame = document.querySelector("iframe");
    expect(frame).toBeTruthy();
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame?.getAttribute("srcdoc")).toContain("<b>chart</b>");
  });

  it("running：加载占位（不挂 iframe——流式中 args 渐进，防反复重载闪动）", () => {
    render(<WidgetRenderer code="" state="running" />);
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByTestId("widget-loading")).toBeTruthy();
    // 截图操作仅 done 后可用（running 无 iframe 可截）
    expect(
      screen.queryByRole("button", { name: "chat:widget.copySnapshot" }),
    ).toBeNull();
  });
});

describe("WidgetRenderer 截图操作（聊天导出批）", () => {
  it("done：标题栏渲染复制/下载截图按钮", () => {
    render(<WidgetRenderer title="销量图" code="<b>c</b>" state="done" />);
    expect(
      screen.getByRole("button", { name: "chat:widget.copySnapshot" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "chat:widget.downloadSnapshot" }),
    ).toBeTruthy();
  });

  it("复制截图：captureWidget（iframe rect）→ copyImageToClipboard", async () => {
    captureWidgetMock.mockResolvedValue("data:image/png;base64,QUJD");
    copyImageToClipboardMock.mockResolvedValue(undefined);
    render(<WidgetRenderer title="销量图" code="<b>c</b>" state="done" />);
    fireEvent.click(
      screen.getByRole("button", { name: "chat:widget.copySnapshot" }),
    );
    await waitFor(() =>
      expect(copyImageToClipboardMock).toHaveBeenCalledWith(
        "data:image/png;base64,QUJD",
      ),
    );
    // rect 取自 iframe getBoundingClientRect（jsdom 零值，断言形状即可）
    expect(captureWidgetMock).toHaveBeenCalledWith({
      x: expect.any(Number),
      y: expect.any(Number),
      width: expect.any(Number),
      height: expect.any(Number),
    });
  });

  it("下载截图：captureWidget → saveImageFile 另存（标题作默认名）", async () => {
    captureWidgetMock.mockResolvedValue("data:image/png;base64,QUJD");
    saveImageFileMock.mockResolvedValue("/tmp/out.png");
    render(<WidgetRenderer title="销量图" code="<b>c</b>" state="done" />);
    fireEvent.click(
      screen.getByRole("button", { name: "chat:widget.downloadSnapshot" }),
    );
    await waitFor(() =>
      expect(saveImageFileMock).toHaveBeenCalledWith(
        "data:image/png;base64,QUJD",
        "销量图",
      ),
    );
  });
});

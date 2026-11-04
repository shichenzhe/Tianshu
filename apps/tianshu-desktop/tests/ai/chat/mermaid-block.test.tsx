// @vitest-environment jsdom
/**
 * MermaidBlock（mermaid 围栏渲染成图）单测：
 * - 渲染成功：mermaid.render 懒加载调用，SVG 注入 DOM，操作条（复制/下载）渲染
 * - 渲染失败（模型语法错误）：降级普通 CodeBlock 显示源码（可复制原文）
 * - 明暗切换：data-mode 变化触发重渲染（主题跟随）
 * - 点击复制：SVG→PNG→图片入剪贴板（svgToPngDataUrl/copyImageToClipboard 替身）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

const renderMock = vi.hoisted(() => vi.fn());
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: renderMock,
  },
}));
// jsdom 无 canvas：svg→PNG 与图片剪贴板均走替身（交互链路断言替身被调）
const svgToPngMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src-react/domains/ai/chat/lib/mermaid-export", () => ({
  svgToPngDataUrl: svgToPngMock,
}));
const copyImageMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/data-url", () => ({ copyImageToClipboard: copyImageMock }));
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", () => ({ invoke: invokeMock }));

import MermaidBlock from "../../../src-react/domains/ai/chat/components/MermaidBlock";

const SVG = '<svg viewBox="0 0 120 40"><rect/></svg>';
const CODE = "graph TD; A-->B";

beforeEach(() => {
  renderMock.mockReset();
  svgToPngMock.mockReset();
  copyImageMock.mockClear();
  document.documentElement.setAttribute("data-mode", "light");
});
afterEach(cleanup);

describe("MermaidBlock", () => {
  it("渲染成功：SVG 注入 + 操作条按钮", async () => {
    renderMock.mockResolvedValue({ svg: SVG });
    render(<MermaidBlock code={CODE} />);
    await waitFor(() => {
      expect(document.querySelector("svg")).not.toBeNull();
    });
    expect(
      screen.getByRole("button", { name: "chat:codeBlock.copyImage" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "chat:codeBlock.downloadImage" }),
    ).toBeTruthy();
  });

  it("渲染失败降级普通代码块（源码可见）", async () => {
    renderMock.mockRejectedValue(new Error("bad syntax"));
    render(<MermaidBlock code={CODE} />);
    await waitFor(() => {
      expect(screen.getByText(CODE)).toBeTruthy();
    });
    // 降级态无图片操作条（复制源码走 CodeBlock 工具条）
    expect(
      screen.queryByRole("button", { name: "chat:codeBlock.copyImage" }),
    ).toBeNull();
  });

  it("data-mode 切换触发重渲染（主题跟随）", async () => {
    renderMock.mockResolvedValue({ svg: SVG });
    render(<MermaidBlock code={CODE} />);
    await waitFor(() => {
      expect(renderMock).toHaveBeenCalledTimes(1);
    });
    // 模拟外观模块切深色（skin.store.applySkin 写 documentElement）
    document.documentElement.setAttribute("data-mode", "dark");
    await waitFor(() => {
      expect(renderMock).toHaveBeenCalledTimes(2);
    });
  });

  it("点击复制：SVG→PNG→图片入剪贴板", async () => {
    renderMock.mockResolvedValue({ svg: SVG });
    svgToPngMock.mockResolvedValue("data:image/png;base64,QUJD");
    render(<MermaidBlock code={CODE} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "chat:codeBlock.copyImage" }),
    );
    await waitFor(() => {
      expect(svgToPngMock).toHaveBeenCalledWith(SVG, false);
      expect(copyImageMock).toHaveBeenCalledWith("data:image/png;base64,QUJD");
    });
  });

  it("点击下载：另存通道收到 PNG dataUrl 与默认名", async () => {
    renderMock.mockResolvedValue({ svg: SVG });
    svgToPngMock.mockResolvedValue("data:image/png;base64,QUJD");
    invokeMock.mockResolvedValue("/tmp/mermaid.png");
    render(<MermaidBlock code={CODE} />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "chat:codeBlock.downloadImage",
      }),
    );
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "file:saveDataUrl",
        "data:image/png;base64,QUJD",
        "chat:codeBlock.mermaidFileName",
      );
    });
  });
});

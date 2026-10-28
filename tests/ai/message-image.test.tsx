// @vitest-environment jsdom
/**
 * MessageImage（用户消息图片附件 chip）单测：
 * - chip 即时渲染文件名（挂载不读盘——查询 enabled=zoomed）
 * - 点击 chip → Dialog lightbox 打开并读盘展示大图
 * - 读取失败（null）→ lightbox 内「图片已失效」提示（chip 仍显示）
 * - 读盘中 → lightbox 内 loading spinner
 * - lightbox 操作条（聊天导出批）：另存为走 ChatApi.saveImageFile（本地
 *   invoke file:saveDataUrl）；复制走 W3C 剪贴板共享件
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/i18n", () => ({
  default: { t: (key: string) => key },
}));
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", () => ({ invoke: invokeMock }));

import { MessageImage } from "../../src-react/domains/ai/chat/components/MessageImage";

const DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

function renderImage(
  props: { imagePath: string; name?: string } = {
    imagePath: "attachments/a.png",
    name: "a.png",
  },
) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MessageImage {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  invokeMock.mockReset();
});
afterEach(() => {
  cleanup();
});

describe("MessageImage 图片 chip", () => {
  it("chip 即时渲染文件名（挂载不读盘）；点击打开 lightbox 展示大图", async () => {
    invokeMock.mockResolvedValue(DATA_URL);
    renderImage();
    const chip = screen.getByRole("button", { name: /a\.png/ });
    expect(chip.textContent).toContain("a.png");
    // enabled=zoomed：挂载零读盘
    expect(invokeMock).not.toHaveBeenCalled();

    fireEvent.click(chip);
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "file:readMessageImage",
      "attachments/a.png",
    );
    const zoomed = await waitFor(() =>
      screen.getByRole("img", { name: "a.png" }),
    );
    expect(zoomed.getAttribute("src")).toBe(DATA_URL);
    expect(zoomed.className).toContain("max-h-[85vh]");
  });

  it("读盘失败 lightbox 内降级「已失效」提示（chip 仍显示）", async () => {
    invokeMock.mockResolvedValue(null);
    renderImage();
    const chip = screen.getByRole("button", { name: /a\.png/ });
    fireEvent.click(chip);
    await waitFor(() => {
      expect(screen.getByTestId("message-image-expired")).toBeTruthy();
    });
    // chip 未被占位条替换（参照形态：文件名标签恒在；Dialog 打开后
    // Radix 将外层内容移出可访问树，故用元素引用而非 getByRole 断言）
    expect(chip.isConnected).toBe(true);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("读盘中 lightbox 内 loading spinner（chip 不受影响）", async () => {
    invokeMock.mockReturnValue(new Promise(() => {}));
    renderImage();
    fireEvent.click(screen.getByRole("button", { name: /a\.png/ }));
    await waitFor(() => {
      expect(screen.getByTestId("message-image-loading")).toBeTruthy();
    });
  });

  it("lightbox 操作条另存为：invoke file:saveDataUrl（dataUrl + 文件名）", async () => {
    invokeMock.mockResolvedValue(DATA_URL);
    renderImage();
    fireEvent.click(screen.getByRole("button", { name: /a\.png/ }));
    await waitFor(() => {
      expect(screen.getByTestId("message-image-actions")).toBeTruthy();
    });
    fireEvent.click(
      screen.getByRole("button", { name: "chat:message.imageSaveAs" }),
    );
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "file:saveDataUrl",
        DATA_URL,
        "a.png",
      );
    });
  });
});

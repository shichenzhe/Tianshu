// @vitest-environment jsdom
/**
 * CodeBlock 单测：
 * - M9 性能回归：流式期间不触发 shiki 高亮——每 30ms flush 对整个代码块
 *   全量 codeToHtml 是 O(长度)×33 次/秒的浪费，旧任务不取消还并发堆积；
 *   流结束落库后走历史消息路径一次性高亮
 * - 工具条（聊天导出批）：复制/下载按钮渲染；复制走 useCopyText hook、
 *   下载走 Blob+<a> 纯渲染层（downloadBlob 共享件）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

const createHighlighter = vi.hoisted(() =>
  vi.fn(async () => ({
    codeToHtml: vi.fn(() => "<div data-testid='shiki-html'>hl</div>"),
    loadLanguage: vi.fn(async () => undefined),
  })),
);
vi.mock("shiki", () => ({
  createHighlighter,
  bundledLanguages: { ts: {} },
}));

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

const copyTextMock = vi.hoisted(() => vi.fn());
vi.mock("../../src-react/domains/ai/chat/hooks/use-copy-text", () => ({
  useCopyText: () => ({ copied: false, copyText: copyTextMock }),
}));

const downloadBlobMock = vi.hoisted(() => vi.fn());
vi.mock("../../src-react/lib/file-download", () => ({
  downloadBlob: downloadBlobMock,
}));

import CodeBlock from "../../src-react/domains/ai/chat/components/CodeBlock";

beforeEach(() => {
  createHighlighter.mockClear();
  copyTextMock.mockClear();
  downloadBlobMock.mockClear();
  cleanup();
});

describe("CodeBlock 流式降级（M9）", () => {
  it("streaming 时纯文本渲染且不初始化 shiki", async () => {
    const { container } = render(
      <CodeBlock code="const a = 1;" lang="ts" streaming />,
    );
    expect(container.querySelector("code")?.textContent).toBe("const a = 1;");
    // flush 微任务链后再断言（render 同步时 import("shiki") 尚未执行）
    await act(async () => {});
    expect(container.querySelector("[data-testid=shiki-html]")).toBeNull();
    expect(createHighlighter).not.toHaveBeenCalled();
  });

  it("非流式正常高亮（历史消息路径不受影响）", async () => {
    const { container } = render(<CodeBlock code="const a = 1;" lang="ts" />);
    // 断言高亮 DOM 效果而非 createHighlighter 调用数——模块级
    // highlighterPromise 缓存使第二次渲染复用实例，不再重复 create
    await vi.waitFor(() => {
      expect(
        container.querySelector("[data-testid=shiki-html]"),
      ).not.toBeNull();
    });
  });
});

describe("CodeBlock 工具条（聊天导出批）", () => {
  it("渲染语言标签与复制/下载按钮", () => {
    render(<CodeBlock code="const a = 1;" lang="ts" />);
    expect(screen.getByText("ts")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "chat:codeBlock.copy" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "chat:codeBlock.download" }),
    ).toBeTruthy();
  });

  it("复制点击走 useCopyText hook（携带整块源码）", () => {
    render(<CodeBlock code="const a = 1;" lang="ts" />);
    fireEvent.click(
      screen.getByRole("button", { name: "chat:codeBlock.copy" }),
    );
    expect(copyTextMock).toHaveBeenCalledWith("const a = 1;");
  });

  it("下载点击走 downloadBlob（文本 Blob + 语言扩展名）", () => {
    render(<CodeBlock code="const a = 1;" lang="ts" />);
    fireEvent.click(
      screen.getByRole("button", { name: "chat:codeBlock.download" }),
    );
    expect(downloadBlobMock).toHaveBeenCalledTimes(1);
    const [blob, name] = downloadBlobMock.mock.calls[0];
    expect(name).toBe("code.ts");
    expect(blob).toBeInstanceOf(Blob);
  });
});

// @vitest-environment jsdom
/**
 * MessageList 滚动跟随与回底按钮（jsdom 布局量 mock 驱动）：
 * - 底部附近：无回底按钮；流式新内容到达自动跟随（scrollIntoView）
 * - 上滑离底（scrollHeight-scrollTop-clientHeight > 80）：回底按钮浮现、
 *   流式新内容不再跟随
 * - 点击回底：恢复跟随并滚底、按钮隐藏
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.hoisted(() => {
  const memory = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => memory.set(key, value),
      removeItem: (key: string) => memory.delete(key),
      clear: () => memory.clear(),
    },
    configurable: true,
    writable: true,
  });
});

vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});
vi.mock("../../src-react/domains/ai/chat/components/MessageItem", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ message }: { message: { id: number } }) =>
      createElement("div", { "data-testid": `msg-${message.id}` }),
  };
});
vi.mock("../../src-react/domains/ai/chat/components/ApprovalBanner", () => ({
  default: () => null,
}));
// vi.fn 化（vi.hoisted）：哨兵用例断言「不发请求」（T26 文件窗占位会话）
const listMessagesMock = vi.hoisted(() =>
  vi.fn(() =>
    Promise.resolve({
      items: [
        { id: 1, sessionId: 7, role: "user", blocks: "", createdAt: "" },
        { id: 2, sessionId: 7, role: "assistant", blocks: "", createdAt: "" },
      ],
      hasMore: false,
      nextBeforeId: null,
    }),
  ),
);
vi.mock("../../src-react/domains/ai/api/session.api", () => ({
  SessionApi: { listMessages: listMessagesMock },
  default: { listMessages: listMessagesMock },
}));

import MessageList from "../../src-react/domains/ai/chat/components/MessageList";
import { useChatStore } from "../../src-react/domains/ai/chat/store/chat.store";

const scrollIntoView = vi.fn();
const rafCallbacks: Array<() => void> = [];

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  // jsdom 未实现 scrollIntoView/布局量：原型挂 mock，滚动量按用例覆写
  Element.prototype.scrollIntoView = scrollIntoView as unknown as () => void;
  scrollIntoView.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  rafCallbacks.length = 0;
  useChatStore.getState().finishStream(7);
});

function flushRaf(): void {
  const queue = rafCallbacks.splice(0);
  for (const cb of queue) cb();
}

/** 覆写滚动容器的布局量并派发 scroll（jsdom 无真实布局） */
function layoutScroll(el: Element, metrics: ScrollToOptions): void {
  Object.defineProperty(el, "scrollTop", {
    value: metrics.top ?? 0,
    configurable: true,
  });
  Object.defineProperty(el, "scrollHeight", {
    value: 1000,
    configurable: true,
  });
  Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
  fireEvent.scroll(el);
}

function renderList(): Element {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MessageList sessionId={7} />
    </QueryClientProvider>,
  );
  return screen.getByTestId("message-area");
}

/** 流式推进：store 置流式并追加 text（驱动跟随 effect） */
function pushStreamDelta(delta: string): void {
  act(() => {
    const store = useChatStore.getState();
    if (!useChatStore.getState().isStreaming[7]) {
      store.startStream(7);
    }
    store.appendDelta(7, "text", delta);
  });
}

describe("消息区滚动跟随", () => {
  it("底部附近无回底按钮；流式新内容到达自动滚底跟随", async () => {
    const area = renderList();
    await waitFor(() => {
      expect(screen.getByTestId("msg-2")).toBeTruthy();
    });
    // 初始 nearBottom（1000-600-400=0 < 80）
    layoutScroll(area, { top: 600 });
    expect(screen.queryByTestId("jump-bottom")).toBeNull();
    pushStreamDelta("新内容");
    await waitFor(flushRaf);
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("上滑离底：回底按钮浮现且流式不再跟随；点击回底恢复", async () => {
    const area = renderList();
    await waitFor(() => {
      expect(screen.getByTestId("msg-2")).toBeTruthy();
    });
    layoutScroll(area, { top: 0 }); // 1000-0-400=600 > 80 离底
    expect(screen.getByTestId("jump-bottom")).toBeTruthy();
    // 清掉挂载/历史到达阶段排队的 rAF 帧与调用记录（jsdom stub rAF 不自动执行）
    flushRaf();
    scrollIntoView.mockClear();
    pushStreamDelta("更多内容");
    await waitFor(flushRaf);
    expect(scrollIntoView).not.toHaveBeenCalled();
    // 点击回底：滚底 + 按钮隐藏 + 恢复跟随
    fireEvent.click(screen.getByTestId("jump-bottom"));
    flushRaf();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("jump-bottom")).toBeNull();
    pushStreamDelta("又一段");
    await waitFor(flushRaf);
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });
});

describe("哨兵会话（T26 文件窗占位 id<0）", () => {
  it("空消息区直接渲染：不发消息请求、无加载/失败文案", async () => {
    listMessagesMock.mockClear();
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MessageList sessionId={-1} />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("message-area")).toBeTruthy();
    expect(screen.queryByText("common:loading")).toBeNull();
    expect(screen.queryByText("common:failed")).toBeNull();
    expect(screen.queryByText("chat:noSession")).toBeNull();
    // 略等一拍确认查询未发出（enabled 守卫，非渲染层 no-op）
    await new Promise((r) => setTimeout(r, 20));
    expect(listMessagesMock).not.toHaveBeenCalled();
  });
});

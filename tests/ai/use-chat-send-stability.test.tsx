// @vitest-environment jsdom
/**
 * H4 性能回归：useChatSend 返回的 send/regenerate/editResend/stop 引用须
 * 在重渲染间保持稳定——下游 ChatPane 的 useCallback 回调以它们为依赖，
 * 引用每次变化会级联击穿 memo 的 MessageItem 列表（流式期间每个工具
 * 状态切换全列表重渲染，见性能审查报告 H4）
 * mock 骨架同 tests/layout/topbar.test.tsx：i18n 直返 key
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});
const onChatStreamMock = vi.hoisted(() =>
  vi.fn(() => () => {
    /* off 解绑 */
  }),
);
vi.mock("../../src-react/domains/ai/api/chat.api", () => ({
  default: {
    send: vi.fn(),
    regenerate: vi.fn(),
    editAndResend: vi.fn(),
    stop: vi.fn(),
    status: vi.fn(async () => ({ streaming: false })),
  },
  onChatStream: onChatStreamMock,
}));

import { useChatSend } from "../../src-react/domains/ai/chat/hooks/use-chat-send";

// client 须单例：wrapper 内每次 new 会让 queryClient 引用逐渲染变化，
// useCallback 依赖随之失效——这恰是本测试要防的引用不稳
const queryClient = new QueryClient();
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: queryClient }, children);

describe("useChatSend 引用稳定性（H4）", () => {
  beforeEach(() => {
    onChatStreamMock.mockClear();
  });

  it("重渲染不改变 send/regenerate/editResend/stop 引用", () => {
    const { result, rerender } = renderHook(() => useChatSend(1), {
      wrapper,
    });
    const before = result.current;
    rerender();
    rerender();
    expect(result.current.send).toBe(before.send);
    expect(result.current.regenerate).toBe(before.regenerate);
    expect(result.current.editResend).toBe(before.editResend);
    expect(result.current.stop).toBe(before.stop);
  });
});

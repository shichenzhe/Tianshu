// @vitest-environment jsdom
/**
 * P1 尾未读角标：ChatPane 已读推进挂载（历史就绪/轮次定稿两时机）。
 * 数据源 = ChatPane 内 messagesViewQuery 只读观察的 ["messages", id]
 * 分页缓存：预置缓存即「就绪」，effect 应取全页 maxMessageId 调
 * session:markRead；缓存增长（定稿拉回真值）应再次推进更大游标；
 * 哨兵会话（文件窗占位 id<0）与零消息会话不发请求。
 * ChatInput/MessageList 以 stub 替代（骨架参照 chat-pane-file-window-props）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  type InfiniteData,
} from "@tanstack/react-query";

vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
const stableT = (key: string) => key;
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({ t: stableT, i18n: { language: "zh-CN" } }),
  };
});

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", () => ({
  invoke: (channel: string, ...args: unknown[]) => invokeMock(channel, ...args),
  on: () => () => {},
  send: () => {},
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock("../../src-react/domains/ai/chat/components/ChatInput", () => ({
  default: () => null,
}));
vi.mock("../../src-react/domains/ai/chat/components/MessageList", () => ({
  default: () => null,
}));

import ChatPane from "../../src-react/domains/ai/chat/components/ChatPane";
import type { MessagePage } from "../../src-react/domains/ai/api/session.api";

const SESSION = {
  id: 7,
  workspaceId: 10,
  title: "角标会话",
  mode: "agent",
  createdAt: "",
  updatedAt: "",
} as Parameters<typeof ChatPane>[0]["session"];

/** 预置消息分页缓存（ChatPane 只读观察者消费同 key 真值） */
function seedMessages(queryClient: QueryClient, items: Array<{ id: number }>) {
  queryClient.setQueryData<InfiniteData<MessagePage>>(
    ["messages", SESSION.id],
    {
      pages: [
        {
          items: items.map((m) => ({
            sessionId: SESSION.id,
            role: "assistant" as const,
            blocks: "[]",
            createdAt: "",
            ...m,
          })),
          hasMore: false,
          nextBeforeId: null,
        },
      ],
      pageParams: [undefined],
    },
  );
}

function markReadCalls() {
  return invokeMock.mock.calls.filter(([ch]) => ch === "session:markRead");
}

describe("ChatPane 已读推进（P1 尾未读角标）", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    invokeMock.mockReset().mockImplementation((channel: string) => {
      switch (channel) {
        case "permission:get":
          return Promise.resolve("default");
        default:
          return Promise.resolve(undefined);
      }
    });
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });
  afterEach(() => {
    cleanup();
  });

  it("历史就绪：按全页 maxMessageId 调 session:markRead 并失效 sessions 刷新角标", async () => {
    seedMessages(queryClient, [{ id: 3 }, { id: 9 }, { id: 5 }]);
    render(
      <QueryClientProvider client={queryClient}>
        <ChatPane
          session={SESSION}
          workspace={{ id: 10 }}
          hasModel
          onOpenSettings={() => undefined}
        />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(markReadCalls()).toHaveLength(1));
    expect(markReadCalls()[0]).toEqual(["session:markRead", 7, 9]);
  });

  it("轮次定稿（缓存增长）：更大 maxMessageId 再次推进（不回退、去重）", async () => {
    seedMessages(queryClient, [{ id: 9 }]);
    render(
      <QueryClientProvider client={queryClient}>
        <ChatPane
          session={SESSION}
          workspace={{ id: 10 }}
          hasModel
          onOpenSettings={() => undefined}
        />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(markReadCalls()).toHaveLength(1));
    // 同游标重复就绪：不重复上报（ref 去重）
    act(() => seedMessages(queryClient, [{ id: 9 }]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(markReadCalls()).toHaveLength(1);
    // 定稿拉回真值：新 assistant 消息入缓存 → 游标推进到新 max
    act(() => seedMessages(queryClient, [{ id: 9 }, { id: 12 }]));
    await waitFor(() => expect(markReadCalls()).toHaveLength(2));
    expect(markReadCalls()[1]).toEqual(["session:markRead", 7, 12]);
  });

  it("零消息会话与哨兵会话（文件窗占位 id<0）不发 markRead", async () => {
    seedMessages(queryClient, []);
    const { unmount } = render(
      <QueryClientProvider client={queryClient}>
        <ChatPane
          session={SESSION}
          workspace={{ id: 10 }}
          hasModel
          onOpenSettings={() => undefined}
        />
      </QueryClientProvider>,
    );
    unmount();
    render(
      <QueryClientProvider client={queryClient}>
        <ChatPane
          session={{ ...SESSION, id: -1 }}
          workspace={{ id: 10 }}
          hasModel
          onOpenSettings={() => undefined}
        />
      </QueryClientProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(markReadCalls()).toHaveLength(0);
  });
});

// @vitest-environment jsdom
/**
 * 发送乐观更新测试：send() 在 chat:send IPC resolve 之前把用户消息写入
 * ["messages"] 缓存（修复：用户消息此前只在流结束 invalidate 后才显示，
 * 从发送到模型回复完之间 UI 完全缺失）。
 * - 乐观插入：负数临时 id + 文本块，先于任何后端返回
 * - finish 事件 → invalidate 重取 → 服务器真值替换乐观负 id
 * - chat:send 拒绝（早期失败）→ invalidate 恢复，乐观消息被清除
 * MessageList 不挂载，以同款 useInfiniteQuery 观察者复现缓存可见性
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
} from "@tanstack/react-query";
import { act } from "react";

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

// IPC mock：invoke 按通道分发（chat:send 可控挂起/拒绝）；
// on 捕获 chat:stream:{sessionId} 监听以便测试驱动 finish 事件
const invokeMock = vi.hoisted(() => vi.fn());
const streamEmit = vi.hoisted(() => {
  const listeners = new Map<number, (chunk: unknown) => void>();
  return { listeners };
});
vi.mock("@/lib/ipc", () => ({
  invoke: (channel: string, ...args: unknown[]) => invokeMock(channel, ...args),
  on: (channel: string, cb: (_e: unknown, chunk: unknown) => void) => {
    const m = /^chat:stream:(\d+)$/.exec(channel);
    if (m) {
      const sid = Number(m[1]);
      streamEmit.listeners.set(sid, (chunk) => cb(null, chunk));
    }
    return () => {
      if (m) streamEmit.listeners.delete(Number(m[1]));
    };
  },
  send: () => {},
}));

import { serializeBlocks } from "../../src-react/domains/ai/chat/model/blocks";
import type {
  MessagePage,
  MessageRecord,
} from "../../src-react/domains/ai/api/session.api";
import { useChatSend } from "../../src-react/domains/ai/chat/hooks/use-chat-send";

const SESSION_ID = 7;

function serverMessages(): MessageRecord[] {
  return [
    {
      id: 11,
      sessionId: SESSION_ID,
      role: "user",
      blocks: serializeBlocks([{ type: "text", text: "第一问" }]),
      createdAt: "2026-10-16T10:00:00.000Z",
    },
    {
      id: 12,
      sessionId: SESSION_ID,
      role: "assistant",
      blocks: serializeBlocks([{ type: "text", text: "第一答" }]),
      createdAt: "2026-10-16T10:00:01.000Z",
    },
    // 服务器在 chat:send 处理后已落库的用户消息（真值含正 id）
    {
      id: 13,
      sessionId: SESSION_ID,
      role: "user",
      blocks: serializeBlocks([{ type: "text", text: "第二问" }]),
      createdAt: "2026-10-16T10:00:02.000Z",
    },
  ];
}

/** infinite 缓存中全部消息（观察者页拍平） */
function cachedItems(client: QueryClient): MessageRecord[] {
  const data = client.getQueryData(["messages", SESSION_ID]) as unknown as
    { pages: MessagePage[] } | undefined;
  return (data?.pages ?? []).flatMap((p) => p.items);
}

/** 同款消息查询的活跃观察者：乐观 setQueryData / invalidate 的可见性前提 */
function MessagesObserver() {
  useInfiniteQuery({
    queryKey: ["messages", SESSION_ID],
    queryFn: ({ pageParam }) => invokeObserved(pageParam as number | undefined),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last: MessagePage) =>
      last.hasMore && last.nextBeforeId !== null
        ? last.nextBeforeId
        : undefined,
  });
  return null;
}

/** 观察者查询入口（与 useChatSend 无关，仅驱动缓存生命周期） */
function invokeObserved(beforeId?: number) {
  return Promise.resolve({
    items: beforeId === undefined ? serverMessages() : [],
    hasMore: false,
    nextBeforeId: null,
  } satisfies MessagePage);
}

/** 触发按钮组件：暴露 send 调用面 */
let sendFn: ((content: string) => Promise<void>) | null = null;
function SendHarness() {
  const { send } = useChatSend(SESSION_ID);
  sendFn = send;
  return null;
}

function setup(sendBehavior: () => Promise<void>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  invokeMock.mockImplementation((channel: string) => {
    if (channel === "message:listBySession") return invokeObserved();
    if (channel === "chat:send") return sendBehavior();
    if (channel === "chat:status") return Promise.resolve({ streaming: false });
    return Promise.resolve(undefined);
  });
  render(
    <QueryClientProvider client={client}>
      <MessagesObserver />
      <SendHarness />
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  cleanup();
  streamEmit.listeners.clear();
  invokeMock.mockReset();
  sendFn = null;
});

describe("发送乐观更新", () => {
  it("send 后 IPC 未返回时，用户消息已以负 id 写入缓存", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const client = setup(() => gate.then(() => {}));

    await waitFor(() => expect(cachedItems(client).length).toBe(3));
    // fire-and-forget：chat:send 挂起至 release，await 会死锁 act 环境
    act(() => {
      void sendFn?.("第二问").catch(() => {});
    });

    const items = cachedItems(client);
    const optimistic = items.find((m) => m.id < 0);
    expect(optimistic).toBeDefined();
    expect(optimistic?.role).toBe("user");
    expect(optimistic?.sessionId).toBe(SESSION_ID);
    expect(optimistic?.blocks).toBe(
      serializeBlocks([{ type: "text", text: "第二问" }]),
    );
    // chat:send 仍挂起（乐观先于任何后端返回）
    expect(
      invokeMock.mock.calls.filter((c) => c[0] === "chat:send"),
    ).toHaveLength(1);
    release();
  });

  it("finish 事件后 invalidate 重取：乐观负 id 被服务器真值替换", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const client = setup(() => gate.then(() => {}));

    await waitFor(() => expect(cachedItems(client).length).toBe(3));
    act(() => {
      void sendFn?.("第二问").catch(() => {});
    });
    expect(cachedItems(client).some((m) => m.id < 0)).toBe(true);

    release();
    act(() => {
      streamEmit.listeners.get(SESSION_ID)?.({ type: "finish" });
    });
    await waitFor(() => {
      const items = cachedItems(client);
      expect(items.some((m) => m.id < 0)).toBe(false);
      // 服务器真值（含 id:13 的用户消息）已替换乐观占位
      expect(items.some((m) => m.id === 13 && m.role === "user")).toBe(true);
    });
  });

  it("chat:send 拒绝（早期失败）→ invalidate 恢复，乐观消息清除", async () => {
    const client = setup(() => Promise.reject(new Error("SESSION_NOT_FOUND")));

    await waitFor(() => expect(cachedItems(client).length).toBe(3));
    act(() => {
      void sendFn?.("第二问").catch(() => {});
    });

    await waitFor(() => {
      expect(cachedItems(client).some((m) => m.id < 0)).toBe(false);
    });
  });
});

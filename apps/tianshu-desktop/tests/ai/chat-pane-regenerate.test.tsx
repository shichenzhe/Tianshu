// @vitest-environment jsdom
/**
 * ChatPane 重新生成乐观截断（历史消息立即消失）：
 * - 点击：目标 assistant 消息及其后立即从缓存消失（先于后端返回），
 *   chat:regenerate 走 (sessionId, messageId)
 * - 失败：toast 恰一次 + invalidate 重取恢复服务器真值
 * MessageList 以捕获 props 的 stub 替代（骨架同 chat-view-edit-optimistic），
 * 消息查询由同款 useInfiniteQuery 观察者复现——乐观 setQueryData 的可见性
 * 依赖该活跃观察者
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
} from "@tanstack/react-query";

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
// t/i18n 须模块级稳定引用：use-chat-send 的流订阅 effect 以 t 为依赖，
// 每渲染新引用会致其卸载重挂、卸载清理误清流态（生产 t 稳定无此问题）
const stableT = (key: string) => key;
const stableI18n = { language: "zh-CN" };
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({ t: stableT, i18n: stableI18n }),
  };
});

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", () => ({
  invoke: (channel: string, ...args: unknown[]) => invokeMock(channel, ...args),
  on: () => () => {},
  send: () => {},
}));

const toastMock = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

interface CapturedListProps {
  onRegenerate?: (messageId?: number) => void | Promise<void>;
}
const listProps = vi.hoisted(() => ({
  current: null as CapturedListProps | null,
}));
vi.mock("../../src-react/domains/ai/chat/components/MessageList", async () => {
  const { createElement } = await import("react");
  return {
    default: (props: CapturedListProps) => {
      listProps.current = props;
      if (typeof props.onRegenerate !== "function") {
        return createElement("div", null);
      }
      return createElement("div", {
        "data-testid": "regen-trigger",
        onClick: () => void props.onRegenerate!(2),
      });
    },
  };
});
vi.mock("../../src-react/domains/ai/chat/components/ChatInput", () => ({
  default: () => null,
}));

import ChatPane from "../../src-react/domains/ai/chat/components/ChatPane";
import type { MessageRecord } from "../../src-react/domains/ai/api/session.api";
import { SessionApi } from "../../src-react/domains/ai/api/session.api";

const SESSION_ID = 1;
const MESSAGES_KEY = ["messages", SESSION_ID];

const SESSION = {
  id: SESSION_ID,
  workspaceId: 10,
  title: "截断会话",
  mode: "agent",
  createdAt: "",
  updatedAt: "",
} as Parameters<typeof ChatPane>[0]["session"];

/** 服务器侧消息（每次调用产出新副本，模拟重取拿到的独立真值） */
function serverMessages(): MessageRecord[] {
  return [
    { id: 1, sessionId: 1, role: "user", blocks: "u1", createdAt: "" },
    { id: 2, sessionId: 1, role: "assistant", blocks: "a1", createdAt: "" },
    { id: 3, sessionId: 1, role: "user", blocks: "u2", createdAt: "" },
    { id: 4, sessionId: 1, role: "assistant", blocks: "a2", createdAt: "" },
  ] as MessageRecord[];
}

/** 与生产 MessageList 同款的消息查询观察者（stub 后由其承接缓存订阅） */
function MessagesObserver() {
  useInfiniteQuery({
    queryKey: MESSAGES_KEY,
    queryFn: ({ pageParam }) =>
      SessionApi.listMessages(SESSION_ID, pageParam as number | undefined),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) =>
      last.hasMore && last.nextBeforeId !== null
        ? last.nextBeforeId
        : undefined,
  });
  return null;
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((channel: string) => {
    switch (channel) {
      case "chat:status":
        return Promise.resolve({
          streaming: false,
          accessMode: "default",
          text: "",
          thinking: "",
          tools: { order: [], map: {} },
        });
      case "permission:get":
        return Promise.resolve("default");
      case "message:listBySession":
        return Promise.resolve({
          items: serverMessages(),
          hasMore: false,
          nextBeforeId: null,
        });
      case "chat:regenerate":
        // 流式长跑：不结算
        return new Promise(() => {});
      default:
        return Promise.resolve(undefined);
    }
  });
  toastMock.error.mockClear();
});
afterEach(cleanup);

function renderPane(queryClient: QueryClient): void {
  render(
    <QueryClientProvider client={queryClient}>
      <MessagesObserver />
      <ChatPane
        session={SESSION}
        workspace={{ id: 10 }}
        hasModel
        onOpenSettings={() => undefined}
      />
    </QueryClientProvider>,
  );
}

/** 缓存中的消息 id 序列（跨页展平） */
function cachedIds(queryClient: QueryClient): number[] {
  const data = queryClient.getQueryData(MESSAGES_KEY) as {
    pages: Array<{ items: MessageRecord[] }>;
  };
  return (data?.pages ?? []).flatMap((page) => page.items.map((m) => m.id));
}

describe("重新生成乐观截断", () => {
  it("点击后目标消息及其后立即从缓存消失（先于后端返回）", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    renderPane(queryClient);
    await waitFor(() => {
      expect(cachedIds(queryClient)).toEqual([1, 2, 3, 4]);
    });
    fireEvent.click(document.querySelector('[data-testid="regen-trigger"]')!);
    // regenerate invoke 挂起（流式长跑）——截断为纯前端乐观行为
    expect(cachedIds(queryClient)).toEqual([1]);
    expect(invokeMock).toHaveBeenCalledWith("chat:regenerate", 1, 2);
  });

  it("失败：toast 恰一次 + invalidate 恢复服务器真值", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    renderPane(queryClient);
    await waitFor(() => {
      expect(cachedIds(queryClient)).toEqual([1, 2, 3, 4]);
    });
    invokeMock.mockImplementation((channel: string) => {
      if (channel === "chat:regenerate") {
        return Promise.reject(new Error("CONCURRENT_REQUEST"));
      }
      if (channel === "chat:status") {
        return Promise.resolve({
          streaming: false,
          accessMode: "default",
          text: "",
          thinking: "",
          tools: { order: [], map: {} },
        });
      }
      if (channel === "message:listBySession") {
        return Promise.resolve({
          items: serverMessages(),
          hasMore: false,
          nextBeforeId: null,
        });
      }
      return Promise.resolve(undefined);
    });
    fireEvent.click(document.querySelector('[data-testid="regen-trigger"]')!);
    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(cachedIds(queryClient)).toEqual([1, 2, 3, 4]);
    });
  });
});

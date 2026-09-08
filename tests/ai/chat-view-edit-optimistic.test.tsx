// @vitest-environment jsdom
/**
 * ChatView 编辑重发乐观更新接线测试（jsdom + testing-library）：
 * - 提交：退出编辑态 → 缓存立即截尾 + 目标消息换新文本（先于后端返回）→
 *   editResend 走 chat:editAndResend(sessionId, messageId, content)
 * - 失败：toast 兜底恰一次（不双弹）+ invalidate 重取恢复服务器真值
 * MessageList 以捕获 props 的 stub 替代（避免挂全量 markdown 渲染管道），
 * 其消息查询（["messages", sessionId]）由同款 useQuery 观察者复现——乐观
 * setQueryData 与失败 invalidate 的可见性依赖该活跃观察者
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// localStorage stub：ChatView 引入链上的 ai-ui/theme store 在模块加载期
// 即读写 localStorage，Node 26 无 --localstorage-file 时访问原生全局会向
// stderr 打 ExperimentalWarning——先行替换为内存 stub 消除噪音
vi.hoisted(() => {
  const memory = new Map<string, string>();
  const stub = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => memory.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: stub,
    configurable: true,
    writable: true,
  });
});

import type { MessageRecord } from "../../src-react/domains/ai/api/session.api";
import { SessionApi } from "../../src-react/domains/ai/api/session.api";
import {
  parseBlocks,
  serializeBlocks,
} from "../../src-react/domains/ai/chat/model/blocks";

// i18n mock：与 message-item-edit.test.tsx 同套——t 直接返回 key；@/i18n
// 以最小 stub 替代真实初始化（mapIpcError 与 LanguageDetector 均依赖它）
vi.mock("@/i18n", () => ({
  default: { t: (key: string) => key },
}));
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

// IPC mock：invoke 按 channel 分发假数据（query/编辑重发全走此口）；
// on（流订阅）返回空卸载函数，隔离真实流事件
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", () => ({
  invoke: (channel: string, ...args: unknown[]) => invokeMock(channel, ...args),
  on: () => () => {},
  send: () => {},
}));

// toast mock：断言失败兜底恰一次（不双弹）
const toastMock = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

// MessageList stub：捕获 ChatPane 透传的编辑相关 props，并以两个按钮
// 触发 onEdit/onEditSubmit（fireEvent 自带 act 包裹，避免裸调用告警）。
// 无会话兜底实例（sessionId=null、无编辑回调）不渲染按钮——findByTestId
// 因此只会命中 ChatPane 内的实例，避免点击到先渲染的兜底实例
interface CapturedListProps {
  sessionId: number | null;
  editing: { messageId: number; text: string } | null;
  onEdit: (messageId: number) => void;
  onEditSubmit: (text: string) => void;
}
const listProps = vi.hoisted(() => ({
  current: null as CapturedListProps | null,
}));
vi.mock("../../src-react/domains/ai/chat/components/MessageList", async () => {
  const { createElement } = await import("react");
  return {
    default: (props: CapturedListProps) => {
      listProps.current = props;
      if (typeof props.onEdit !== "function") {
        return createElement("div", null);
      }
      return createElement(
        "div",
        null,
        createElement("button", {
          "data-testid": "enter-edit",
          onClick: () => props.onEdit(3),
        }),
        createElement("button", {
          "data-testid": "submit-edit",
          onClick: () => props.onEditSubmit("改后的第二问"),
        }),
      );
    },
  };
});
vi.mock("../../src-react/domains/ai/chat/components/ChatInput", () => ({
  default: () => null,
}));

import ChatView from "../../src-react/domains/ai/chat/views/ChatView";

const SESSION_ID = 1;
const MESSAGES_KEY = ["messages", SESSION_ID];

/** 服务器侧消息（每次调用产出新副本，模拟重取拿到的独立真值） */
function serverMessages(): MessageRecord[] {
  return [
    {
      id: 1,
      sessionId: 1,
      role: "user",
      blocks: serializeBlocks([{ type: "text", text: "第一问" }]),
      createdAt: "2026-09-08T10:00:00.000Z",
    },
    {
      id: 2,
      sessionId: 1,
      role: "assistant",
      blocks: serializeBlocks([{ type: "text", text: "第一答" }]),
      createdAt: "2026-09-08T10:00:01.000Z",
    },
    {
      id: 3,
      sessionId: 1,
      role: "user",
      blocks: serializeBlocks([{ type: "text", text: "待编辑的第二问" }]),
      createdAt: "2026-09-08T10:00:02.000Z",
    },
    {
      id: 4,
      sessionId: 1,
      role: "assistant",
      blocks: serializeBlocks([{ type: "text", text: "待删除的第二答" }]),
      createdAt: "2026-09-08T10:00:03.000Z",
    },
  ];
}

/** invoke 默认分发：编辑重发返回不结算的 Promise（模拟流式长跑未结束） */
function defaultInvoke(channel: string): Promise<unknown> {
  switch (channel) {
    case "session:listAll":
      return Promise.resolve([
        {
          id: SESSION_ID,
          workspaceId: 10,
          title: "任务一",
          mode: "agent",
          createdAt: "2026-09-08T09:00:00.000Z",
          updatedAt: "2026-09-08T09:00:00.000Z",
        },
      ]);
    case "workspace:list":
      return Promise.resolve([
        {
          id: 10,
          name: "默认空间",
          createdAt: "2026-09-08T09:00:00.000Z",
          updatedAt: "2026-09-08T09:00:00.000Z",
        },
      ]);
    case "provider:list":
      // 非空避免落入服务商引导页（needsSetup 要求 provider/model 双空）
      return Promise.resolve([
        {
          id: 1,
          name: "demo",
          createdAt: "2026-09-08T09:00:00.000Z",
          updatedAt: "2026-09-08T09:00:00.000Z",
        },
      ]);
    case "model:listAll":
      return Promise.resolve([]);
    case "message:listBySession":
      return Promise.resolve(serverMessages());
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
    case "chat:editAndResend":
      return new Promise(() => {});
    default:
      return Promise.resolve(undefined);
  }
}

/** 与生产 MessageList 同款的消息查询观察者（stub 后由其承接缓存订阅） */
function MessagesObserver() {
  useQuery({
    queryKey: MESSAGES_KEY,
    queryFn: () => SessionApi.listMessages(SESSION_ID),
  });
  return null;
}

function cachedIds(client: QueryClient): number[] {
  return (
    client.getQueryData<MessageRecord[]>(MESSAGES_KEY)?.map((m) => m.id) ?? []
  );
}

beforeEach(() => {
  invokeMock.mockImplementation((channel: string) => defaultInvoke(channel));
});

// vitest 未开 globals，RTL 自动清理不生效，显式清理
afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  toastMock.error.mockClear();
});

describe("ChatView 编辑重发乐观更新", () => {
  it("提交：缓存立即截尾并改写目标消息，再走 editResend", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/?session=1"]}>
          <MessagesObserver />
          <ChatView />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByTestId("enter-edit");
    // 进入编辑前先等消息缓存就绪（handleEdit 从缓存回填原文）
    await waitFor(() =>
      expect(queryClient.getQueryData(MESSAGES_KEY)).toHaveLength(4),
    );
    fireEvent.click(screen.getByTestId("enter-edit"));
    await waitFor(() =>
      expect(listProps.current?.editing).toEqual({
        messageId: 3,
        text: "待编辑的第二问",
      }),
    );
    fireEvent.click(screen.getByTestId("submit-edit"));
    // 乐观更新即时生效（后端 editAndResend 未返回：目标换新文本、尾部消失）
    const cached = queryClient.getQueryData<MessageRecord[]>(MESSAGES_KEY);
    expect(cached?.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(parseBlocks(cached?.[2].blocks ?? "[]")).toEqual([
      { type: "text", text: "改后的第二问" },
    ]);
    // 调用参数与顺序：chat:editAndResend(sessionId, messageId, content)
    expect(invokeMock).toHaveBeenCalledWith(
      "chat:editAndResend",
      1,
      3,
      "改后的第二问",
    );
    // 退出编辑态；流未结束不走错误兜底
    await waitFor(() => expect(listProps.current?.editing).toBeNull());
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("提交失败：toast 兜底恰一次，invalidate 重取恢复服务器真值", async () => {
    invokeMock.mockImplementation((channel: string) =>
      channel === "chat:editAndResend"
        ? Promise.reject(new Error("Upstream boom"))
        : defaultInvoke(channel),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/?session=1"]}>
          <MessagesObserver />
          <ChatView />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByTestId("enter-edit");
    await waitFor(() =>
      expect(queryClient.getQueryData(MESSAGES_KEY)).toHaveLength(4),
    );
    fireEvent.click(screen.getByTestId("enter-edit"));
    await waitFor(() => expect(listProps.current?.editing).toBeTruthy());
    fireEvent.click(screen.getByTestId("submit-edit"));
    // 失败收尾：catch invalidate → 观察者重取 → 恢复全量真值（含原文本）
    await waitFor(() => expect(cachedIds(queryClient)).toEqual([1, 2, 3, 4]));
    const restored = queryClient.getQueryData<MessageRecord[]>(MESSAGES_KEY);
    expect(parseBlocks(restored?.[2].blocks ?? "[]")).toEqual([
      { type: "text", text: "待编辑的第二问" },
    ]);
    // toast 兜底恰一次（仅 handleEditSubmit catch，不双弹）；非白名单消息原样透传
    expect(toastMock.error).toHaveBeenCalledTimes(1);
    expect(toastMock.error).toHaveBeenCalledWith("Upstream boom");
  });
});

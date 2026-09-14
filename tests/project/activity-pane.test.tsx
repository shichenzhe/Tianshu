// @vitest-environment jsdom
/**
 * ActivityPane 消息编辑接线测试（jsdom + testing-library；mock 骨架同
 * tests/ai/chat-view-edit-optimistic.test.tsx + tests/project/
 * project-chat-bar.test.tsx，t 直接返回 key）：
 * - 编辑重发：onEdit(id) 自消息缓存回填原文 → onEditSubmit(新文本) 乐观
 *   截尾缓存 + editAndResend(sessionId, id, 新文本)（ChatApi 层断言，
 *   语义镜像 use-chat-send 的 editResend 内联组合）+ startStream 标记；
 *   失败 → finishStream 收尾 + invalidate 恢复真值 + toast 兜底
 * - 重新生成：onRegenerate(id) → regenerate(sessionId, id)
 * - 发送版本信号：底栏成功发送（store bumpSendVersion +1）→ 本面板编辑态
 *   立即丢弃（跨组件版 ChatPane handleSend setEditing 防呆——防止随后
 *   提交的过期编辑经 editAndResend 截断刚发的消息）；版本 0（初始挂载/
 *   尚无成功发送）不清
 * ChatMessages 以捕获 props 的 stub 替代，chat.store 用真实实现
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
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// localStorage stub：模块加载链上的 store 在 Node 环境访问原生全局会打
// ExperimentalWarning，先行替换为内存 stub 消除噪音
vi.hoisted(() => {
  const memory = new Map<string, string>();
  const stub = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
    clear: () => memory.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: stub,
    configurable: true,
    writable: true,
  });
});

// i18n mock：t 直接返回 key；@/i18n 以最小 stub 替代（mapIpcError 依赖它）
vi.mock("@/i18n", () => ({
  default: { t: (key: string) => key },
}));
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  const t = (key: string) => key;
  return { ...actual, useTranslation: () => ({ t }) };
});

const toastMock = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

// ChatApi mock：编辑重发/重新生成全量替身（乐观更新在渲染层，仅断言
// ChatApi 层收到的参数）
const chatApiMock = vi.hoisted(() => ({
  editAndResend: vi.fn(),
  regenerate: vi.fn(),
}));
vi.mock("@/domains/ai/api/chat.api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/domains/ai/api/chat.api")>();
  return {
    ...actual,
    default: chatApiMock,
    onChatStream: () => () => {},
  };
});

// 能力数据源 mock：非空 → needsChatSetup 判否，走 ChatMessages 分支
vi.mock("../../src-react/domains/ai/api/provider.api", () => ({
  ProviderApi: { list: () => Promise.resolve([{ id: 1 }]) },
}));
vi.mock("../../src-react/domains/ai/api/model.api", () => ({
  ModelApi: { listAll: () => Promise.resolve([{ id: 1 }]) },
}));

// ChatMessages stub：捕获 ActivityPane 透传的编辑相关 props，附按钮触发
// onEdit(2)/onEditSubmit/onRegenerate(3)
interface CapturedMessagesProps {
  session: { id: number };
  editing: { messageId: number; text: string } | null;
  onEdit: (messageId: number) => void;
  onEditSubmit: (text: string) => void | Promise<void>;
  onEditCancel: () => void;
  onRegenerate: (messageId?: number) => void | Promise<void>;
}
const messagesProps = vi.hoisted(() => ({
  current: null as CapturedMessagesProps | null,
}));
vi.mock("../../src-react/domains/ai/chat/components/ChatMessages", async () => {
  const { createElement } = await import("react");
  return {
    default: (props: CapturedMessagesProps) => {
      messagesProps.current = props;
      return createElement(
        "div",
        { "data-testid": "chat-messages-stub" },
        createElement("button", {
          "data-testid": "enter-edit",
          onClick: () => props.onEdit(2),
        }),
        createElement("button", {
          "data-testid": "submit-edit",
          onClick: () => void props.onEditSubmit("改后的第二问"),
        }),
        createElement("button", {
          "data-testid": "regenerate",
          onClick: () => void props.onRegenerate(3),
        }),
      );
    },
  };
});

import ActivityPane from "../../src-react/domains/project/components/ActivityPane";
import { useChatStore } from "../../src-react/domains/ai/chat/store/chat.store";
import type { MessageRecord } from "../../src-react/domains/ai/api/session.api";
import {
  parseBlocks,
  serializeBlocks,
} from "../../src-react/domains/ai/chat/model/blocks";
import type { ProjectDetail } from "../../../electron/domains/project/project.entity";

const SESSION_ID = 11;
const MESSAGES_KEY = ["messages", SESSION_ID];

const DETAIL: ProjectDetail = {
  project: {
    id: 1,
    name: "alpha",
    systemPrompt: null,
    templateKey: null,
    ownerId: 1,
    sessionId: SESSION_ID,
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
  },
  assetWorkspaceId: 30,
  bindings: [],
  session: {
    id: SESSION_ID,
    workspaceId: 30,
    title: "alpha",
    mode: "agent",
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
  },
};

/** 服务器侧消息（id 2 为待编辑 user 消息，id 3 为其后 assistant 回复） */
function serverMessages(): MessageRecord[] {
  return [
    {
      id: 1,
      sessionId: SESSION_ID,
      role: "user",
      blocks: serializeBlocks([{ type: "text", text: "第一问" }]),
      createdAt: "2026-09-12T10:00:00.000Z",
    },
    {
      id: 2,
      sessionId: SESSION_ID,
      role: "user",
      blocks: serializeBlocks([{ type: "text", text: "第二问原文" }]),
      createdAt: "2026-09-12T10:01:00.000Z",
    },
    {
      id: 3,
      sessionId: SESSION_ID,
      role: "assistant",
      blocks: serializeBlocks([{ type: "text", text: "第二答" }]),
      createdAt: "2026-09-12T10:02:00.000Z",
    },
  ];
}

/** 消息观察者：复现真实 MessageList 的 ["messages", sessionId] useQuery
 * 观察者（失败路径 invalidate 重取恢复真值的可见性依赖该活跃观察者，
 * 同 tests/ai/chat-view-edit-optimistic.test.tsx） */
function MessageObserver() {
  useQuery({
    queryKey: MESSAGES_KEY,
    queryFn: () => Promise.resolve(serverMessages()),
  });
  return null;
}

/** 渲染面板并预置消息缓存（handleEdit 回填与乐观截尾均读写该缓存） */
function renderPane() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(MESSAGES_KEY, serverMessages());
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ActivityPane detail={DETAIL} />
        <MessageObserver />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return queryClient;
}

beforeEach(() => {
  chatApiMock.editAndResend.mockReset().mockResolvedValue(undefined);
  chatApiMock.regenerate.mockReset().mockResolvedValue(undefined);
  messagesProps.current = null;
  toastMock.error.mockClear();
  // 发送版本为持久计数（不随流结束清除），跨用例重置防串扰
  useChatStore.setState({ sendVersions: {} });
});

// vitest 未开 globals，RTL 自动清理不生效，显式清理；流式标记防跨用例泄漏
afterEach(() => {
  cleanup();
  useChatStore.getState().finishStream(SESSION_ID);
});

describe("ActivityPane 消息编辑接线", () => {
  it("onEdit(2) 自缓存回填原文 → onEditSubmit 乐观截尾缓存 + editAndResend(sessionId, 2, 新文本)", async () => {
    const queryClient = renderPane();
    expect(await screen.findByTestId("chat-messages-stub")).toBeTruthy();

    // 进入编辑：text 为目标 user 消息的 text 块拼接（与渲染同口径）
    fireEvent.click(screen.getByTestId("enter-edit"));
    expect(messagesProps.current?.editing).toEqual({
      messageId: 2,
      text: "第二问原文",
    });

    // 提交：乐观退出编辑态 + 缓存立即截尾（目标消息换新文本、其后截掉）
    fireEvent.click(screen.getByTestId("submit-edit"));
    await waitFor(() =>
      expect(chatApiMock.editAndResend).toHaveBeenCalledWith(
        SESSION_ID,
        2,
        "改后的第二问",
      ),
    );
    expect(messagesProps.current?.editing).toBeNull();
    const optimistic = queryClient.getQueryData<MessageRecord[]>(MESSAGES_KEY);
    expect(optimistic?.map((message) => message.id)).toEqual([1, 2]);
    expect(parseBlocks(optimistic?.[1]?.blocks ?? "")).toEqual([
      { type: "text", text: "改后的第二问" },
    ]);
    // 流式标记先行（语义同 use-chat-send editResend 的 startStream）
    expect(useChatStore.getState().isStreaming[SESSION_ID]).toBe(true);
  });

  it("editAndResend 失败 → finishStream 收尾 + invalidate 恢复服务器真值 + toast 兜底", async () => {
    const queryClient = renderPane();
    await screen.findByTestId("chat-messages-stub");
    chatApiMock.editAndResend.mockRejectedValueOnce(new Error("boom"));

    fireEvent.click(screen.getByTestId("enter-edit"));
    fireEvent.click(screen.getByTestId("submit-edit"));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1));

    expect(useChatStore.getState().isStreaming[SESSION_ID]).toBeUndefined();
    // invalidate 已重取回服务器真值（三消息齐全、原文未变）
    await waitFor(() => {
      const restored =
        queryClient.getQueryData<MessageRecord[]>(MESSAGES_KEY) ?? [];
      expect(restored.map((message) => message.id)).toEqual([1, 2, 3]);
      expect(parseBlocks(restored[1]?.blocks ?? "")).toEqual([
        { type: "text", text: "第二问原文" },
      ]);
    });
  });

  it("onRegenerate(3) → ChatApi.regenerate(sessionId, 3)", async () => {
    renderPane();
    await screen.findByTestId("chat-messages-stub");

    fireEvent.click(screen.getByTestId("regenerate"));
    await waitFor(() =>
      expect(chatApiMock.regenerate).toHaveBeenCalledWith(SESSION_ID, 3),
    );
    expect(useChatStore.getState().isStreaming[SESSION_ID]).toBe(true);
  });
});

describe("ActivityPane 发送版本信号（底栏成功发送 → 编辑态过期丢弃）", () => {
  it("编辑中 bumpSendVersion +1 → editing 立即清空（EditBar 关闭）", async () => {
    renderPane();
    await screen.findByTestId("chat-messages-stub");
    fireEvent.click(screen.getByTestId("enter-edit"));
    expect(messagesProps.current?.editing).not.toBeNull();

    // 底栏成功发送（ProjectChatBar handleSend 成功路径）广播版本 +1
    act(() => {
      useChatStore.getState().bumpSendVersion(SESSION_ID);
    });
    expect(messagesProps.current?.editing).toBeNull();
  });

  it("版本 0（初始挂载、尚无成功发送）→ 编辑态保留不误清", async () => {
    renderPane();
    await screen.findByTestId("chat-messages-stub");
    fireEvent.click(screen.getByTestId("enter-edit"));

    expect(useChatStore.getState().sendVersions[SESSION_ID] ?? 0).toBe(0);
    expect(messagesProps.current?.editing).toEqual({
      messageId: 2,
      text: "第二问原文",
    });
  });
});

// @vitest-environment jsdom
/**
 * 真实流式链路（不 mock useChatSend/use-file-session，T26 重写）：面板
 * 恒嵌 ChatPane 后惰建-订阅链归 ChatPane——占位 ChatPane（哨兵 -1）首条
 * 经 sessionResolver（use-file-session prepareFirstSend）惰建 + 直发
 * chat:send（绕开 useChatSend.send 的旧 id 闭包）→ onSessionResolved 落
 * tab → 面板层换真记录重挂（key=真 id）→ 订阅换绑到新 sessionId →
 * delta 入 chat.store → finish 清流。哨兵期不得订阅/查状态/拉消息
 * （use-chat-send 与 MessageList 的哨兵守卫）。这是「惰建→发送→流式
 * 渲染」验收核心（spec §6.2 + §15 项 1）；附修复轮 1 Critical 1 端到端：
 * send 失败的空会话（标记随建即写）关 tab 判空回收 session:delete。
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

const invokeMock = vi.hoisted(() => vi.fn());
const listeners = vi.hoisted(
  () => new Map<string, (e: unknown, p: unknown) => void>(),
);
vi.mock("../../../src-react/lib/ipc", () => ({
  invoke: invokeMock,
  on: (ch: string, cb: (e: unknown, p: unknown) => void) => {
    listeners.set(ch, cb);
    return () => listeners.delete(ch);
  },
}));

// ChatInput 以捕获 onSend 的桩替代（发送动作由测试直接驱动）
const inputProps = vi.hoisted(() => ({
  current: null as {
    onSend: (
      content: string,
      files: Array<{ path: string; content: string; image?: true }>,
    ) => Promise<void>;
  } | null,
}));
vi.mock("../../../src-react/domains/ai/chat/components/ChatInput", async () => {
  const { createElement: ce } = await import("react");
  return {
    default: (props: {
      onSend: (content: string, files: unknown[]) => Promise<void>;
    }) => {
      inputProps.current = props as never;
      return ce("div");
    },
  };
});
vi.mock("../../../src-react/domains/ai/chat/components/MessageList", () => ({
  default: () => null,
}));

import "../../../src-react/i18n";
import { useFileWindowStore } from "../../../src-react/domains/ai/file-window/store/file-window.store";
import { useFileSession } from "../../../src-react/domains/ai/file-window/hooks/use-file-session";
import ChatPane from "../../../src-react/domains/ai/chat/components/ChatPane";
import type { SessionRecord } from "../../../src-react/domains/ai/api/session.api";
import { useChatStore } from "../../../src-react/domains/ai/chat/store/chat.store";

const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

/** 面板等价物：占位/真会话二态渲染 ChatPane（key=会话 id，FileChatPanel
 *  同款换挂语义），resolver 接 use-file-session prepareFirstSend */
function Harness({ tabId }: { tabId: string }) {
  const { prepareFirstSend } = useFileSession(tabId);
  // 模拟 sessionQuery：真会话记录就位后换渲染（key 重建 ChatPane）
  const [session, setSession] = useState<SessionRecord>({
    id: -1,
    workspaceId: 7,
    title: "",
    mode: "agent",
    createdAt: "",
    updatedAt: "",
  });
  return (
    <ChatPane
      key={session.id}
      session={session}
      workspace={{ id: 7 }}
      hasModel
      onOpenSettings={() => undefined}
      sessionResolver={prepareFirstSend}
      onSessionResolved={(s) => {
        useFileWindowStore
          .getState()
          .patchTab(tabId, { sessionId: s.id, sessionCreatedHere: true });
        // 面板 getById 就位语义：真记录落位（stub 形状即可，id 权威）
        setSession(s);
      }}
    />
  );
}

beforeEach(() => {
  useFileWindowStore.getState().reset();
  useChatStore.setState({ streams: {}, isStreaming: {} });
  listeners.clear();
  inputProps.current = null;
  invokeMock.mockReset().mockImplementation((ch: string) => {
    if (ch === "session:create") return { id: 99, workspaceId: 7 };
    if (ch === "chat:status")
      return {
        streaming: false,
        accessMode: "default",
        text: "",
        thinking: "",
        tools: { order: [], map: {} },
      };
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  client.clear();
  useChatStore.setState({ streams: {}, isStreaming: {} });
});

it("占位 ChatPane 首条直发 → 真会话换 key 重挂 → 订阅换绑 → delta 入 store → finish 清流", async () => {
  const { tabId } = useFileWindowStore
    .getState()
    .openTab({ kind: "workspace", workspaceId: 7, path: "docs/a.md" });
  render(
    <QueryClientProvider client={client}>
      <Harness tabId={tabId} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(inputProps.current?.onSend).toBeTruthy());
  // 哨兵期（-1）：不订阅不查状态不拉消息（use-chat-send/MessageList 守卫）
  expect(listeners.has("chat:stream:-1")).toBe(false);
  expect(invokeMock.mock.calls.some((c) => c[0] === "chat:status")).toBe(false);
  expect(
    invokeMock.mock.calls.some((c) => c[0] === "message:listBySession"),
  ).toBe(false);

  await act(async () => {
    await inputProps.current!.onSend("总结一下", []);
  });
  await waitFor(() =>
    expect(useFileWindowStore.getState().tabs[0].sessionId).toBe(99),
  );
  expect(useFileWindowStore.getState().tabs[0].sessionCreatedHere).toBe(true);
  // 直发：真实 ChatApi.send → invoke chat:send（携带注入前缀 + 真 id）
  const sendCall = invokeMock.mock.calls.find((c) => c[0] === "chat:send");
  expect(sendCall?.[1]).toMatchObject({ sessionId: 99 });
  expect(sendCall?.[1].content).toContain("总结一下");
  expect(sendCall?.[1].content).toContain("docs/a.md");
  // 流式状态先行（startStream），占位实例未被哨兵 id 污染
  expect(useChatStore.getState().isStreaming[99]).toBe(true);
  // onSessionResolved → 换 key 重挂 → 订阅随真 id 建立到新会话
  await waitFor(() => expect(listeners.has("chat:stream:99")).toBe(true));

  // delta：经 StreamBuffer 首推即 flush 入 store（MessageList 渲染源）
  act(() => {
    listeners.get("chat:stream:99")!(undefined, {
      type: "text-delta",
      text: "要点一",
    });
  });
  await waitFor(() =>
    expect(useChatStore.getState().streams[99]?.text).toBe("要点一"),
  );

  // finish：清流式状态（发送按钮复位）
  act(() => {
    listeners.get("chat:stream:99")!(undefined, { type: "finish" });
  });
  await waitFor(() =>
    expect(useChatStore.getState().isStreaming[99]).toBeUndefined(),
  );
});

it("首条 send 失败的空会话：标记随建即写 → 关 tab 判空回收 session:delete（修复轮 1 Critical 1 端到端）", async () => {
  invokeMock.mockImplementation((ch: string) => {
    if (ch === "session:create") return { id: 99, workspaceId: 7 };
    if (ch === "chat:send") return Promise.reject(new Error("NO_MODEL"));
    if (ch === "message:listBySession")
      return { items: [], hasMore: false, nextBeforeId: null };
    if (ch === "chat:status")
      return {
        streaming: false,
        accessMode: "default",
        text: "",
        thinking: "",
        tools: { order: [], map: {} },
      };
    return undefined;
  });
  const { tabId } = useFileWindowStore
    .getState()
    .openTab({ kind: "workspace", workspaceId: 7, path: "docs/a.md" });
  render(
    <QueryClientProvider client={client}>
      <Harness tabId={tabId} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(inputProps.current?.onSend).toBeTruthy());
  // 首条直发失败（会话已建、用户消息未落库）：标记在建会话时已写——
  // 这是本用例的验收核心（成功后补标记的话此会话将永不回收）
  await act(async () => {
    await expect(inputProps.current!.onSend("总结一下", [])).rejects.toThrow(
      "NO_MODEL",
    );
  });
  const tab = useFileWindowStore.getState().tabs[0];
  expect(tab.sessionId).toBe(99);
  expect(tab.sessionCreatedHere).toBe(true);
  expect(useChatStore.getState().isStreaming[99]).toBeUndefined();
  // 关闭 tab：fire-and-forget 判空回收（消息空 → session:delete）
  act(() => {
    useFileWindowStore.getState().closeTab(tabId);
  });
  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("session:delete", 99),
  );
  expect(invokeMock).toHaveBeenCalledWith("message:listBySession", 99);
});

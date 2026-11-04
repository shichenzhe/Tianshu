// @vitest-environment jsdom
/**
 * ChatPane 文件窗透传（T22）：quickPrompts / pendingImageInjection /
 * onPendingImageInjectionConsumed 三个可选 props 原样下发 ChatInput
 * （文件窗 FileChatPanel 内嵌完整 ChatPane 的接线面）；缺省不传时
 * ChatInput 收到 undefined（AI 模块 ChatView 调用点零改动）。
 * ChatInput 以捕获 props 的 stub 替代，MessageList stub 同款
 * （骨架参照 chat-pane-regenerate.test.tsx）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
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

vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn() } }));

interface CapturedInputProps {
  quickPrompts?: unknown;
  pendingImageInjection?: unknown;
  onPendingImageInjectionConsumed?: () => void;
  initialDraft?: string;
  onDraftUnmount?: (draft: string) => void;
}
const inputProps = vi.hoisted(() => ({
  current: null as CapturedInputProps | null,
}));
vi.mock("../../src-react/domains/ai/chat/components/ChatInput", async () => {
  const { createElement } = await import("react");
  return {
    default: (props: CapturedInputProps) => {
      inputProps.current = props;
      return createElement("div", { "data-testid": "chat-input" });
    },
  };
});
vi.mock("../../src-react/domains/ai/chat/components/MessageList", () => ({
  default: () => null,
}));

import ChatPane from "../../src-react/domains/ai/chat/components/ChatPane";

const SESSION = {
  id: 7,
  workspaceId: 10,
  title: "文件会话",
  mode: "agent",
  createdAt: "",
  updatedAt: "",
} as Parameters<typeof ChatPane>[0]["session"];

beforeEach(() => {
  invokeMock.mockReset().mockImplementation((channel: string) => {
    switch (channel) {
      case "permission:get":
        return Promise.resolve("default");
      default:
        return Promise.resolve(undefined);
    }
  });
});
afterEach(() => {
  cleanup();
  inputProps.current = null;
});

describe("ChatPane 文件窗扩展透传", () => {
  it("quickPrompts / pendingImageInjection / consumed 回调原样下发 ChatInput", () => {
    const consumed = () => undefined;
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <ChatPane
          session={SESSION}
          workspace={{ id: 10 }}
          hasModel
          onOpenSettings={() => undefined}
          quickPrompts={[{ id: "s", label: "总结", prompt: "请总结。" }]}
          pendingImageInjection={[{ name: "a.png", absPath: "/att/a.png" }]}
          onPendingImageInjectionConsumed={consumed}
        />
      </QueryClientProvider>,
    );
    expect(inputProps.current?.quickPrompts).toEqual([
      { id: "s", label: "总结", prompt: "请总结。" },
    ]);
    expect(inputProps.current?.pendingImageInjection).toEqual([
      { name: "a.png", absPath: "/att/a.png" },
    ]);
    expect(inputProps.current?.onPendingImageInjectionConsumed).toBe(consumed);
  });

  it("缺省不传：ChatInput 收到 undefined（AI 模块调用点零改动）", () => {
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <ChatPane
          session={SESSION}
          workspace={{ id: 10 }}
          hasModel
          onOpenSettings={() => undefined}
        />
      </QueryClientProvider>,
    );
    expect(inputProps.current?.quickPrompts).toBeUndefined();
    expect(inputProps.current?.pendingImageInjection).toBeUndefined();
    expect(inputProps.current?.onPendingImageInjectionConsumed).toBeUndefined();
    expect(inputProps.current?.initialDraft).toBeUndefined();
    expect(inputProps.current?.onDraftUnmount).toBeUndefined();
  });

  it("initialDraft / onDraftUnmount 原样下发 ChatInput（T28 per-tab 草稿）", () => {
    const onDraftUnmount = vi.fn();
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <ChatPane
          session={SESSION}
          workspace={{ id: 10 }}
          hasModel
          onOpenSettings={() => undefined}
          initialDraft="暂存草稿"
          onDraftUnmount={onDraftUnmount}
        />
      </QueryClientProvider>,
    );
    expect(inputProps.current?.initialDraft).toBe("暂存草稿");
    expect(inputProps.current?.onDraftUnmount).toBe(onDraftUnmount);
  });
});

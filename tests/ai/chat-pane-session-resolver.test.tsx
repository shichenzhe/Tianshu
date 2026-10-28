// @vitest-environment jsdom
/**
 * ChatPane 占位会话直发（T26，spec §15 项 1）：哨兵会话（id<0）+
 * sessionResolver 首条发送——resolver 先落地真会话 → 前缀拼前直发
 * （直发语义照抄 useChatSend.send：startStream 先行，失败 finishStream
 * + invalidate 重取 + toast + rethrow）→ onSessionResolved 上抛；
 * 输入附件与会话侧 images 合并；缺省不传 resolver 走原路径（AI 模块
 * ChatView 零改动回归）；哨兵挂载期 getPermission 跳过。
 * ChatInput 以捕获 onSend 的 stub 替代，MessageList stub 同款
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

const toastMock = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

interface CapturedInputProps {
  onSend?: (
    content: string,
    files: Array<{ path: string; content: string; image?: true }>,
    overrides?: unknown,
  ) => Promise<void>;
  onAccessModeChange?: (mode: string) => void;
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

import ChatPane, {
  type SessionResolverResult,
} from "../../src-react/domains/ai/chat/components/ChatPane";
import type { SessionRecord } from "../../src-react/domains/ai/api/session.api";
import { useChatStore } from "../../src-react/domains/ai/chat/store/chat.store";

const PLACEHOLDER = {
  id: -1,
  workspaceId: 7,
  title: "",
  mode: "agent",
  createdAt: "",
  updatedAt: "",
} as Parameters<typeof ChatPane>[0]["session"];

const REAL_SESSION = {
  id: 99,
  workspaceId: 7,
  title: "a.md",
  mode: "agent",
  createdAt: "",
  updatedAt: "",
} as SessionRecord;

/** resolver 应答（文件注入前缀 + 图片 tab 自身附件） */
const resolverResult = (): SessionResolverResult => ({
  session: REAL_SESSION,
  contentPrefix: "【当前文件】docs/a.md",
  images: [{ absPath: "/ws/root/docs/a.png" }],
});

beforeEach(() => {
  invokeMock.mockReset().mockImplementation((channel: string) => {
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
      default:
        return Promise.resolve(undefined);
    }
  });
  toastMock.error.mockClear();
  toastMock.info.mockClear();
  useChatStore.setState({ streams: {}, isStreaming: {} });
});
afterEach(() => {
  cleanup();
  inputProps.current = null;
});

/** 渲染 ChatPane 并从 ChatInput 捕获桩取 onSend（含独立 QueryClient 供
 *  失败用例 spy invalidate） */
async function captureInput(
  props: Partial<Parameters<typeof ChatPane>[0]> = {},
  session: Parameters<typeof ChatPane>[0]["session"] = PLACEHOLDER,
): Promise<{
  onSend: CapturedInputProps["onSend"];
  onAccessModeChange: CapturedInputProps["onAccessModeChange"];
  queryClient: QueryClient;
}> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ChatPane
        session={session}
        workspace={{ id: 7 }}
        hasModel
        onOpenSettings={() => undefined}
        {...props}
      />
    </QueryClientProvider>,
  );
  await vi.waitFor(() => expect(inputProps.current?.onSend).toBeTruthy());
  return {
    onSend: inputProps.current!.onSend,
    onAccessModeChange: inputProps.current!.onAccessModeChange,
    queryClient,
  };
}

describe("ChatPane 占位会话直发（T26 sessionResolver）", () => {
  it("哨兵发送：resolver 先建 → 前缀拼接 → 直发真 id（startStream 先行）→ onSessionResolved 上抛", async () => {
    const order: string[] = [];
    const onSessionResolved = vi.fn();
    const { onSend } = await captureInput({
      sessionResolver: async () => {
        order.push("resolver");
        return resolverResult();
      },
      onSessionResolved,
    });
    await onSend!(
      "总结一下",
      [{ path: "/att/paste-1.png", content: "", image: true }],
      { temperature: 0.3 },
    );
    expect(order).toEqual(["resolver"]);
    const sendCall = invokeMock.mock.calls.find((c) => c[0] === "chat:send");
    expect(sendCall?.[1]).toMatchObject({
      sessionId: 99,
      content: "【当前文件】docs/a.md\n\n总结一下",
      overrides: { temperature: 0.3 },
      // 输入附件在前、会话侧 images（图片 tab 自身）在后合并
      images: [
        { absPath: "/att/paste-1.png" },
        { absPath: "/ws/root/docs/a.png" },
      ],
    });
    // 直发语义照抄 useChatSend.send：流式状态先行（成功路径由流事件收尾）
    expect(useChatStore.getState().isStreaming[99]).toBe(true);
    expect(onSessionResolved).toHaveBeenCalledWith(REAL_SESSION);
  });

  it("resolver 无前缀/无附件：content 原样、空 images 归一（不带 images 键）", async () => {
    const { onSend } = await captureInput({
      sessionResolver: async () => ({ session: REAL_SESSION }),
    });
    await onSend!("纯文本", []);
    const sendCall = invokeMock.mock.calls.find((c) => c[0] === "chat:send");
    expect(sendCall?.[1]).toMatchObject({ sessionId: 99, content: "纯文本" });
    expect(sendCall?.[1].images).toBeUndefined();
  });

  it("失败：finishStream 清流 + invalidate 重取 + toast + rethrow", async () => {
    invokeMock.mockImplementation((channel: string) => {
      if (channel === "chat:send") return Promise.reject(new Error("NO_MODEL"));
      return Promise.resolve(undefined);
    });
    const onSessionResolved = vi.fn();
    const { onSend, queryClient } = await captureInput({
      sessionResolver: resolverResult,
      onSessionResolved,
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    await expect(onSend!("总结", [])).rejects.toThrow("NO_MODEL");
    expect(useChatStore.getState().isStreaming[99]).toBeUndefined();
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["messages", 99],
    });
    expect(toastMock.error).toHaveBeenCalledWith("chat:errors.NO_MODEL");
    expect(onSessionResolved).not.toHaveBeenCalled();
  });

  it("缺省不传 resolver：哨兵发送走原路径 + 哨兵挂载期 getPermission 跳过", async () => {
    const { onSend } = await captureInput();
    await onSend!("内容", []);
    const sendCall = invokeMock.mock.calls.find((c) => c[0] === "chat:send");
    expect(sendCall?.[1]).toMatchObject({ sessionId: -1, content: "内容" });
    expect(invokeMock.mock.calls.some((c) => c[0] === "permission:get")).toBe(
      false,
    );
  });

  it("真会话（id>0）不触发 resolver：原路径发送", async () => {
    const sessionResolver = vi.fn(async () => resolverResult());
    const { onSend } = await captureInput({ sessionResolver }, REAL_SESSION);
    await onSend!("内容", []);
    expect(sessionResolver).not.toHaveBeenCalled();
    const sendCall = invokeMock.mock.calls.find((c) => c[0] === "chat:send");
    expect(sendCall?.[1]).toMatchObject({ sessionId: 99, content: "内容" });
  });

  it("占位控件防护（修复轮 1 Minor ③）：哨兵期权限切换轻提示不发 IPC", async () => {
    const { onAccessModeChange } = await captureInput();
    onAccessModeChange!("full");
    expect(toastMock.info).toHaveBeenCalledWith(
      "chat:input.lockedUntilFirstSend",
    );
    // 不发 permission:set（哨兵无真会话可写，防报错弹窗）；输入与首条
    // 发送链不受影响（onSend 捕获桩可用即证）
    expect(invokeMock.mock.calls.some((c) => c[0] === "permission:set")).toBe(
      false,
    );
  });
});

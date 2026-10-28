// @vitest-environment jsdom
/**
 * @文件 token 注入分派测试（引用式批 2026-10-21 起）：
 * - agent/plan + 工作空间相对路径 → 引用式（不读通道，AI 自读 read_file）
 * - ask 会话（无工具集）+ 绝对路径（read_file 读不到）→ 内容注入链：
 *   readWorkspaceFile 返回 PATH_OUTSIDE_WORKSPACE → 回退 readExternalFile
 *   （授权门：pickAndRead 选中即登记）读取注入，无 toast、onSend 收到内容
 * - 回退也失败（未授权路径）→ 维持既有语义：toast.warning 后仍发送
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
import type { ComponentProps } from "react";
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
vi.mock("sonner", () => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("../../src-react/domains/ai/api/assistant.api", () => ({
  default: { list: () => Promise.resolve([]) },
}));
vi.mock("../../src-react/domains/ai/skills/api/skill.api", () => ({
  default: {
    list: () => Promise.resolve([]),
    readSkill: () => Promise.resolve({ content: "" }),
    setEnabled: () => Promise.resolve(undefined),
  },
}));
vi.mock("../../src-react/domains/ai/chat/components/PlusMenu", () => ({
  default: () => null,
}));
vi.mock("../../src-react/domains/ai/chat/components/ModelPicker", () => ({
  default: () => null,
}));
vi.mock(
  "../../src-react/domains/ai/chat/components/context-usage-button",
  () => ({ default: () => null }),
);
vi.mock("../../src-react/domains/ai/chat/components/PermissionCapsule", () => ({
  default: () => null,
}));

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", () => ({ invoke: invokeMock }));

import ChatInput from "../../src-react/domains/ai/chat/components/ChatInput";
import { toast } from "sonner";

const onSend = vi.fn(() => Promise.resolve());

function renderInput(
  props: Partial<ComponentProps<typeof ChatInput>> = {},
): HTMLTextAreaElement {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ChatInput
        hasModel
        sending={false}
        sessionId={1}
        accessMode="default"
        currentMode="agent"
        workspaceId={7}
        onOpenMcp={() => undefined}
        onRunCommand={() => undefined}
        onSend={onSend}
        onStop={() => undefined}
        {...props}
      />
    </QueryClientProvider>,
  );
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

function send(textarea: HTMLTextAreaElement, value: string): void {
  fireEvent.change(textarea, {
    target: { value, selectionStart: value.length, selectionEnd: value.length },
  });
  fireEvent.keyDown(textarea, { key: "Enter" });
}

beforeEach(() => {
  onSend.mockClear();
  (toast.warning as ReturnType<typeof vi.fn>).mockClear();
  invokeMock.mockReset();
});
afterEach(cleanup);

describe("@ 文件 token 出界回退", () => {
  it("readWorkspaceFile 出界 → 回退 readExternalFile 注入，无 toast", async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "file:readWorkspaceFile") {
        return { error: "PATH_OUTSIDE_WORKSPACE" };
      }
      if (channel === "file:readExternalFile") {
        return { kind: "text", content: "FILE_CONTENT" };
      }
      return null;
    });
    const textarea = renderInput();
    await act(async () => {
      send(textarea, "@/Users/x/desktop/notes.md 看看这个");
    });
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledTimes(1);
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "file:readExternalFile",
      "/Users/x/desktop/notes.md",
    );
    expect(onSend.mock.calls[0][1]).toEqual([
      { path: "/Users/x/desktop/notes.md", content: "FILE_CONTENT" },
    ]);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("回退通道也拒绝（未授权路径）→ toast 后仍发送（既有语义）", async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "file:readWorkspaceFile") {
        return { error: "PATH_OUTSIDE_WORKSPACE" };
      }
      if (channel === "file:readExternalFile") {
        throw new Error("未授权的文件路径");
      }
      return null;
    });
    const textarea = renderInput();
    await act(async () => {
      send(textarea, "@/etc/secret 看看");
    });
    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      // 既有语义：读取失败 toast 但消息仍发出（token 原文保留在文本）
      expect(onSend).toHaveBeenCalledTimes(1);
    });
    expect(onSend.mock.calls[0][1]).toEqual([]);
  });

  it("agent 会话工作空间相对路径 → 引用式（不读通道，AI 自读）", async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      throw new Error("unexpected channel " + channel);
    });
    const textarea = renderInput();
    await act(async () => {
      send(textarea, "@src/index.ts 解释下");
    });
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledTimes(1);
    });
    // 引用式（引用式批 2026-10-21）：不读全文——无任何 read 调用
    expect(invokeMock).not.toHaveBeenCalled();
    expect(onSend.mock.calls[0][1]).toEqual([
      { path: "src/index.ts", content: "", kind: "fileRef" },
    ]);
  });

  it("ask 会话工作空间相对路径 → 无工具集，回退内容注入链", async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "file:readWorkspaceFile") {
        return { content: "IN_WS" };
      }
      throw new Error("unexpected channel " + channel);
    });
    const textarea = renderInput({ currentMode: "ask" });
    await act(async () => {
      send(textarea, "@src/index.ts 解释下");
    });
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledTimes(1);
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "file:readWorkspaceFile",
      7,
      "src/index.ts",
    );
    expect(onSend.mock.calls[0][1]).toEqual([
      { path: "src/index.ts", content: "IN_WS" },
    ]);
  });
});

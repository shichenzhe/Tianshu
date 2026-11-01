// @vitest-environment jsdom
/**
 * skill_ref 批（spec 2026-10-30）：⚡技能 token 发送链——onSend 第四参收
 * skillRefs 名单（不再 readSkill 拼全文进 files）；无技能时保持两参调用
 * （既有调用方签名零扰动）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  invokeMock.mockReset();
});
afterEach(cleanup);

describe("⚡技能 token 发送（skill_ref 批）", () => {
  it("⚡token 发送：onSend 第四参收 skillRefs 名单（去重），不再 readSkill 读全文", async () => {
    const textarea = renderInput();
    await act(async () => {
      send(textarea, "⚡demo-skill ⚡demo-skill 帮我处理");
    });
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    // 名单去重 + 正文保留 token 原样（files 无 skill 注入项）
    expect(onSend).toHaveBeenCalledWith(
      "⚡demo-skill ⚡demo-skill 帮我处理",
      [],
      undefined,
      ["demo-skill"],
    );
    // 不再触发技能全文读取（readSkill 通道零调用）
    expect(invokeMock).not.toHaveBeenCalledWith(
      "skill:readSkill",
      expect.anything(),
    );
  });

  it("无技能引用：保持两参调用（既有调用方签名零扰动）", async () => {
    const textarea = renderInput();
    await act(async () => {
      send(textarea, "普通消息");
    });
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(onSend).toHaveBeenCalledWith("普通消息", []);
  });
});

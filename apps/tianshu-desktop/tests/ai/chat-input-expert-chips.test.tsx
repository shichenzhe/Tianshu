// @vitest-environment jsdom
/**
 * ChatInput 专家推荐提示词胶囊填入（T8）：expertPromptsVisible 时输入区
 * 上方渲染绑定专家 quickPrompts，点击以换行分隔追加到草稿末尾（空草稿
 * 直接填入、无前导换行）。mock 骨架同 tests/ai/chat-input-todo.test.tsx
 * （i18n 直返 key、AssistantApi 返回绑定专家、重依赖子组件 stub）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// localStorage stub：keybindings store 模块加载即读取，Node 环境原生全局
// 会打 ExperimentalWarning，先行替换为内存 stub 消除噪音
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

// i18n mock：t 直接返回 key（断言不依赖具体文案）
vi.mock("@/i18n", () => ({
  default: { t: (key: string) => key },
}));
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

vi.mock("sonner", () => ({ toast: { warning: vi.fn(), error: vi.fn() } }));

// 绑定专家：quickPrompts 胶囊数据源（ExpertPromptChips 的 ["assistants"] 查询）
vi.mock("../../src-react/domains/ai/api/assistant.api", () => ({
  default: {
    list: () =>
      Promise.resolve([
        {
          id: 7,
          name: "翻译助手",
          quickPrompts: ["把这段翻译成英文：", "润色这段英文："],
        },
      ]),
  },
}));
vi.mock("../../src-react/domains/ai/skills/api/skill.api", () => ({
  default: {
    list: () => Promise.resolve([]),
    readSkill: () => Promise.resolve({ content: "" }),
    setEnabled: () => Promise.resolve(undefined),
  },
}));

// 重依赖子组件 stub：与胶囊填入链路无关
vi.mock("../../src-react/domains/ai/chat/components/PlusMenu", () => ({
  default: () => null,
}));
vi.mock("../../src-react/domains/ai/chat/components/ModelPicker", () => ({
  default: () => null,
}));
vi.mock(
  "../../src-react/domains/ai/chat/components/context-usage-button",
  () => ({
    default: () => null,
  }),
);
vi.mock("../../src-react/domains/ai/chat/components/PermissionCapsule", () => ({
  default: () => null,
}));

import ChatInput from "../../src-react/domains/ai/chat/components/ChatInput";

/** 渲染真实 ChatInput（空会话展示胶囊），返回 textarea 元素 */
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
        currentAssistantId={7}
        expertPromptsVisible
        workspaceId={null}
        onOpenMcp={() => undefined}
        onRunCommand={() => undefined}
        onSend={() => Promise.resolve()}
        onStop={() => undefined}
        {...props}
      />
    </QueryClientProvider>,
  );
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

afterEach(cleanup);

describe("专家推荐提示词填入（换行分隔追加）", () => {
  it("expertPromptsVisible 渲染胶囊；点击填入空草稿（无前导换行）", async () => {
    const textarea = renderInput();
    fireEvent.click(await screen.findByText("把这段翻译成英文："));
    expect(textarea.value).toBe("把这段翻译成英文：");
  });

  it("已有草稿时点击：换行分隔追加，不与既有内容粘连", async () => {
    const textarea = renderInput();
    fireEvent.change(textarea, {
      target: { value: "已有草稿", selectionStart: 4, selectionEnd: 4 },
    });
    fireEvent.click(await screen.findByText("润色这段英文："));
    expect(textarea.value).toBe("已有草稿\n润色这段英文：");
  });

  it("缺省 expertPromptsVisible 不渲染胶囊（其他消费方零改动）", () => {
    renderInput({ expertPromptsVisible: undefined });
    expect(screen.queryByText("把这段翻译成英文：")).toBeNull();
  });
});

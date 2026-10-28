// @vitest-environment jsdom
/**
 * ChatInput 文件窗扩展 props（T22，spec §13 项 3）：
 * - quickPrompts：空会话（expertPromptsVisible）输入区上方渲染注入胶囊，
 *   点击填入草稿（换行追加语义同专家胶囊）不发送
 * - pendingImageInjection：受控注入条目并入粘贴附件 chips（PastedFileEntry
 *   语义），并入后回调 onPendingImageInjectionConsumed；随发送分流为
 *   PendingFile image 附件（多模态通道，不读内容）
 * - ChatPane 透传：quickPrompts/pendingImageInjection/consumed 回调原样
 *   下发 ChatInput（AI 模块调用点缺省不受影响）
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// localStorage stub：keybindings store 模块加载即读取，Node 环境原生全局
// 会打 ExperimentalWarning，先行替换为内存 stub 消除噪音
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

// 重依赖子组件 stub（与本链路无关；chat-input-expert-chips 同款）
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

const QUICK_PROMPTS = [
  {
    id: "summarize",
    label: "总结全文要点",
    prompt: "请总结这份文档的核心要点。",
  },
  { id: "ocr", label: "提取图中文字", prompt: "请提取图片中的所有文字。" },
];

/** 渲染真实 ChatInput；onSend 捕获发送链路 */
function renderInput(
  props: Partial<ComponentProps<typeof ChatInput>> = {},
): HTMLTextAreaElement {
  const onSend = vi.fn(() => Promise.resolve());
  (renderInput as unknown as { onSend?: ReturnType<typeof vi.fn> }).onSend =
    onSend;
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
        expertPromptsVisible
        workspaceId={null}
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

afterEach(cleanup);

describe("ChatInput quickPrompts（文件窗快捷指令胶囊）", () => {
  it("expertPromptsVisible 时渲染注入胶囊；点击填入草稿不发送", async () => {
    const textarea = renderInput({ quickPrompts: QUICK_PROMPTS });
    fireEvent.click(await screen.findByText("总结全文要点"));
    expect(textarea.value).toBe("请总结这份文档的核心要点。");
    const onSend = (
      renderInput as unknown as { onSend: ReturnType<typeof vi.fn> }
    ).onSend;
    expect(onSend).not.toHaveBeenCalled();
  });

  it("已有草稿时点击：换行分隔追加（同专家胶囊语义）", async () => {
    const textarea = renderInput({ quickPrompts: QUICK_PROMPTS });
    fireEvent.change(textarea, {
      target: { value: "已有草稿", selectionStart: 4, selectionEnd: 4 },
    });
    fireEvent.click(await screen.findByText("提取图中文字"));
    expect(textarea.value).toBe("已有草稿\n请提取图片中的所有文字。");
  });

  it("缺省 quickPrompts 不渲染（既有消费方零改动）", () => {
    renderInput();
    expect(screen.queryByTestId("quick-prompt-chips")).toBeNull();
  });

  it("非空会话（expertPromptsVisible=false）不渲染", () => {
    renderInput({ quickPrompts: QUICK_PROMPTS, expertPromptsVisible: false });
    expect(screen.queryByTestId("quick-prompt-chips")).toBeNull();
  });
});

describe("ChatInput per-tab 草稿外置（T28 文件窗，spec §16 项 5）", () => {
  it("initialDraft 回灌：挂载即输入初值", () => {
    const textarea = renderInput({ initialDraft: "切回 tab 的草稿" });
    expect(textarea.value).toBe("切回 tab 的草稿");
  });

  it("onDraftUnmount 卸载上报最新草稿（回灌后继续输入亦然）", () => {
    const onDraftUnmount = vi.fn();
    const textarea = renderInput({
      initialDraft: "旧草稿",
      onDraftUnmount,
    });
    fireEvent.change(textarea, { target: { value: "旧草稿续写" } });
    cleanup();
    expect(onDraftUnmount).toHaveBeenCalledTimes(1);
    expect(onDraftUnmount).toHaveBeenCalledWith("旧草稿续写");
  });

  it("发送清空后卸载：上报空串（重挂不复活已发内容）", async () => {
    const onDraftUnmount = vi.fn();
    const onSend = vi.fn(() => Promise.resolve());
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
          workspaceId={null}
          onOpenMcp={() => undefined}
          onRunCommand={() => undefined}
          onSend={onSend}
          onStop={() => undefined}
          initialDraft="待发"
          onDraftUnmount={onDraftUnmount}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "chat:input.send" }));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    cleanup();
    expect(onDraftUnmount).toHaveBeenCalledWith("");
  });

  it("缺省不传：初值空串、卸载不回调（既有消费方零改动）", () => {
    const onDraftUnmount = vi.fn();
    const textarea = renderInput();
    expect(textarea.value).toBe("");
    cleanup();
    expect(onDraftUnmount).not.toHaveBeenCalled();
  });
});

describe("ChatInput pendingImageInjection（文件窗拖入受控注入）", () => {
  it("注入条目并入粘贴附件 chips，并入后回调消费清空", async () => {
    const consumed = vi.fn();
    renderInput({
      pendingImageInjection: [
        { name: "shot.png", absPath: "/att/paste-1.png" },
      ],
      onPendingImageInjectionConsumed: consumed,
    });
    expect(
      (await screen.findByTestId("paste-attachment-pill")).textContent,
    ).toContain("shot.png");
    await waitFor(() => expect(consumed).toHaveBeenCalled());
  });

  it("chip 可移除（并入后即归 ChatInput 附件体系管理）", async () => {
    renderInput({
      pendingImageInjection: [
        { name: "shot.png", absPath: "/att/paste-1.png" },
      ],
      onPendingImageInjectionConsumed: () => undefined,
    });
    const pill = await screen.findByTestId("paste-attachment-pill");
    fireEvent.click(pill);
    expect(screen.queryByTestId("paste-attachment-pill")).toBeNull();
  });

  it("随发送分流多模态 image 附件（不读内容）", async () => {
    const onSend = vi.fn(() => Promise.resolve());
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
          workspaceId={null}
          onOpenMcp={() => undefined}
          onRunCommand={() => undefined}
          onSend={onSend}
          onStop={() => undefined}
          pendingImageInjection={[
            { name: "shot.png", absPath: "/att/paste-1.png" },
          ]}
          onPendingImageInjectionConsumed={() => undefined}
        />
      </QueryClientProvider>,
    );
    const pill = await screen.findByTestId("paste-attachment-pill");
    expect(pill).toBeTruthy();
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "看看这张图" } });
    fireEvent.click(screen.getByRole("button", { name: "chat:input.send" }));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    const [, files] = onSend.mock.calls[0] as [
      string,
      Array<{ path: string; image?: boolean }>,
    ];
    expect(files).toContainEqual({
      path: "/att/paste-1.png",
      content: "",
      kind: "localFile",
      image: true,
    });
  });

  it("缺省 pendingImageInjection 无行为（不渲染 chips 不回调）", () => {
    renderInput();
    expect(screen.queryByTestId("attachment-pills")).toBeNull();
  });
});

// @vitest-environment jsdom
/**
 * 粘贴附件测试（真实 ChatInput 直渲染，骨架同 chat-input-todo.test.tsx）：
 * - 粘贴 Finder 文件（filePath 桥解出路径 + readExternalFile 预检通过）
 *   → 粘贴 pill 出现；纯文本粘贴零拦截（无 pill、无 IPC）
 * - 粘贴截图 blob（无路径）→ savePastedImage 落盘挂 pill
 * - size-0 图片（macOS 截图坑）→ readClipboardImage 主进程兜底挂 pill
 * - 超限 blob（>10MB）→ toast.warning 且不挂 pill
 * - submit：文本 pill 经 readExternalFile 读取注入；图片 pill 分流多模态
 *   附件（不读内容、image 标记，主进程侧读盘转 image part），onSend 收到
 *   kind "localFile"
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

// IPC mock：readExternalFile 双态（预检/发送读取）、savePastedImage、
// readClipboardImage 按 case 覆写
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

/** paste 事件合成（clipboardData.items 鸭子形——collectPasteFiles 只用 kind/getAsFile） */
function pasteFiles(textarea: HTMLTextAreaElement, files: File[]): void {
  fireEvent.paste(textarea, {
    clipboardData: {
      items: files.map((file) => ({
        kind: "file",
        type: file.type,
        getAsFile: () => file,
      })),
    },
  });
}

const png = (name = "image.png", size = 8, type = "image/png") =>
  new File([new Uint8Array(size)], name, { type });

/** preload 桥 stub（jsdom 无 window.filePath） */
function stubFilePath(resolve: (file: File) => string): void {
  Object.defineProperty(window, "filePath", {
    value: { getPathForFile: resolve },
    configurable: true,
  });
}

beforeEach(() => {
  onSend.mockClear();
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (channel: string) => {
    if (channel === "file:readExternalFile") {
      return { kind: "text", content: "hello" };
    }
    if (channel === "file:savePastedImage") {
      return "/att/paste-1.png";
    }
    if (channel === "file:readClipboardImage") {
      return "/att/paste-clip.png";
    }
    return null;
  });
});
afterEach(() => {
  cleanup();
  delete (window as { filePath?: unknown }).filePath;
});

describe("粘贴附件", () => {
  it("Finder 文件（可解路径 + 预检通过）→ 粘贴 pill 出现", async () => {
    stubFilePath((f) => (f.name === "notes.md" ? "/Users/x/notes.md" : ""));
    const textarea = renderInput();
    pasteFiles(textarea, [
      new File([new Uint8Array(4)], "notes.md", { type: "text/markdown" }),
    ]);
    await waitFor(() => {
      expect(screen.getByTestId("paste-attachment-pill").textContent).toContain(
        "notes.md",
      );
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "file:readExternalFile",
      "/Users/x/notes.md",
    );
  });

  it("纯文本粘贴零拦截：无 pill、无 IPC", () => {
    const textarea = renderInput();
    fireEvent.paste(textarea, {
      clipboardData: {
        items: [{ kind: "string", type: "text/plain", getAsFile: () => null }],
      },
    });
    expect(screen.queryByTestId("paste-attachment-pill")).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("截图 blob（无路径）→ savePastedImage 落盘挂 pill", async () => {
    stubFilePath(() => "");
    const textarea = renderInput();
    pasteFiles(textarea, [png()]);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "file:savePastedImage",
        "image.png",
        expect.any(String),
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("paste-attachment-pill").textContent).toContain(
        "image.png",
      );
    });
  });

  it("size-0 图片（macOS 截图坑）→ readClipboardImage 兜底挂 pill", async () => {
    stubFilePath(() => "");
    const textarea = renderInput();
    pasteFiles(textarea, [png("shot.png", 0)]);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("file:readClipboardImage");
    });
    await waitFor(() => {
      expect(screen.getByTestId("paste-attachment-pill").textContent).toContain(
        "clipboard.png",
      );
    });
  });

  it("超限 blob（>10MB）→ toast.warning 且不挂 pill", async () => {
    stubFilePath(() => "");
    const textarea = renderInput();
    pasteFiles(textarea, [png("big.png", 10 * 1024 * 1024 + 1)]);
    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("paste-attachment-pill")).toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith(
      "file:savePastedImage",
      expect.anything(),
      expect.anything(),
    );
  });

  it("submit：粘贴图片 pill 分流多模态附件（不读内容、content 空、image 标记），onSend 收到 localFile", async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "file:readExternalFile") {
        return { kind: "image" };
      }
      if (channel === "file:savePastedImage") {
        return "/att/paste-1.png";
      }
      return null;
    });
    stubFilePath(() => "");
    const textarea = renderInput();
    pasteFiles(textarea, [png("shot.png", 8)]);
    await waitFor(() => {
      expect(screen.getByTestId("paste-attachment-pill")).toBeTruthy();
    });
    fireEvent.change(textarea, {
      target: { value: "看看这张图", selectionStart: 5, selectionEnd: 5 },
    });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Enter" });
    });
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith("看看这张图", [
        expect.objectContaining({
          kind: "localFile",
          content: "",
          image: true,
        }),
      ]);
    });
    // 图片 pill 发送时不经 readExternalFile 读取（多模态通道在主进程读盘）
    expect(invokeMock).not.toHaveBeenCalledWith(
      "file:readExternalFile",
      expect.anything(),
    );
  });
});

// @vitest-environment jsdom
/**
 * 批9 P7「记住这个」入口测试（jsdom + testing-library）：
 * - user 消息 hover 操作栏出现「存入记忆」按钮（Brain 图标，aria 可达）
 * - 点击 → MemoryApi.applyInstruction 收到含消息正文的指令（管线现成，
 *   UI 面只做入口）；成功 toast + 失效 ["personalization"] 缓存
 * - 失败码透传映射 i18n（memoryError.*）；异常兜底 rememberFailed
 * - hideActions（流式生成中）隐藏入口；超长消息截断后入指令
 * - assistant 消息无该入口（素材来源限定用户消息，与 compiler 准入一致）
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";

import type { MessageRecord } from "../../src-react/domains/ai/api/session.api";
import { serializeBlocks } from "../../src-react/domains/ai/chat/model/blocks";
import MessageItem from "../../src-react/domains/ai/chat/components/MessageItem";

// 记忆 API 桩：applyInstruction 断言入参；resolveSources 本文件不触
const applyInstructionMock = vi.hoisted(() => vi.fn());
vi.mock("@/domains/app-settings/api/memory.api", () => ({
  MemoryApi: {
    applyInstruction: (...args: unknown[]) => applyInstructionMock(...args),
    compileNow: vi.fn(),
    resolveSources: vi.fn(),
  },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/ipc", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  on: () => () => {},
  send: () => {},
}));
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

/** 构造消息记录（blocks 用生产序列化器产出） */
function message(
  id: number,
  role: "user" | "assistant",
  text: string,
): MessageRecord {
  return {
    id,
    sessionId: 1,
    role,
    blocks: serializeBlocks([{ type: "text", text }]),
    createdAt: "2026-11-05T10:00:00.000Z",
  };
}

function renderItem(message: MessageRecord, hideActions?: boolean) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MessageItem message={message} hideActions={hideActions} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  applyInstructionMock.mockReset();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

describe("批9「记住这个」消息级入口", () => {
  it("user 消息 hover 操作栏渲染存入记忆按钮，点击调 applyInstruction（含正文）", async () => {
    applyInstructionMock.mockResolvedValue({
      ok: true,
      memory: "## 工作背景\n新",
    });
    renderItem(message(11, "user", "我长期用 NestJS 写后端"));
    const button = screen.getByRole("button", {
      name: "chat:message.remember",
    });
    fireEvent.click(button);
    await waitFor(() => expect(applyInstructionMock).toHaveBeenCalledTimes(1));
    const instruction = applyInstructionMock.mock.calls[0][0] as string;
    expect(instruction).toContain("记住");
    expect(instruction).toContain("我长期用 NestJS 写后端");
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("chat:message.rememberDone"),
    );
  });

  it("失败码透传 → memoryError 映射 toast（不吐裸错误）", async () => {
    applyInstructionMock.mockResolvedValue({
      ok: false,
      error: "MEMORY_DISABLED",
    });
    renderItem(message(12, "user", "记住这条"));
    fireEvent.click(
      screen.getByRole("button", { name: "chat:message.remember" }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "chat:memoryError.MEMORY_DISABLED",
      ),
    );
  });

  it("IPC 异常 → rememberFailed 兜底", async () => {
    applyInstructionMock.mockRejectedValue(new Error("ipc down"));
    renderItem(message(13, "user", "记住这条"));
    fireEvent.click(
      screen.getByRole("button", { name: "chat:message.remember" }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("chat:message.rememberFailed"),
    );
  });

  it("hideActions（流式生成中）不渲染入口；assistant 消息无入口", () => {
    renderItem(message(14, "user", "流式中"), true);
    expect(
      screen.queryByRole("button", { name: "chat:message.remember" }),
    ).toBeNull();
    cleanup();
    renderItem(message(15, "assistant", "助手回复"));
    expect(
      screen.queryByRole("button", { name: "chat:message.remember" }),
    ).toBeNull();
  });

  it("超长消息截断到 1800 字入指令（防撑爆记忆管线 prompt）", async () => {
    applyInstructionMock.mockResolvedValue({ ok: true, memory: "x" });
    const long = "长".repeat(5000);
    renderItem(message(16, "user", long));
    fireEvent.click(
      screen.getByRole("button", { name: "chat:message.remember" }),
    );
    await waitFor(() => expect(applyInstructionMock).toHaveBeenCalled());
    const instruction = applyInstructionMock.mock.calls[0][0] as string;
    expect(instruction.length).toBeLessThanOrEqual(1800 + 60);
    expect(instruction).toContain("长".repeat(100));
  });
});

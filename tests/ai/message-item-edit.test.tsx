// @vitest-environment jsdom
/**
 * MessageItem 原位编辑渲染测试（jsdom + testing-library）：
 * - isEditing：EditBar 原位替换气泡与 hover 操作栏（无气泡、无编辑/复制按钮）
 * - hideActions（会话 sending）：恢复普通气泡防呆，不渲染 EditBar
 * - 非编辑态：气泡 + hover 操作栏（编辑按钮）
 * - 接线：EditBar 的 Enter 提交/Escape 取消透传到 onEditSubmit/onEditCancel
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { MessageRecord } from "../../src-react/domains/ai/api/session.api";
import { serializeBlocks } from "../../src-react/domains/ai/chat/model/blocks";
import MessageItem from "../../src-react/domains/ai/chat/components/MessageItem";

// i18n mock：与 edit-bar.test.tsx 同套——t 直接返回 key（按钮名即 key），
// 断言行为不依赖具体文案；@/i18n 以最小 stub 替代真实初始化，避免 Node 26
// 无 --localstorage-file 时向 stderr 打 ExperimentalWarning
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

/** 构造 user 消息记录（blocks 用生产序列化器产出，与落库口径一致） */
function userMessage(id: number, text: string): MessageRecord {
  return {
    id,
    sessionId: 1,
    role: "user",
    blocks: serializeBlocks([{ type: "text", text }]),
    createdAt: "2026-09-08T10:00:00.000Z",
  };
}

/** 渲染 user 消息的 MessageItem（包 QueryClientProvider 供 useQuery）并取回回调 spy */
function renderUserItem(
  message: MessageRecord,
  props: {
    isEditing?: boolean;
    editInitialText?: string;
    hideActions?: boolean;
  } = {},
) {
  const onEdit = vi.fn();
  const onEditSubmit = vi.fn();
  const onEditCancel = vi.fn();
  const { container } = render(
    <QueryClientProvider client={new QueryClient()}>
      <MessageItem
        message={message}
        onEdit={onEdit}
        isEditing={props.isEditing}
        editInitialText={props.editInitialText}
        hideActions={props.hideActions}
        onEditSubmit={onEditSubmit}
        onEditCancel={onEditCancel}
      />
    </QueryClientProvider>,
  );
  return { container, onEdit, onEditSubmit, onEditCancel };
}

// vitest 未开 globals，RTL 自动清理不生效，显式清理
afterEach(cleanup);

describe("MessageItem 原位编辑态", () => {
  it("isEditing：EditBar 替换气泡与操作栏，回填 editInitialText", () => {
    const { container } = renderUserItem(userMessage(101, "待编辑的原消息"), {
      isEditing: true,
      editInitialText: "待编辑的原消息",
    });
    expect(screen.getByTestId("edit-bar")).toBeTruthy();
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("待编辑的原消息");
    // 气泡不渲染（.bg-secondary 为 user 气泡独有类；textarea 的 value 会
    // 渲染成其子文本节点，queryByText 无法区分，故按类名断言）
    expect(container.querySelector(".bg-secondary")).toBeNull();
    // hover 操作栏整体不渲染：无编辑/复制按钮
    expect(
      screen.queryByRole("button", { name: "chat:message.edit" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "common:copy" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "chat:message.resend" }),
    ).toBeTruthy();
  });

  it("hideActions（sending）期间恢复普通气泡，不渲染 EditBar", () => {
    const { container } = renderUserItem(userMessage(101, "待编辑的原消息"), {
      isEditing: true,
      editInitialText: "待编辑的原消息",
      hideActions: true,
    });
    expect(screen.queryByTestId("edit-bar")).toBeNull();
    expect(container.querySelector(".bg-secondary")).toBeTruthy();
    expect(screen.getByText("待编辑的原消息")).toBeTruthy();
    // hideActions 下操作栏仅余时间戳（未 hover 不显示），无编辑按钮
    expect(
      screen.queryByRole("button", { name: "chat:message.edit" }),
    ).toBeNull();
  });

  it("非编辑态：气泡 + hover 操作栏（编辑按钮在 DOM，opacity 仅视觉隐藏）", () => {
    const { container } = renderUserItem(userMessage(101, "普通消息"));
    expect(screen.queryByTestId("edit-bar")).toBeNull();
    expect(container.querySelector(".bg-secondary")).toBeTruthy();
    expect(screen.getByText("普通消息")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "chat:message.edit" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "common:copy" })).toBeTruthy();
  });
});

describe("MessageItem 原位编辑接线", () => {
  it("Enter 提交透传 onEditSubmit（去首尾空白）；Escape 透传 onEditCancel", () => {
    const { onEditSubmit, onEditCancel } = renderUserItem(
      userMessage(101, "hello"),
      { isEditing: true, editInitialText: "hello" },
    );
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "  改后内容  " } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onEditSubmit).toHaveBeenCalledTimes(1);
    expect(onEditSubmit).toHaveBeenCalledWith("改后内容");
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(onEditCancel).toHaveBeenCalledTimes(1);
  });
});

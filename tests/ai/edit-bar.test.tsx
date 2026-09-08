// @vitest-environment jsdom
/**
 * EditBar 组件交互测试（jsdom + testing-library）：
 * - 回填 initialText，挂载即 focus 且光标置于文末
 * - 内容 trim 为空时「重发」按钮禁用
 * - Escape 取消；Enter（非 Shift、非 IME 组合）提交并携带当前文本（去首尾空白）；
 *   Shift+Enter 不触发提交（保留默认换行行为）
 * - 编辑对象直接切换（A→B 不经过取消）：key 重挂载使文本按新 initialText 重建
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import EditBar from "../../src-react/domains/ai/chat/components/EditBar";
// 源码原文（Vite ?raw）：断言 ChatView 对 EditBar 的 key 接线存在
import chatViewSource from "../../src-react/domains/ai/chat/views/ChatView.tsx?raw";

// i18n mock：useTranslation 的 t 直接返回 key（按钮名即 key），断言行为不
// 依赖具体文案；其余导出（initReactI18next 等，经 @/lib/utils → @/i18n 引入）
// 保留真实实现，避免破坏应用 i18n 初始化
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

/** 渲染 EditBar 并取回 textarea 与回调 spy */
function renderEditBar(initialText: string) {
  const onCancel = vi.fn();
  const onSubmit = vi.fn();
  render(
    <EditBar
      initialText={initialText}
      onCancel={onCancel}
      onSubmit={onSubmit}
    />,
  );
  const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
  return { onCancel, onSubmit, textarea };
}

// vitest 未开 globals，RTL 自动清理不生效，显式清理
afterEach(cleanup);

describe("EditBar 回填与聚焦", () => {
  it("回填 initialText 且挂载即聚焦、光标置于文末", () => {
    const { textarea } = renderEditBar("原消息文本");
    expect(textarea.value).toBe("原消息文本");
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe("原消息文本".length);
    expect(textarea.selectionEnd).toBe("原消息文本".length);
  });
});

describe("EditBar 重发按钮禁用", () => {
  it("空内容与纯空白内容均禁用，有内容恢复可用", () => {
    const { textarea } = renderEditBar("");
    const resend = screen.getByRole("button", {
      name: "chat:message.resend",
    }) as HTMLButtonElement;
    expect(resend.disabled).toBe(true);
    fireEvent.change(textarea, { target: { value: "   " } });
    expect(resend.disabled).toBe(true);
    fireEvent.change(textarea, { target: { value: "改后内容" } });
    expect(resend.disabled).toBe(false);
  });
});

describe("EditBar 键盘交互", () => {
  it("Escape 触发 onCancel", () => {
    const { onCancel, textarea } = renderEditBar("hello");
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("Enter（非 Shift）触发 onSubmit 并携带当前文本（去首尾空白）", () => {
    const { onSubmit, textarea } = renderEditBar("hello");
    fireEvent.change(textarea, { target: { value: "  改写后的内容  " } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("改写后的内容");
  });

  it("Shift+Enter 不触发提交（换行）", () => {
    const { onSubmit, textarea } = renderEditBar("hello");
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("IME 组合中的 Enter 不触发提交", () => {
    const { onSubmit, textarea } = renderEditBar("hello");
    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("EditBar 按钮点击", () => {
  it("取消按钮触发 onCancel", () => {
    const { onCancel } = renderEditBar("hello");
    fireEvent.click(screen.getByRole("button", { name: "common:cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("重发按钮触发 onSubmit 并携带文本", () => {
    const { onSubmit } = renderEditBar("hello");
    fireEvent.click(
      screen.getByRole("button", { name: "chat:message.resend" }),
    );
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("hello");
  });
});

describe("EditBar 编辑对象切换（key 重挂载）", () => {
  it("key 变化触发重挂载：文本按新 initialText 重建并重新聚焦文末", () => {
    const noop = () => {};
    const { rerender } = render(
      <EditBar
        key={101}
        initialText="消息A文本"
        onCancel={noop}
        onSubmit={noop}
      />,
    );
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "消息A文本",
    );
    // 模拟 ChatView：编辑 A 期间点 B 的编辑 → setEditing 换 messageId，
    // key 变化令 EditBar 重挂载（state 重建，而非保留 A 的旧文本）
    rerender(
      <EditBar
        key={202}
        initialText="消息B文本"
        onCancel={noop}
        onSubmit={noop}
      />,
    );
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("消息B文本");
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe("消息B文本".length);
  });

  it("ChatView 渲染 EditBar 时以 key=editing.messageId 驱动重挂载", () => {
    expect(chatViewSource).toContain("key={editing.messageId}");
  });
});

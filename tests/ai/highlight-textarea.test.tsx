// tests/ai/highlight-textarea.test.tsx
// @vitest-environment jsdom
/**
 * 高亮输入组件冒烟：变量/关键字分段渲染进 overlay span、输入回调透传
 * onChange、空值不炸。渲染细节（文字透明/滚动同步）属视觉行为，jsdom
 * 不深测（先例 graph-canvas.test.tsx 深交互不测）。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import HighlightTextarea from "@/domains/ai/orchestration/components/HighlightTextarea";

afterEach(cleanup);

/** overlay 内按文本找 span（RTL text 匹配器对尾随空格归一化不稳） */
const spanByText = (piece: string): HTMLElement => {
  const hit = [...document.querySelectorAll("pre span")].find((el) =>
    el.textContent?.includes(piece),
  );
  expect(hit, `span 含 "${piece}" 应存在`).toBeTruthy();
  return hit as HTMLElement;
};

describe("HighlightTextarea 冒烟", () => {
  it("prompt 语言：合法变量占位符渲染 variable 段，非占位文本不高亮", () => {
    render(
      <HighlightTextarea
        value="主题 {{input.topic}}"
        onChange={() => {}}
        language="prompt"
      />,
    );
    expect(spanByText("{{input.topic}}").className).toContain(
      "bg-primary-subtle",
    );
    expect(spanByText("主题").className).not.toContain("bg-primary-subtle");
  });

  it("bash 语言：关键字与注释着色", () => {
    render(
      <HighlightTextarea
        value="echo hi # tail"
        onChange={() => {}}
        language="bash"
      />,
    );
    expect(spanByText("echo").className).toContain("text-primary");
    expect(spanByText("# tail").className).toContain("italic");
  });

  it("输入回调透传整值", () => {
    const onChange = vi.fn();
    render(
      <HighlightTextarea value="" onChange={onChange} language="nodejs" />,
    );
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "const a = 1" } });
    expect(onChange).toHaveBeenCalledWith("const a = 1");
  });

  it("空值渲染不炸（overlay 仅有尾行占位）", () => {
    render(
      <HighlightTextarea value="" onChange={() => {}} language="prompt" />,
    );
    expect(screen.getByRole("textbox")).toBeTruthy();
  });
});

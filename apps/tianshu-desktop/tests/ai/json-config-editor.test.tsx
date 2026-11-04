// @vitest-environment jsdom
/**
 * JsonConfigEditor 测试：受控 value 渲染、输入回调上抛、invalid 红框类、
 * 行号随行数变化；shiki 懒加载异步，测试只断言同步渲染与回退纯文本
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

afterEach(cleanup);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
// cn 依赖 @/i18n 实例，最小桩避免拉起完整 i18n 栈（initReactI18next 等
// 真实 react-i18next 导出会被上面的 mock 截断，同 tests/ai/new-task-view.test.tsx）
vi.mock("@/i18n", () => ({
  default: { t: (key: string) => key },
}));
vi.mock("@/domains/ai/chat/components/CodeBlock", () => ({
  getHighlighter: vi.fn(async () => null),
}));

import JsonConfigEditor from "@/domains/ai/mcp/components/JsonConfigEditor";

describe("JsonConfigEditor", () => {
  it("渲染受控 value 并在输入时上抛 onChange", () => {
    const onChange = vi.fn();
    render(
      <JsonConfigEditor value={'{"mcpServers": {}}'} onChange={onChange} />,
    );
    const textarea = screen.getByRole("textbox");
    // 仓库未装 @testing-library/jest-dom（同 new-task-view.test.tsx 注），直读 value
    expect((textarea as HTMLTextAreaElement).value).toBe('{"mcpServers": {}}');
    fireEvent.change(textarea, { target: { value: "{}" } });
    expect(onChange).toHaveBeenCalledWith("{}");
  });

  it("行号 gutter 与内容行数一致", () => {
    const { container } = render(
      <JsonConfigEditor
        value={'{\n  "mcpServers": {\n    "a": {}\n  }\n}'}
        onChange={vi.fn()}
      />,
    );
    // gutter 带 aria-hidden（getByRole 会排除），用 DOM 查询；
    // 逐行堆叠：子元素数 === 行数（防退化为无分隔的横排串被 w-10 裁剪）
    const gutter = container.querySelector('div[role="presentation"]');
    expect(gutter?.children.length).toBe(5);
    expect(gutter?.textContent).toBe("12345");
  });

  it("invalid 时编辑器带红框类", () => {
    const { container } = render(
      <JsonConfigEditor value="not json" onChange={vi.fn()} invalid />,
    );
    expect(container.querySelector(".border-destructive")).toBeTruthy();
  });
});

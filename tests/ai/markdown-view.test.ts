/**
 * MarkdownView 渲染测试（纯 Node 环境，renderToStaticMarkup 静态断言）：
 * - GFM 扩展语法（表格/删除线）依赖 remark-gfm 插件，缺失时管道表格按纯文本渲染
 * - 块级元素样式（间距/列表/引用）依赖 MARKDOWN_COMPONENTS 覆盖，Tailwind
 *   preflight 已清零默认样式
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import MarkdownView from "../../src-react/domains/ai/chat/components/MarkdownView";

function render(text: string): string {
  return renderToStaticMarkup(createElement(MarkdownView, { text }));
}

describe("MarkdownView GFM 扩展语法", () => {
  it("表格渲染为 table 元素（remark-gfm）", () => {
    const html = render("| 列A | 列B |\n| --- | --- |\n| 1 | 2 |");
    expect(html).toContain("<table");
    expect(html).toContain("<th");
    expect(html).toContain("<td");
  });

  it("删除线渲染为 del 元素", () => {
    expect(render("~~过时~~ 新方案")).toContain("<del>");
  });
});

describe("MarkdownView 块级排版", () => {
  it("段落带垂直间距（修复文字挤在一起）", () => {
    const html = render("第一段\n\n第二段");
    expect(html).toMatch(/<p class="[^"]*mt-2/);
  });

  it("无序列表带圆点与缩进", () => {
    const html = render("- 第一项\n- 第二项");
    expect(html).toContain("<ul");
    expect(html).toMatch(/<ul class="[^"]*list-disc/);
  });

  it("有序列表带序号", () => {
    const html = render("1. 第一步\n2. 第二步");
    expect(html).toContain("<ol");
    expect(html).toMatch(/<ol class="[^"]*list-decimal/);
  });

  it("引用块带左边框", () => {
    const html = render("> 引用内容");
    expect(html).toMatch(/<blockquote class="[^"]*border-l/);
  });

  it("标题带层级字号", () => {
    const html = render("## 小节标题");
    expect(html).toMatch(/<h2 class="[^"]*font-semibold/);
  });

  it("表格单元格带边框与表头底色", () => {
    const html = render("| 列A | 列B |\n| --- | --- |\n| 1 | 2 |");
    expect(html).toMatch(/<th class="[^"]*border/);
    expect(html).toMatch(/<th class="[^"]*bg-muted/);
  });
});

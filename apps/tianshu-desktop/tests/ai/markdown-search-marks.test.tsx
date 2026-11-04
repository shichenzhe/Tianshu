// @vitest-environment jsdom
/**
 * 搜索态 MarkdownView 渲染测试（markdown 源位置追踪批 spec §2）：
 * - 段落/标题/列表/链接显示文字/行内代码命中落 <mark data-hit-index>，
 *   切片文本准确、全局序按 hitBase 编排
 * - 当前实底/余半透明 class 随 activeIndex 切换
 * - 围栏代码（Shiki CodeBlock 分流）无 mark；纯函数剔除的命中传入亦不渲染
 * - 铁律：含围栏代码/伪工具调用条消息场景 totalHits === 渲染 mark 总数
 *
 * 注：用 jsdom + testing-library 而非 renderToStaticMarkup——zustand v5
 * useSyncExternalStore 的 SSR 快照取 getInitialState（store 置态不可见），
 * 客户端渲染无此限制
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";

import MarkdownView from "../../src-react/domains/ai/chat/components/MarkdownView";
import { useSessionSearchStore } from "../../src-react/domains/ai/store/session-search.store";
import {
  findRenderableRanges,
  searchMessageBlockHits,
  type HitRange,
} from "../../src-react/domains/ai/chat/lib/hit-positions";

function renderSearch(
  text: string,
  hits?: HitRange[],
  hitBase = 0,
  activeIndex = 0,
): string {
  useSessionSearchStore.setState({
    open: true,
    query: "命中词",
    activeIndex,
  });
  const { container } = render(
    createElement(MarkdownView, { text, hits, hitBase }),
  );
  return container.innerHTML;
}

/** 渲染输出中的 mark 总数（铁律断言用） */
function countMarks(html: string): number {
  return (html.match(/<mark[ >]/g) ?? []).length;
}

beforeEach(() => {
  useSessionSearchStore.getState().reset();
});

afterEach(cleanup);

describe("搜索态渲染：可映射构造落 mark", () => {
  it("段落命中包 mark，切片文本准确", () => {
    const text = "前文 命中词 后文";
    const html = renderSearch(text, [{ start: 3, length: 3 }]);
    expect(html).toContain("<mark");
    expect(html).toContain('data-hit-index="0"');
    expect(html).toContain("命中词");
    // 未命中片段保留在 mark 外
    expect(html).toMatch(/前文 <mark[^>]*>命中词<\/mark> 后文/);
  });

  it("标题/列表/强调/表格单元格命中落 mark", () => {
    for (const text of [
      "# 标题 命中词",
      "- 列表 命中词",
      "**强调 命中词**",
      "| 列 |\n| --- |\n| 单元 命中词 |",
    ]) {
      const html = renderSearch(text, [
        { start: text.indexOf("命中词"), length: 3 },
      ]);
      expect(countMarks(html)).toBe(1);
    }
  });

  it("链接显示文字命中落 mark（URL 命中已在纯函数层剔除）", () => {
    const text = "[显示 命中词](https://example.com/路径命中词)";
    const ranges = findRenderableRanges(text, "命中词");
    expect(ranges).toEqual([{ start: 4, length: 3 }]);
    const html = renderSearch(text, ranges);
    expect(countMarks(html)).toBe(1);
    expect(html).toContain("<a");
    expect(html).toMatch(/<mark[^>]*>命中词<\/mark>/);
  });

  it("行内代码内容命中落 mark（定界符剔除、内容切片准确）", () => {
    const text = "前文 `码内 命中词 码外` 后文";
    const ranges = findRenderableRanges(text, "命中词");
    expect(ranges).toEqual([{ start: text.indexOf("命中词"), length: 3 }]);
    const html = renderSearch(text, ranges);
    expect(countMarks(html)).toBe(1);
    expect(html).toMatch(/<code[^>]*>[^<]*<mark[^>]*>命中词<\/mark>/);
  });

  it("data-hit-index 全局序按 hitBase 编排（跨块两次渲染接续）", () => {
    const block1 = renderSearch(
      "命中词 与 命中词",
      [
        { start: 0, length: 3 },
        { start: 6, length: 3 },
      ],
      0,
    );
    expect(block1).toContain('data-hit-index="0"');
    expect(block1).toContain('data-hit-index="1"');
    const block2 = renderSearch("次块 命中词", [{ start: 3, length: 3 }], 2);
    expect(block2).toContain('data-hit-index="2"');
  });

  it("当前项实底、其余半透明 class 随 activeIndex 切换", () => {
    const hits = [
      { start: 0, length: 3 },
      { start: 6, length: 3 },
    ];
    const inactiveFirst = renderSearch("命中词 与 命中词", hits, 0, 1);
    expect(inactiveFirst).toMatch(
      /data-hit-index="0" class="[^"]*bg-primary\/25/,
    );
    expect(inactiveFirst).toMatch(
      /data-hit-index="1" class="[^"]*bg-primary text-primary-foreground/,
    );
    const activeFirst = renderSearch("命中词 与 命中词", hits, 0, 0);
    expect(activeFirst).toMatch(
      /data-hit-index="0" class="[^"]*bg-primary text-primary-foreground/,
    );
    expect(activeFirst).toMatch(
      /data-hit-index="1" class="[^"]*bg-primary\/25/,
    );
  });
});

describe("搜索态渲染：排除项无落点", () => {
  it("围栏代码命中不计数（纯函数剔除）——即使防御性传入也不渲染 mark", () => {
    const text = "```ts\n代码 命中词\n```";
    expect(findRenderableRanges(text, "命中词")).toEqual([]);
    // 防御性传入围栏内区间：pre 分流 CodeBlock，无 mark
    const html = renderSearch(text, [{ start: 8, length: 3 }]);
    expect(countMarks(html)).toBe(0);
  });

  it("无 hits 不渲染 mark（未搜索/无命中同一路径）", () => {
    const html = renderSearch("普通 命中词 文本");
    expect(countMarks(html)).toBe(0);
  });
});

describe("铁律：totalHits === 可滚动 mark 数", () => {
  /** 模拟 MessageList 编排：消息 → 块命中 → 逐块渲染 → mark 总数 */
  function renderMessageHits(
    blocks: Array<{ blockIdx: number; text: string }>,
    query: string,
  ): { total: number; marks: number } {
    useSessionSearchStore.setState({ open: true, query, activeIndex: 0 });
    const hits = searchMessageBlockHits(blocks, query);
    let base = 0;
    let marks = 0;
    for (const block of blocks) {
      const blockHits = hits
        .filter((hit) => hit.blockIdx === block.blockIdx)
        .map(({ start, length }) => ({ start, length }));
      if (blockHits.length > 0) {
        const { container } = render(
          createElement(MarkdownView, {
            text: block.text,
            hits: blockHits,
            hitBase: base,
          }),
        );
        marks += countMarks(container.innerHTML);
        base += blockHits.length;
      }
    }
    return { total: hits.length, marks };
  }

  it("混合消息（正文 + 围栏代码 + 链接 URL + 纯标记）：计数=落点", () => {
    const blocks = [
      { blockIdx: 0, text: "正文 命中词\n\n```ts\n围栏 命中词\n```" },
      { blockIdx: 1, text: "[显示](https://u.example/命中词) 与 **命中词**" },
    ];
    const { total, marks } = renderMessageHits(blocks, "命中词");
    expect(total).toBe(2);
    expect(marks).toBe(total);
  });

  it("含伪工具调用条消息：折叠条命中剔除，计数=落点", () => {
    const pseudo =
      "<tool_call>fn(命中词)</tool_call>\n<tool_call>x()</tool_call>";
    const blocks = [
      { blockIdx: 0, text: pseudo },
      { blockIdx: 1, text: "正常正文 命中词" },
    ];
    const { total, marks } = renderMessageHits(blocks, "命中词");
    expect(total).toBe(1);
    expect(marks).toBe(total);
  });

  it("行内代码与跨块多命中：计数=落点", () => {
    const blocks = [
      { blockIdx: 0, text: "`命中词` 与 命中词" },
      { blockIdx: 1, text: "- 命中词\n\n# 标题命中词" },
    ];
    const { total, marks } = renderMessageHits(blocks, "命中词");
    expect(total).toBe(4);
    expect(marks).toBe(total);
  });
});

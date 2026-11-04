/**
 * 位置级命中纯函数测试（markdown 源位置追踪批，spec §2）：
 * - findKeywordRanges 候选区间：大小写不敏感、非重叠
 * - findRenderableRanges 可渲染命中：排除项（围栏代码/mermaid/链接
 *   URL/图片/纯标记/实体转义内偏移）不产出；可映射构造（段落/标题/
 *   列表/强调/行内代码/链接显示文字/表格单元格/GFM 裸链）产出
 * - searchMessageBlockHits 消息级：多命中/跨块坐标/引用前缀换算/
 *   伪工具调用条剔除/铁律（产出数=可映射数）
 */
import { describe, expect, it } from "vitest";

import {
  findKeywordRanges,
  findRenderableRanges,
  searchMessageBlockHits,
} from "../../src-react/domains/ai/chat/lib/hit-positions";

describe("findKeywordRanges 候选区间扫描", () => {
  it("空关键字返回 []", () => {
    expect(findKeywordRanges("任意文本", "")).toEqual([]);
  });

  it("大小写不敏感且产出原文偏移", () => {
    expect(findKeywordRanges("aBa bab AbA", "aba")).toEqual([
      { start: 0, length: 3 },
      { start: 8, length: 3 },
    ]);
  });

  it("重叠出现按非重叠计数（aaa 查 aa → 1 次）", () => {
    expect(findKeywordRanges("aaa", "aa")).toEqual([{ start: 0, length: 2 }]);
  });
});

describe("findRenderableRanges 排除项不产出", () => {
  it("围栏代码内命中不产出（含 info string）", () => {
    const text = "前文\n\n```ts\n命中词\n```\n\n后文 命中词";
    expect(findRenderableRanges(text, "命中词")).toEqual([
      { start: text.lastIndexOf("命中词"), length: 3 },
    ]);
  });

  it("未闭合围栏吞至文末，内部命中不产出", () => {
    const text = "前文\n\n```\n命中词";
    expect(findRenderableRanges(text, "命中词")).toEqual([]);
  });

  it("mermaid 围栏内命中不产出", () => {
    const text = "```mermaid\ngraph TD; 命中词\n```";
    expect(findRenderableRanges(text, "命中词")).toEqual([]);
  });

  it("链接 URL 不产出、显示文字产出", () => {
    const text = "[命中词](https://example.com/命中词)";
    expect(findRenderableRanges(text, "命中词")).toEqual([
      { start: 1, length: 3 },
    ]);
  });

  it("Markdown 图片整段（alt+URL）不产出", () => {
    const text = "![命中词](attachment://命中词.png) 后文";
    expect(findRenderableRanges(text, "命中词")).toEqual([]);
  });

  it("尖括号自动链接：URL 本体即可见链接文本，有落点产出", () => {
    // 与 [显示](url) 不同——尖括号 autolink 渲染出的链接文字就是 URL
    // 本体（落点存在，铁律口径计入）
    const text = "<https://example.com/命中词>";
    expect(findRenderableRanges(text, "命中词")).toEqual([
      { start: 21, length: 3 },
    ]);
  });

  it("纯标记不产出（强调符/标题符/删除线/表格结构行）", () => {
    expect(findRenderableRanges("**命中词**", "**")).toEqual([]);
    expect(findRenderableRanges("## 命中词", "#")).toEqual([]);
    expect(findRenderableRanges("~~命中词~~", "~~")).toEqual([]);
    // 表格结构行（分隔行/边框管道）无文本节点落点
    const table = "| 列 |\n| --- |\n| 命中词 |";
    expect(findRenderableRanges(table, "|")).toEqual([]);
    expect(findRenderableRanges(table, "---")).toEqual([]);
  });

  it("实体/转义内偏移不产出（span 与渲染文本不等长）", () => {
    expect(findRenderableRanges("&amp; 命中词", "amp")).toEqual([]);
    expect(findRenderableRanges("\\* 命中词", "\\*")).toEqual([]);
  });

  it("引用块内文本产出（有落点）", () => {
    const text = "> 引用命中词";
    expect(findRenderableRanges(text, "引用命中词")).toEqual([
      { start: 2, length: 5 },
    ]);
  });
});

describe("findRenderableRanges 可映射命中产出", () => {
  it("段落多命中按序产出", () => {
    expect(findRenderableRanges("命中词 a 命中词 b", "命中词")).toEqual([
      { start: 0, length: 3 },
      { start: 6, length: 3 },
    ]);
  });

  it("标题/列表/强调内文本产出（构造标记剔除、文本偏移保留）", () => {
    expect(findRenderableRanges("# 命中词", "命中词")).toEqual([
      { start: 2, length: 3 },
    ]);
    expect(findRenderableRanges("- 命中词", "命中词")).toEqual([
      { start: 2, length: 3 },
    ]);
    expect(findRenderableRanges("**命中词**", "命中词")).toEqual([
      { start: 2, length: 3 },
    ]);
  });

  it("行内代码内容产出（delim 剔除、内容可见）", () => {
    expect(findRenderableRanges("`命中词`", "命中词")).toEqual([
      { start: 1, length: 3 },
    ]);
  });

  it("表格单元格文本产出", () => {
    const text = "| 列 |\n| --- |\n| 命中词 |";
    expect(findRenderableRanges(text, "命中词")).toEqual([
      { start: text.indexOf("命中词"), length: 3 },
    ]);
  });

  it("GFM 裸链 URL 文本有落点产出（链接本体即显示文字）", () => {
    const text = "看 https://example.com/命中词 这里";
    expect(findRenderableRanges(text, "命中词")).toEqual([
      { start: text.indexOf("命中词"), length: 3 },
    ]);
  });

  it("大小写不敏感；查询首尾空白 trim", () => {
    expect(findRenderableRanges("ABC abc", " abc ")).toEqual([
      { start: 0, length: 3 },
      { start: 4, length: 3 },
    ]);
  });
});

describe("searchMessageBlockHits 消息级位置级命中", () => {
  it("跨块命中换算回块坐标（blockIdx + 块内偏移）", () => {
    const hits = searchMessageBlockHits(
      [
        { blockIdx: 0, text: "第一块 命中词" },
        { blockIdx: 2, text: "第二块\n\n含 命中词 与 命中词" },
      ],
      "命中词",
    );
    expect(hits).toEqual([
      { blockIdx: 0, start: 4, length: 3 },
      { blockIdx: 2, start: 7, length: 3 },
      { blockIdx: 2, start: 13, length: 3 },
    ]);
  });

  it("文件引用前缀段剔除：前缀内命中不产出、正文命中偏移按原始块坐标", () => {
    const refPrefix =
      "[引用文件 src/a.ts]（请用 read 工具读取该文件后处理）";
    const hits = searchMessageBlockHits(
      [{ blockIdx: 0, text: `${refPrefix}\n\n正文 命中词 结尾` }],
      "命中词",
    );
    // 块坐标含前缀全长：前缀段长 + 空行分隔（2）+「正文 」(3)
    expect(hits).toEqual([
      { blockIdx: 0, start: refPrefix.length + 5, length: 3 },
    ]);
    // 前缀内（文件名）命中不产出
    const fileNameHits = searchMessageBlockHits(
      [{ blockIdx: 0, text: `${refPrefix}\n\n正文` }],
      "a.ts",
    );
    expect(fileNameHits).toEqual([]);
  });

  it("伪工具调用条块命中剔除（折叠条无落点）", () => {
    const pseudo = "<tool_call>abc</tool_call>\n<tool_call>def</tool_call>";
    const hits = searchMessageBlockHits(
      [
        { blockIdx: 0, text: "正常正文 命中词" },
        { blockIdx: 1, text: pseudo },
      ],
      "tool_call",
    );
    expect(hits).toEqual([]);
  });

  it("空查询/无 text 块返回 []", () => {
    expect(
      searchMessageBlockHits([{ blockIdx: 0, text: "abc" }], "  "),
    ).toEqual([]);
    expect(searchMessageBlockHits([], "abc")).toEqual([]);
  });

  it("围栏代码跨块场景：铁律产出数=可映射落点数", () => {
    // 消息 3 个 text 块：块 0 正文命中、块 1 围栏（剔除）、块 2 正文命中
    const hits = searchMessageBlockHits(
      [
        { blockIdx: 0, text: "前文 命中词" },
        { blockIdx: 1, text: "```\n命中词\n```" },
        { blockIdx: 2, text: "后文 命中词" },
      ],
      "命中词",
    );
    expect(hits).toEqual([
      { blockIdx: 0, start: 3, length: 3 },
      { blockIdx: 2, start: 3, length: 3 },
    ]);
  });
});

import { describe, expect, it } from "vitest";

import type { MessageBlock } from "./blocks";
import {
  countKeywordHits,
  findKeywordRanges,
  nextHitPosition,
  searchableMessageText,
  searchMessagePositions,
  type SearchableMessage,
} from "./message-search";

/** text 块速构 */
function textBlock(text: string): MessageBlock {
  return { type: "text", text };
}

function msg(role: string, ...blocks: MessageBlock[]): SearchableMessage {
  return { role, blocks };
}

/** 引用式前缀（单行带 read_file 指示——file-refs 注入正体） */
const FILE_REF_LINE =
  "[引用文件 src/a.ts]（请用 read_file 工具读取该文件后处理）";

describe("countKeywordHits", () => {
  it("空关键字恒 0", () => {
    expect(countKeywordHits("hello world", "")).toBe(0);
  });

  it("大小写不敏感", () => {
    expect(countKeywordHits("Hello HELLO hello", "hello")).toBe(3);
  });

  it("非重叠：命中后按关键字长度跳过", () => {
    // "aaaa" 搜 "aa"：首命中 [0,2)，余 "aa" 再命中——共 2 次
    expect(countKeywordHits("aaaa", "aa")).toBe(2);
    // 重叠场景 "aaa" 搜 "aa"：只计 1 次（剩余 "a" 不成命中）
    expect(countKeywordHits("aaa", "aa")).toBe(1);
  });

  it("无命中为 0", () => {
    expect(countKeywordHits("abc", "xyz")).toBe(0);
  });
});

describe("findKeywordRanges", () => {
  it("空关键字返回 []", () => {
    expect(findKeywordRanges("hello", "")).toEqual([]);
  });

  it("单命中给出原文偏移", () => {
    expect(findKeywordRanges("前 needle 后", "needle")).toEqual([
      { start: 2, length: 6 },
    ]);
  });

  it("多命中按序给出互不重叠区间", () => {
    expect(findKeywordRanges("needle needle", "needle")).toEqual([
      { start: 0, length: 6 },
      { start: 7, length: 6 },
    ]);
  });

  it("大小写不敏感且区间按原文计", () => {
    expect(findKeywordRanges("abNeedlecd", "needle")).toEqual([
      { start: 2, length: 6 },
    ]);
  });
});

describe("searchableMessageText", () => {
  it("仅 text blocks 以 \\n 拼接", () => {
    const m = msg(
      "user",
      {
        type: "tool_call",
        toolCallId: "t1",
        toolName: "run",
        args: {},
        state: "done",
      },
      textBlock("第一段"),
      { type: "thinking", text: "thinking 内容" },
      textBlock("第二段"),
    );
    expect(searchableMessageText(m)).toBe("第一段\n第二段");
  });

  it("剔除头部文件引用前缀段（引用式单行）", () => {
    const m = msg("user", textBlock(`${FILE_REF_LINE}\n\n正文 needle 在这里`));
    expect(searchableMessageText(m)).toBe("正文 needle 在这里");
  });

  it("剔除头部文件引用前缀段（内容注入式——头行 + 全文随段拆出）", () => {
    const m = msg(
      "user",
      textBlock(`[引用文件 notes.md]\n机密PDF内容\n\n正文 needle`),
    );
    const rest = searchableMessageText(m);
    expect(rest).toBe("正文 needle");
    // 注入全文随前缀段一并剔除（命中无落点）
    expect(rest).not.toContain("机密PDF");
  });

  it("正文段中手打同款引用文本不受影响（只认头部连续段）", () => {
    const m = msg("user", textBlock(`前文\n\n[引用文件 x]\n\nneedle 尾段`));
    expect(searchableMessageText(m)).toBe(
      "前文\n\n[引用文件 x]\n\nneedle 尾段",
    );
  });
});

describe("searchMessagePositions", () => {
  it("空/纯空白关键字返回 []", () => {
    const messages = [msg("user", textBlock("hello"))];
    expect(searchMessagePositions(messages, "")).toEqual([]);
    expect(searchMessagePositions(messages, "   ")).toEqual([]);
  });

  it("关键字首尾空白被修剪后匹配", () => {
    const messages = [msg("user", textBlock("hello world"))];
    expect(searchMessagePositions(messages, "  hello  ")).toEqual([
      { messageIdx: 0, blockIdx: 0, start: 0, length: 5 },
    ]);
  });

  it("大小写不敏感命中并返回位置", () => {
    const messages = [
      msg("user", textBlock("前一条")),
      msg("assistant", textBlock("Needle 在这")),
      msg("user", textBlock("无关")),
    ];
    expect(searchMessagePositions(messages, "needle")).toEqual([
      { messageIdx: 1, blockIdx: 0, start: 0, length: 6 },
    ]);
  });

  it("system 消息排除", () => {
    const messages = [
      msg("system", textBlock("needle 系统提示")),
      msg("user", textBlock("普通")),
    ];
    expect(searchMessagePositions(messages, "needle")).toEqual([]);
  });

  it("同消息多命中各计一位（位置级——导航/计数按位）", () => {
    const messages = [msg("user", textBlock("needle needle needle"))];
    expect(searchMessagePositions(messages, "needle")).toEqual([
      { messageIdx: 0, blockIdx: 0, start: 0, length: 6 },
      { messageIdx: 0, blockIdx: 0, start: 7, length: 6 },
      { messageIdx: 0, blockIdx: 0, start: 14, length: 6 },
    ]);
  });

  it("跨块命中按块内各给位置（块间 \\n 拼接串的块内偏移）", () => {
    const messages = [
      msg(
        "user",
        { type: "thinking", text: "needle 思考" },
        textBlock("前半 needle"),
        textBlock("后半 NEEDLE 尾"),
      ),
    ];
    expect(searchMessagePositions(messages, "needle")).toEqual([
      { messageIdx: 0, blockIdx: 1, start: 3, length: 6 },
      { messageIdx: 0, blockIdx: 2, start: 3, length: 6 },
    ]);
  });

  it("块拼接处跨块关键字不命中（\\n 拼接语义与桌面一致）", () => {
    // "need" + "\n" + "le" 拼接后含换行，与桌面 searchableText 同口径——
    // 该用例钉死「跨块拼接处不断词」语义
    const messages = [
      msg("user", textBlock("前半 need"), textBlock("le 后半")),
    ];
    expect(searchMessagePositions(messages, "needle")).toEqual([]);
  });

  it("命中落在被剔除的引用前缀段内不命中", () => {
    const messages = [
      msg("user", textBlock(`[引用文件 a.md]\n机密内容\n\n普通正文`)),
    ];
    expect(searchMessagePositions(messages, "机密")).toEqual([]);
  });

  it("前缀段剔除后正文命中偏移按块内原文计", () => {
    const text = `${FILE_REF_LINE}\n\n正文 needle 在这里`;
    const messages = [msg("user", textBlock(text))];
    expect(searchMessagePositions(messages, "needle")).toEqual([
      // 块内偏移含前缀（跨度按拼接串映射）——块内原文 indexOf 口径
      { messageIdx: 0, blockIdx: 0, start: text.indexOf("needle"), length: 6 },
    ]);
  });

  it("非 text 块（tool_call/image/thinking）不参与匹配", () => {
    const messages = [
      msg(
        "assistant",
        {
          type: "tool_call",
          toolCallId: "t",
          toolName: "needle_tool",
          args: {},
          state: "done",
        },
        { type: "image", imagePath: "/x/needle.png", mime: "image/png" },
        { type: "thinking", text: "needle 思考" },
      ),
    ];
    expect(searchMessagePositions(messages, "needle")).toEqual([]);
  });

  it("多条消息命中按时序序返回（含消息索引）", () => {
    const messages = [
      msg("user", textBlock("needle one")),
      msg("assistant", textBlock("无关")),
      msg("assistant", textBlock("NEEDLE two")),
    ];
    expect(searchMessagePositions(messages, "needle")).toEqual([
      { messageIdx: 0, blockIdx: 0, start: 0, length: 6 },
      { messageIdx: 2, blockIdx: 0, start: 0, length: 6 },
    ]);
  });
});

describe("nextHitPosition", () => {
  it("total<=0 恒 0", () => {
    expect(nextHitPosition(3, 0, 1)).toBe(0);
    expect(nextHitPosition(0, 0, -1)).toBe(0);
  });

  it("下一条逐位递进", () => {
    expect(nextHitPosition(0, 3, 1)).toBe(1);
    expect(nextHitPosition(1, 3, 1)).toBe(2);
  });

  it("下一条到底环绕回首位", () => {
    expect(nextHitPosition(2, 3, 1)).toBe(0);
  });

  it("上一条到头环绕至末位", () => {
    expect(nextHitPosition(0, 3, -1)).toBe(2);
    expect(nextHitPosition(2, 3, -1)).toBe(1);
  });
});

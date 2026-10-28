/**
 * 会话内搜索高亮纯函数测试：
 * - splitByQuery 大小写不敏感切分（命中/未命中段交替）
 * - countHits 单条文本命中计数
 * - hitOffsets 各消息首命中的全局序号（前缀和）
 */
import { describe, expect, it } from "vitest";

import {
  countHits,
  hitOffsets,
  splitByQuery,
} from "../../src-react/domains/ai/chat/lib/search-highlight";

describe("splitByQuery 切分", () => {
  it("空关键字返回整段未命中", () => {
    expect(splitByQuery("hello world", "")).toEqual([
      { text: "hello world", hit: false },
    ]);
  });

  it("无命中返回整段未命中", () => {
    expect(splitByQuery("hello", "xyz")).toEqual([
      { text: "hello", hit: false },
    ]);
  });

  it("命中在中间：三段交替", () => {
    expect(splitByQuery("fooBARbaz", "bar")).toEqual([
      { text: "foo", hit: false },
      { text: "BAR", hit: true },
      { text: "baz", hit: false },
    ]);
  });

  it("大小写不敏感且保留原文大小写", () => {
    const segments = splitByQuery("Apple and APPLES", "apple");
    expect(segments).toEqual([
      { text: "Apple", hit: true },
      { text: " and ", hit: false },
      { text: "APPLE", hit: true },
      { text: "S", hit: false },
    ]);
  });

  it("命中在开头与结尾不产生空段", () => {
    expect(splitByQuery("abcXXabc", "abc")).toEqual([
      { text: "abc", hit: true },
      { text: "XX", hit: false },
      { text: "abc", hit: true },
    ]);
  });

  it("重叠出现按非重叠计数（aaa 查 aa 命中 1 次）", () => {
    expect(splitByQuery("aaa", "aa")).toEqual([
      { text: "aa", hit: true },
      { text: "a", hit: false },
    ]);
  });
});

describe("countHits 命中计数", () => {
  it("空关键字为 0", () => {
    expect(countHits("任意文本", "")).toBe(0);
  });

  it("累计全部命中段", () => {
    expect(countHits("aBa bab AbA", "aba")).toBe(2);
  });

  it("无命中为 0", () => {
    expect(countHits("hello", "xyz")).toBe(0);
  });
});

describe("hitOffsets 消息首命中全局序号", () => {
  it("按命中数前缀和累计", () => {
    expect(hitOffsets([3, 0, 2, 0])).toEqual([0, 3, 3, 5]);
  });

  it("空列表返回空", () => {
    expect(hitOffsets([])).toEqual([]);
  });
});

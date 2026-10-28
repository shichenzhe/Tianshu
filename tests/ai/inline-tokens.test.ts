/**
 * 内联引用 token 解析测试:token 提取/文本重整/镜像切分// 触发检测
 */
import { describe, expect, it } from "vitest";

import {
  SLASH_COMMANDS,
  detectMention,
  detectSlash,
  parseInlineTokens,
  renderTokenSegments,
} from "../../src-react/domains/ai/chat/lib/inline-tokens";

describe("parseInlineTokens token 提取", () => {
  it("三类 token 混排提取并重整文本", () => {
    const result = parseInlineTokens(
      "帮我总结 @docs/readme.md 的要点,再用 ⚡morse 转换 /compact",
    );
    expect(result).toEqual({
      text: "帮我总结 的要点,再用 转换",
      fileTokens: ["docs/readme.md"],
      skillTokens: ["morse"],
      commands: ["compact"],
      todoTokens: [],
    });
  });

  it("行首与空格后均可识别;@ 前是文字不识别(邮箱防误触)", () => {
    const result = parseInlineTokens("@a.txt b@c.txt ⚡x");
    expect(result.fileTokens).toEqual(["a.txt"]);
    expect(result.skillTokens).toEqual(["x"]);
  });

  it("去重与多 token", () => {
    const result = parseInlineTokens("@a.md @a.md ⚡s1 ⚡s2 ⚡s1");
    expect(result.fileTokens).toEqual(["a.md", "a.md"]);
    expect(result.skillTokens).toEqual(["s1", "s2", "s1"]);
  });

  it("纯命令消息文本为空", () => {
    expect(parseInlineTokens("/compact")).toEqual({
      text: "",
      fileTokens: [],
      skillTokens: [],
      commands: ["compact"],
      todoTokens: [],
    });
  });

  it("未知 / 词不是命令 token", () => {
    const result = parseInlineTokens("/unknown 命令");
    expect(result.commands).toEqual([]);
    expect(result.text).toContain("/unknown");
  });

  it("无 token 原样(首尾空白已 trim)", () => {
    expect(parseInlineTokens("  普通文本  ").text).toBe("普通文本");
  });
});

describe("renderTokenSegments 镜像切分", () => {
  it("token 与普通文本分段(前导空白归普通段)", () => {
    expect(renderTokenSegments("看 @a.md 和 ⚡skill")).toEqual([
      { text: "看 ", isToken: false },
      { text: "@a.md", isToken: true },
      { text: " 和 ", isToken: false },
      { text: "⚡skill", isToken: true },
    ]);
  });

  it("行首 token 无前导空白", () => {
    expect(renderTokenSegments("/compact")).toEqual([
      { text: "/compact", isToken: true },
    ]);
  });

  it("空串返回空数组", () => {
    expect(renderTokenSegments("")).toEqual([]);
  });
});

describe("detectSlash / 触发检测", () => {
  it("行首与空白后触发,返回起始下标与 query", () => {
    expect(detectSlash("/comp", 5)).toEqual({ startIndex: 0, query: "comp" });
    expect(detectSlash("看 /", 3)).toEqual({ startIndex: 2, query: "" });
  });

  it("文字后 / 不触发;非法字符中断", () => {
    expect(detectSlash("a/b", 3)).toBeNull();
    expect(detectSlash("/a b", 4)).toBeNull();
  });

  it("光标移出 token 后不触发(空格中断)", () => {
    expect(detectSlash("/abc x", 6)).toBeNull();
  });
});

describe("SLASH_COMMANDS", () => {
  it("compact 在词表", () => {
    expect(SLASH_COMMANDS).toContain("compact");
  });
});

describe("todo token（#<id>）", () => {
  it("解析与边界：#12 独立成 token；#1234 不被截断；普通文本 # 不误伤", () => {
    const { todoTokens, text } = parseInlineTokens(
      "看 #12 和 #1234，还有 # 号",
    );
    expect(todoTokens).toEqual(["#12", "#1234"]);
    expect(text).not.toContain("#12");
  });

  it("token 携 # 前缀原文收集（消费方按 id 解析）；与 @/⚡/命令混排互不干扰", () => {
    const result = parseInlineTokens("@a.md ⚡s #7 /compact");
    expect(result.todoTokens).toEqual(["#7"]);
    expect(result.fileTokens).toEqual(["a.md"]);
    expect(result.skillTokens).toEqual(["s"]);
    expect(result.commands).toEqual(["compact"]);
  });

  it("文字后的 # 与非数字 # 不识别（话题标记防误触）", () => {
    expect(parseInlineTokens("x#12 #tag").todoTokens).toEqual([]);
  });

  it("renderTokenSegments：#12 渲染为 pill 段（kind todo），既有段形状不变", () => {
    expect(renderTokenSegments("看 #12")).toEqual([
      { text: "看 ", isToken: false },
      { text: "#12", isToken: true, kind: "todo" },
    ]);
  });

  it("renderTokenSegments：file/skill 段不带 kind（todo 专属标注）", () => {
    const segments = renderTokenSegments("@a.md ⚡s");
    expect(segments).toEqual([
      { text: "@a.md", isToken: true },
      { text: " ", isToken: false },
      { text: "⚡s", isToken: true },
    ]);
  });
});

describe("detectMention @ 触发检测", () => {
  it("detectMention @ 前须空白", () => {
    expect(detectMention("a@doc", 5)).toBeNull();
    expect(detectMention("看 @doc", 6)).toEqual({
      startIndex: 2,
      query: "doc",
    });
  });

  it("行首触发且空 query 触发；邮箱不误触", () => {
    expect(detectMention("@doc", 4)).toEqual({ startIndex: 0, query: "doc" });
    expect(detectMention("@", 1)).toEqual({ startIndex: 0, query: "" });
    expect(detectMention("user@host.com", 13)).toBeNull();
  });

  it("token 内非法字符中断", () => {
    expect(detectMention("@a!b", 4)).toBeNull();
  });

  it("光标前的最后 @ 生效", () => {
    expect(detectMention("@a @b", 5)).toEqual({ startIndex: 3, query: "b" });
  });
});

/**
 * 内联引用 token 解析测试:token 提取/文本重整/镜像切分// 触发检测
 */
import { describe, expect, it } from "vitest";

import {
  SLASH_COMMANDS,
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

import { describe, expect, it } from "vitest";

import { detectPseudoToolCallText } from "./pseudo-tool-call";

describe("detectPseudoToolCallText", () => {
  it("空串不命中", () => {
    expect(detectPseudoToolCallText("")).toBe(false);
  });

  it("单个 <tool_call> 可能是讨论语法，不命中", () => {
    expect(detectPseudoToolCallText("工具语法是 <tool_call> 标签")).toBe(false);
  });

  it("两个及以上 <tool_call> 命中", () => {
    expect(
      detectPseudoToolCallText("<tool_call>a</tool_call>\n<tool_call>b"),
    ).toBe(true);
  });

  it("分词器特殊 token <| 命中", () => {
    expect(detectPseudoToolCallText("<|im_start|>")).toBe(true);
  });

  it("正常文本不命中", () => {
    expect(detectPseudoToolCallText("普通回答，1 < 2 且 3 > 2")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { shortenPath } from "../../src-react/domains/ai/chat/lib/shorten-path";

describe("shortenPath 路径中段省略", () => {
  it("不超过 24 字符的路径原样返回", () => {
    expect(shortenPath("/tmp/demo")).toBe("/tmp/demo");
    expect(shortenPath("a".repeat(24))).toBe("a".repeat(24));
  });

  it("超长路径保留前 10 后 8 字符并以省略号衔接", () => {
    const long = "/Users/demo/work/tianshu/src-react";
    const expected = `${long.slice(0, 10)}…${long.slice(-8)}`;
    expect(shortenPath(long)).toBe(expected);
  });

  it("省略结果固定为前 10 + 省略号 + 后 8 共 19 字符", () => {
    expect(shortenPath("x".repeat(100))).toHaveLength(19);
  });
});

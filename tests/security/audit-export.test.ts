import { describe, expect, it } from "vitest";
import { csvEscape } from "../../electron/domains/security/audit/audit-export";

describe("csvEscape", () => {
  it("普通字符串与数字原样输出", () => {
    expect(csvEscape("abc")).toBe("abc");
    expect(csvEscape(42)).toBe("42");
  });
  it("null 转空串", () => {
    expect(csvEscape(null)).toBe("");
  });
  it("含逗号/引号/换行时引号包裹、内部引号翻倍", () => {
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape("line\nbreak")).toBe('"line\nbreak"');
    expect(csvEscape("cr\rlf")).toBe('"cr\rlf"');
  });
});

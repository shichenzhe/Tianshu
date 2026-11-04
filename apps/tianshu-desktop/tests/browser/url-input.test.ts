import { describe, expect, it } from "vitest";
import {
  looksLikeUrl,
  resolveAddressInput,
} from "../../src-react/domains/ai/browser/lib/url-input";

describe("looksLikeUrl", () => {
  it.each([
    ["https://example.com", true],
    ["http://example.com/path?q=1", true],
    ["example.com", true],
    ["a.b", true],
    ["localhost", true],
    ["localhost:3000", true],
    ["127.0.0.1", true],
    ["127.0.0.1:8080/admin", true],
    ["file:///tmp/index.html", false], // 显式非 http(s) 协议头不按网址处理
    ["天枢 助手", false], // 含空格是搜索词形态
    ["怎么打开网站", false],
    ["a.", false], // 点后无内容
    [".b", false],
    ["", false],
    ["   ", false],
  ])("looksLikeUrl(%j) → %s", (input, expected) => {
    expect(looksLikeUrl(input)).toBe(expected);
  });
});

describe("resolveAddressInput", () => {
  it("裸域名补 https 前缀", () => {
    expect(resolveAddressInput("example.com")).toBe("https://example.com");
  });
  it("已有协议头原样返回", () => {
    expect(resolveAddressInput("http://example.com")).toBe(
      "http://example.com",
    );
  });
  it("非网址返回 null", () => {
    expect(resolveAddressInput("怎么打开网站")).toBeNull();
  });
  it("空输入返回 null", () => {
    expect(resolveAddressInput("  ")).toBeNull();
  });
});

import { describe, expect, it, vi } from "vitest";
// Task 3 起 browser-session 经 network-gate 传递依赖 Log（→ electron，
// app.getPath 在模块期求值）；照 renderer-guard.test 先例直接 mock Log
vi.mock("../../electron/commons/Log", () => ({
  default: { error: vi.fn() },
}));
import {
  CACHE_CLEAR_STORAGES,
  isSsrfHost,
  readClearDataType,
  sanitizeEmbedHeaders,
} from "../../electron/domains/ai/browser/browser-session";

describe("sanitizeEmbedHeaders", () => {
  it("mainFrame 剥 X-Frame-Options", () => {
    const out = sanitizeEmbedHeaders("mainFrame", {
      "X-Frame-Options": ["DENY"],
      "Content-Type": ["text/html"],
    });
    expect(out).toEqual({ "Content-Type": ["text/html"] });
  });
  it("subFrame 剥 CSP 的 frame-ancestors 指令、保留其余指令", () => {
    const out = sanitizeEmbedHeaders("subFrame", {
      "Content-Security-Policy": [
        "frame-ancestors 'none'; default-src https:; img-src 'self'",
      ],
    });
    expect(out["Content-Security-Policy"]).toEqual([
      "default-src https:; img-src 'self'",
    ]);
  });
  it("剥 CSP report-only 变体", () => {
    const out = sanitizeEmbedHeaders("mainFrame", {
      "Content-Security-Policy-Report-Only": ["frame-ancestors 'self'"],
    });
    expect(out).toEqual({});
  });
  it("CSP 全部指令都是 frame-ancestors 时删除该头", () => {
    const out = sanitizeEmbedHeaders("mainFrame", {
      "Content-Security-Policy": ["frame-ancestors *"],
    });
    expect(out).toEqual({});
  });
  it("非 frame 资源（xhr/image）原样返回", () => {
    const headers = {
      "X-Frame-Options": ["DENY"],
      "Content-Type": ["image/png"],
    };
    expect(sanitizeEmbedHeaders("image", headers)).toBe(headers);
  });
});

describe("sanitizeEmbedHeaders 边界（Task 2 review 补充）", () => {
  it("多值 CSP 数组仅剥含 frame-ancestors 的元素，其余元素整条保留", () => {
    const out = sanitizeEmbedHeaders("subFrame", {
      "Content-Security-Policy": [
        "default-src https:",
        "frame-ancestors 'none'",
      ],
    });
    expect(out).toEqual({ "Content-Security-Policy": ["default-src https:"] });
  });
  it("frame-ancestors 居中时前后指令保留原序", () => {
    const out = sanitizeEmbedHeaders("mainFrame", {
      "Content-Security-Policy": [
        "default-src https:; frame-ancestors 'none'; img-src 'self'",
      ],
    });
    expect(out).toEqual({
      "Content-Security-Policy": ["default-src https:; img-src 'self'"],
    });
  });
  it("小写头名（HTTP/2 风格）的 x-frame-options 同样剥", () => {
    const out = sanitizeEmbedHeaders("mainFrame", {
      "x-frame-options": ["deny"],
      "content-type": ["text/html"],
    });
    expect(out).toEqual({ "content-type": ["text/html"] });
  });
});

describe("isSsrfHost", () => {
  it.each([
    ["169.254.169.254", true],
    ["metadata.google.internal", true],
    ["metadata.azure.com", true],
    ["example.com", false],
    ["", false],
  ])("isSsrfHost(%j) → %s", (host, expected) => {
    expect(isSsrfHost(host)).toBe(expected);
  });
});

describe("readClearDataType", () => {
  it("合法两值透传", () => {
    expect(readClearDataType("cookies")).toBe("cookies");
    expect(readClearDataType("cache")).toBe("cache");
  });
  it("非法值抛错（fail-fast，不静默清错类型）", () => {
    expect(() => readClearDataType("history")).toThrow();
    expect(() => readClearDataType(null)).toThrow();
  });
});

describe("CACHE_CLEAR_STORAGES", () => {
  it("不含 cookies（登录态归 cookies 类型单独清）", () => {
    expect(CACHE_CLEAR_STORAGES).not.toContain("cookies");
  });
});

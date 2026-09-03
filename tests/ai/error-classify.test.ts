import { describe, expect, it } from "vitest";
import { classifyError } from "../../electron/domains/ai/chat/error-classify";

describe("错误分类", () => {
  it("401/403 → AUTH_FAILED", () => {
    expect(classifyError({ statusCode: 401 })).toBe("AUTH_FAILED");
    expect(classifyError({ statusCode: 403 })).toBe("AUTH_FAILED");
  });

  it("404 → MODEL_NOT_FOUND", () => {
    expect(classifyError({ statusCode: 404 })).toBe("MODEL_NOT_FOUND");
  });

  it("429 → RATE_LIMITED", () => {
    expect(classifyError({ statusCode: 429 })).toBe("RATE_LIMITED");
  });

  it("超时关键字 → TIMEOUT", () => {
    expect(classifyError(new Error("Request timed out"))).toBe("TIMEOUT");
  });

  it("fetch failed → NETWORK", () => {
    expect(classifyError(new TypeError("fetch failed"))).toBe("NETWORK");
  });

  it("其他 → UNKNOWN", () => {
    expect(classifyError(new Error("whatever"))).toBe("UNKNOWN");
    expect(classifyError("str")).toBe("UNKNOWN");
  });
});

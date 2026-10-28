/** SP5 移交：undici 策略拒绝文案在 error.cause（spec §6.1） */
import { describe, expect, it } from "vitest";
import { errorMessageWithCause } from "@/../electron/commons/error-message-with-cause";

describe("errorMessageWithCause", () => {
  it("cause 链逐层拼接（策略文案可见）", () => {
    const err = new Error("fetch failed", {
      cause: new Error("网络安全策略已拒绝 evil.com（规则：deny）"),
    });
    expect(errorMessageWithCause(err)).toContain("fetch failed");
    expect(errorMessageWithCause(err)).toContain("网络安全策略已拒绝 evil.com");
  });
  it("无 cause 仅顶层；非 Error 输入 String 化", () => {
    expect(errorMessageWithCause(new Error("boom"))).toBe("boom");
    expect(errorMessageWithCause("plain")).toBe("plain");
  });
});

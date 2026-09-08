/**
 * mapIpcError 错误码映射测试：
 * - 白名单内业务错误码 → chat:errors.* 文案（含 MESSAGE_NOT_FOUND）
 * - 未识别消息原样透传（如上游/系统错误）
 * - zh-CN / en-US 两个 locale 的 chat:errors 均含白名单键（双端同步防回归）
 */
import { describe, expect, it, vi } from "vitest";

// 隔离真实 i18n 初始化（LanguageDetector 读 localStorage 会触发 Node 的
// ExperimentalWarning）：t 以 key 加前缀返回，验证映射走向而非文案内容
vi.mock("@/i18n", () => ({
  default: { t: (key: string) => `mapped:${key}` },
}));

import { mapIpcError } from "../../src-react/domains/ai/chat/lib/error-message";
import zhChat from "../../src-react/i18n/locales/zh-CN/chat.json";
import enChat from "../../src-react/i18n/locales/en-US/chat.json";

describe("mapIpcError", () => {
  it("白名单业务错误码映射为 chat:errors.* 文案而非原码透传", () => {
    expect(mapIpcError(new Error("MESSAGE_NOT_FOUND"))).toBe(
      "mapped:chat:errors.MESSAGE_NOT_FOUND",
    );
    expect(mapIpcError(new Error("CONCURRENT_REQUEST"))).toBe(
      "mapped:chat:errors.CONCURRENT_REQUEST",
    );
  });

  it("非白名单消息原样透传", () => {
    expect(mapIpcError(new Error("Upstream boom"))).toBe("Upstream boom");
    expect(mapIpcError("plain string")).toBe("plain string");
  });

  it("zh-CN 与 en-US 的 chat:errors 均包含 MESSAGE_NOT_FOUND 文案", () => {
    expect(zhChat.errors.MESSAGE_NOT_FOUND).toBeTruthy();
    expect(enChat.errors.MESSAGE_NOT_FOUND).toBeTruthy();
  });
});

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
    // 图试运行中断竞态（运行历史弹窗 toast）：直显错误码对用户无意义
    expect(mapIpcError(new Error("GRAPH_NOT_RUNNING"))).toBe(
      "mapped:chat:errors.GRAPH_NOT_RUNNING",
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

  it("zh-CN 与 en-US 的 chat:errors 均包含 GRAPH_NOT_RUNNING 文案", () => {
    expect(zhChat.errors.GRAPH_NOT_RUNNING).toBeTruthy();
    expect(enChat.errors.GRAPH_NOT_RUNNING).toBeTruthy();
  });

  it("PATH_OUTSIDE_WORKSPACE（工作空间文件树沙箱越界）双端同步有文案", () => {
    expect(mapIpcError(new Error("PATH_OUTSIDE_WORKSPACE"))).toBe(
      "mapped:chat:errors.PATH_OUTSIDE_WORKSPACE",
    );
    expect(zhChat.errors.PATH_OUTSIDE_WORKSPACE).toBeTruthy();
    expect(enChat.errors.PATH_OUTSIDE_WORKSPACE).toBeTruthy();
  });

  it("聊天输出导出批错误码：exact 码直接映射，带尾参码（CODE: detail）前缀命中", () => {
    expect(mapIpcError(new Error("IMAGE_DATAURL_INVALID"))).toBe(
      "mapped:chat:errors.IMAGE_DATAURL_INVALID",
    );
    expect(mapIpcError(new Error("WIDGET_CAPTURE_RECT_INVALID"))).toBe(
      "mapped:chat:errors.WIDGET_CAPTURE_RECT_INVALID",
    );
    // media-export 抛带细节尾参：mime 名 / 字节数——前缀剥离后映射
    expect(
      mapIpcError(new Error("IMAGE_DATAURL_MIME_REJECTED: image/svg+xml")),
    ).toBe("mapped:chat:errors.IMAGE_DATAURL_MIME_REJECTED");
    expect(
      mapIpcError(new Error("IMAGE_DATAURL_TOO_LARGE: 999 > 10485760")),
    ).toBe("mapped:chat:errors.IMAGE_DATAURL_TOO_LARGE");
    // 前缀形近但不匹配（无 ": " 分隔）不误伤，原样透传
    expect(mapIpcError("IMAGE_DATAURL_MIME_REJECTEDX")).toBe(
      "IMAGE_DATAURL_MIME_REJECTEDX",
    );
  });

  it("导出批错误码 zh/en 双端同步有文案", () => {
    for (const code of [
      "IMAGE_DATAURL_INVALID",
      "IMAGE_DATAURL_MIME_REJECTED",
      "IMAGE_DATAURL_TOO_LARGE",
      "WIDGET_CAPTURE_RECT_INVALID",
      "MERMAID_PNG_RENDER_FAILED",
      "MERMAID_PNG_CANVAS_UNAVAILABLE",
    ]) {
      expect(zhChat.errors[code]).toBeTruthy();
      expect(enChat.errors[code]).toBeTruthy();
    }
  });
});

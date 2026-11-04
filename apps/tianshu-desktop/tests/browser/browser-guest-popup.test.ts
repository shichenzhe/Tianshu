import { beforeEach, describe, expect, it, vi } from "vitest";

// electron mock 照 browser-session-register.test 先例：fromPartition 返回
// 稳定实例（isBrowserGuestSession 用 === 比较）；app.on 捕获 handler 驱动
const partitionSession = vi.hoisted(() => ({}));
const otherSession = vi.hoisted(() => ({}));
const appOn = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({
  app: { on: appOn },
  session: {
    fromPartition: vi.fn((p: string) =>
      p === "persist:browser-webview" ? partitionSession : otherSession,
    ),
  },
  ipcMain: { handle: vi.fn() },
}));
// browser-session → network-gate → Log 模块期 app.getPath（electron mock 无
// 该函数），照 browser-session-register.test 先例直接 mock Log
vi.mock("../../electron/commons/Log", () => ({
  default: { error: vi.fn() },
}));

import { registerBrowserGuestPopupForwarding } from "../../electron/domains/ai/browser/browser-session";

/** 驱动 app.on 捕获的 web-contents-created handler；返回注册到的开窗
 *  拦截器（未注册时 null）与宿主 send spy */
function attachGuest(opts: { type: string; session: unknown }): {
  openHandler: ((d: { url: string }) => { action: string }) | null;
  send: ReturnType<typeof vi.fn>;
} {
  const captured: Array<(d: { url: string }) => { action: string }> = [];
  const send = vi.fn();
  const handler = appOn.mock.calls.find(
    ([event]: [string]) => event === "web-contents-created",
  )?.[1] as (e: unknown, contents: unknown) => void;
  expect(handler).toBeDefined();
  handler(undefined, {
    getType: () => opts.type,
    session: opts.session,
    hostWebContents: { send },
    setWindowOpenHandler: (fn: (d: { url: string }) => { action: string }) => {
      captured.push(fn);
    },
  });
  return { openHandler: captured[captured.length - 1] ?? null, send };
}

beforeEach(() => {
  vi.clearAllMocks();
  registerBrowserGuestPopupForwarding();
});

describe("registerBrowserGuestPopupForwarding", () => {
  it("browser partition 的 webview guest：deny + http url 转发宿主", () => {
    const { openHandler, send } = attachGuest({
      type: "webview",
      session: partitionSession,
    });
    expect(openHandler).not.toBeNull();
    const verdict = openHandler!({ url: "https://example.com/a" });
    expect(verdict).toEqual({ action: "deny" });
    expect(send).toHaveBeenCalledWith(
      "browser:openInNewTab",
      "https://example.com/a",
    );
  });

  it("非 http(s) 协议 deny 不转发（fail-closed）", () => {
    const { openHandler, send } = attachGuest({
      type: "webview",
      session: partitionSession,
    });
    expect(openHandler!({ url: "javascript:alert(1)" })).toEqual({
      action: "deny",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("非法 url deny 不转发", () => {
    const { openHandler, send } = attachGuest({
      type: "webview",
      session: partitionSession,
    });
    expect(openHandler!({ url: "http://[::1" })).toEqual({ action: "deny" });
    expect(send).not.toHaveBeenCalled();
  });

  it("非 webview 类型不注册拦截", () => {
    const { openHandler } = attachGuest({
      type: "window",
      session: partitionSession,
    });
    expect(openHandler).toBeNull();
  });

  it("非 browser partition 的 webview 不注册拦截（资料库等不受影响）", () => {
    const { openHandler } = attachGuest({
      type: "webview",
      session: otherSession,
    });
    expect(openHandler).toBeNull();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

// 控制器裁定 R2：mock 整个 network-gate 模块（原 brief 的 spyOn 写法会因
// getNetworkGate() 返回 null 崩溃），hoisted 的 judgeUrl/blockedAudit 供用例直驱
const judgeUrl = vi.hoisted(() => vi.fn());
const blockedAudit = vi.hoisted(() => vi.fn());
// 捕获 partition 上注册的 webRequest 回调，手动驱动断言
const registered = vi.hoisted(() => ({
  onBeforeRequest: [] as Array<(d: unknown, cb: (r: unknown) => void) => void>,
  onHeadersReceived: [] as Array<
    (d: unknown, cb: (r: unknown) => void) => void
  >,
}));
const partitionSession = vi.hoisted(() => ({
  webRequest: {
    onBeforeRequest: (
      _f: unknown,
      fn: (d: unknown, cb: (r: unknown) => void) => void,
    ) => {
      registered.onBeforeRequest.push(fn);
    },
    onHeadersReceived: (fn: (d: unknown, cb: (r: unknown) => void) => void) => {
      registered.onHeadersReceived.push(fn);
    },
  },
  clearStorageData: vi.fn(async () => {}),
  clearCache: vi.fn(async () => {}),
}));
vi.mock("electron", () => ({
  session: { fromPartition: vi.fn(() => partitionSession) },
  ipcMain: { handle: vi.fn() },
}));
// network-gate 依赖 Log（→ electron）；直接 mock Log 照 renderer-guard.test 先例
vi.mock("../../electron/commons/Log", () => ({
  default: { error: vi.fn() },
}));
vi.mock("../../electron/domains/security/network-gate", () => ({
  getNetworkGate: () => ({ judgeUrl, blockedAudit }),
}));

import { installBrowserSessionGuard } from "../../electron/domains/ai/browser/browser-session";

beforeEach(() => {
  registered.onBeforeRequest.length = 0;
  registered.onHeadersReceived.length = 0;
  vi.clearAllMocks();
  // hoisted mock 默认无返回值（undefined 走 !verdict.ok 分支会 TypeError），
  // 统一给放行默认值，拦截用例内逐个覆盖
  judgeUrl.mockReturnValue({ ok: true });
  installBrowserSessionGuard();
});

describe("installBrowserSessionGuard onBeforeRequest", () => {
  it("SSRF 主机取消", () => {
    const cb = vi.fn();
    registered.onBeforeRequest[0](
      { url: "http://169.254.169.254/latest/meta-data" },
      cb,
    );
    expect(cb).toHaveBeenCalledWith({ cancel: true });
  });
  it("gate 拦截时取消并审计 source=browser", () => {
    judgeUrl.mockReturnValue({
      ok: false,
      host: "evil.com",
      rule: "blacklist",
    });
    const cb = vi.fn();
    registered.onBeforeRequest[0]({ url: "https://evil.com/x" }, cb);
    expect(cb).toHaveBeenCalledWith({ cancel: true });
    expect(blockedAudit).toHaveBeenCalledWith(
      "evil.com",
      "blacklist",
      "browser",
    );
  });
  it("放行域直接过", () => {
    const cb = vi.fn();
    registered.onBeforeRequest[0]({ url: "https://example.com/" }, cb);
    expect(cb).toHaveBeenCalledWith({});
  });
});

describe("installBrowserSessionGuard onHeadersReceived", () => {
  it("经 sanitizeEmbedHeaders 剥 XFO 后回传", () => {
    const cb = vi.fn();
    registered.onHeadersReceived[0](
      {
        resourceType: "mainFrame",
        responseHeaders: { "X-Frame-Options": ["DENY"] },
      },
      cb,
    );
    expect(cb).toHaveBeenCalledWith({ responseHeaders: {} });
  });
});

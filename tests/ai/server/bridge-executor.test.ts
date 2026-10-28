// TB-T2 桥执行面（spec §4）：隐藏桥窗单例（mock BrowserWindow）上的
// browser 四工具执行 + write 审批门两态 + respond 回传通道 + ipc 接线。
// 终审补：桥窗加固面（弹窗 deny + 导航/重定向 SSRF 复查——F1）+ 入口
// requestId 去重（同请求多连接重复进入不双执行——Minor）。
// 工具函数复用 mirror agent/browser-tools.ts（GuestControl 注入式——
// resolver 返回桥窗，工具与定义一体经 makeBrowserTools 装配，见报告
// 接线方式裁定）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  executeJavaScript,
  loadURL,
  windowDestroy,
  constructed,
  setWindowOpenHandler,
  contentsOn,
} = vi.hoisted(() => ({
  executeJavaScript: vi.fn(),
  loadURL: vi.fn(),
  windowDestroy: vi.fn(),
  /** BrowserWindow 构造观测（vi.fn 箭头实现不可 new——类形态替身） */
  constructed: vi.fn(),
  /** webContents 加固面观测（终审 F1）：弹窗 handler 注册 + will-* 事件注册 */
  setWindowOpenHandler: vi.fn(),
  contentsOn: vi.fn(),
}));

vi.mock("electron", () => {
  /** BrowserWindow 假体：webContents 两能力 + isDestroyed/destroy（单例判活） */
  class FakeBrowserWindow {
    constructor(options?: unknown) {
      constructed(options);
    }
    webContents = {
      executeJavaScript: (code: string) => executeJavaScript(code),
      loadURL: (url: string) => loadURL(url),
      setWindowOpenHandler: (handler: unknown) => setWindowOpenHandler(handler),
      on: (name: string, handler: unknown) => contentsOn(name, handler),
    };
    isDestroyed = () => false;
    destroy = () => windowDestroy();
  }
  return {
    BrowserWindow: Object.assign(FakeBrowserWindow, {
      getAllWindows: vi.fn(() => []),
    }),
    ipcMain: { handle: vi.fn() },
    app: { isPackaged: false },
  };
});
vi.mock("../../../electron/commons/Log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// connections 链入 prisma-client（模块级 app.isPackaged + PrismaClient 建连）
// ——接线测试只需注册表类型面，option 三操作内存替身（connections.test 同款）
const prismaStub = vi.hoisted(() => ({
  option: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
}));
vi.mock("../../../electron/commons/prisma-client", () => ({
  default: prismaStub,
}));

import { ipcMain } from "electron";
import type { ConnectionRegistry } from "../../../electron/domains/server/connections";
import { registerServerIpc } from "../../../electron/domains/server/ipc";
import {
  BRIDGE_APPROVAL_TIMEOUT_MS,
  BridgeExecutor,
  bridgeExecutor,
  destroyBridgeWindow,
  handleBridgeToolRequest,
} from "../../../electron/domains/server/bridge-executor";
import type { ToolRequestPayload } from "@tianshu/protocol";

const SNAPSHOT_JSON = JSON.stringify({
  title: "示例页",
  url: "https://example.com/",
  items: [{ idx: 0, tag: "a", type: "", text: "链接", href: "/go" }],
  body: "正文摘要",
});

function snapshotRequest(requestId = "r1"): ToolRequestPayload {
  return { requestId, sessionId: 5, tool: "browser_snapshot", args: {} };
}

beforeEach(() => {
  executeJavaScript.mockReset().mockResolvedValue(SNAPSHOT_JSON);
  loadURL.mockReset().mockResolvedValue(undefined);
  windowDestroy.mockReset();
  constructed.mockClear();
  setWindowOpenHandler.mockReset();
  contentsOn.mockReset();
});

afterEach(() => {
  destroyBridgeWindow();
});

describe("BridgeExecutor", () => {
  it("read 直执：browser_snapshot 注入快照脚本，输出文本化，不经审批门", async () => {
    const pushApproval = vi.fn();
    const executor = new BridgeExecutor({ pushApproval });
    const result = await executor.execute(snapshotRequest());
    expect(result).toEqual({
      ok: true,
      output: expect.stringContaining("标题: 示例页"),
    });
    expect(result.ok && result.output).toContain("[可交互元素]");
    expect(executeJavaScript).toHaveBeenCalledTimes(1);
    // 快照脚本为 mirror 同款模板（SNAPSHOT_MARKER 识别锚）
    expect(executeJavaScript.mock.calls[0][0]).toContain("SNAPSHOT_MARKER");
    expect(pushApproval).not.toHaveBeenCalled();
  });

  it("navigate 直执：loadURL 收到目标地址（SSRF/协议校验工具内置）", async () => {
    const pushApproval = vi.fn();
    const executor = new BridgeExecutor({ pushApproval });
    const result = await executor.execute({
      requestId: "r2",
      sessionId: 5,
      tool: "browser_navigate",
      args: { url: "https://example.com/page" },
    });
    expect(loadURL).toHaveBeenCalledWith("https://example.com/page");
    expect(result).toEqual({ ok: true, output: expect.any(String) });
    expect(pushApproval).not.toHaveBeenCalled();
  });

  it("桥窗单例懒建：两次执行仅构造一次 BrowserWindow（show:false）", async () => {
    const executor = new BridgeExecutor({ pushApproval: vi.fn() });
    await executor.execute(snapshotRequest("a"));
    await executor.execute(snapshotRequest("b"));
    expect(constructed).toHaveBeenCalledTimes(1);
    expect(constructed.mock.calls[0][0]).toMatchObject({ show: false });
    // 退出收口销毁
    destroyBridgeWindow();
    expect(windowDestroy).toHaveBeenCalledTimes(1);
    // 销毁后下次使用重建（判活兜底）
    await executor.execute(snapshotRequest("c"));
    expect(constructed).toHaveBeenCalledTimes(2);
  });

  it("write 审批门（允许）：推 server:bridgeApproval 载荷 → decision 后才执行", async () => {
    const pushApproval = vi.fn();
    const executor = new BridgeExecutor({ pushApproval });
    executeJavaScript.mockResolvedValue("OK");
    const pending = executor.execute({
      requestId: "w1",
      sessionId: 5,
      tool: "browser_click",
      args: { idx: 2 },
    });
    // 审批未决：请求已推送但尚未注入点击脚本
    expect(pushApproval).toHaveBeenCalledWith({
      requestId: "w1",
      sessionId: 5,
      tool: "browser_click",
      args: { idx: 2 },
    });
    expect(executeJavaScript).not.toHaveBeenCalled();
    expect(executor.resolveDecision("w1", true)).toBe(true);
    await expect(pending).resolves.toEqual({ ok: true, output: "OK" });
    expect(executeJavaScript).toHaveBeenCalledTimes(1);
    // 点击脚本按快照序号定位（data-ts-ai 属性）
    expect(executeJavaScript.mock.calls[0][0]).toContain("data-ts-ai");
  });

  it("write 审批门（拒绝）：回 {ok:false,error:'denied by user'}，不执行", async () => {
    const pushApproval = vi.fn();
    const executor = new BridgeExecutor({ pushApproval });
    const pending = executor.execute({
      requestId: "w2",
      sessionId: 5,
      tool: "browser_type",
      args: { idx: 1, text: "你好" },
    });
    expect(pushApproval).toHaveBeenCalledTimes(1);
    expect(executor.resolveDecision("w2", false)).toBe(true);
    await expect(pending).resolves.toEqual({
      ok: false,
      error: "denied by user",
    });
    expect(executeJavaScript).not.toHaveBeenCalled();
  });

  it("审批超时（本地 30s 上限防悬空）：按拒绝收敛，decision 迟到不再受理", async () => {
    vi.useFakeTimers();
    try {
      const pushApproval = vi.fn();
      const executor = new BridgeExecutor({ pushApproval });
      const pending = executor.execute({
        requestId: "w3",
        sessionId: 5,
        tool: "browser_click",
        args: { idx: 0 },
      });
      vi.advanceTimersByTime(BRIDGE_APPROVAL_TIMEOUT_MS + 10);
      await expect(pending).resolves.toMatchObject({ ok: false });
      // 超时文案与显式拒绝（denied by user）区分（TB-T2 审查锚定）
      const timedOut = await pending;
      if (!timedOut.ok) {
        expect(timedOut.error).toContain("审批超时");
      }
      expect(executeJavaScript).not.toHaveBeenCalled();
      // 超时已收敛：迟到的应答未知 requestId（渲染层据此示 stale）
      expect(executor.resolveDecision("w3", true)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("未知桥工具名：可读错误回传（防协议漂移面）", async () => {
    const executor = new BridgeExecutor({ pushApproval: vi.fn() });
    const result = await executor.execute({
      requestId: "x1",
      sessionId: 5,
      tool: "browser_unknown" as ToolRequestPayload["tool"],
      args: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("browser_unknown");
  });
});

describe("桥窗加固（终审 F1：弹窗 deny + 导航/重定向复查）", () => {
  /** 取捕获的 webContents.on 注册 handler（按事件名） */
  function registeredNavHandler(
    name: string,
  ): (event: { preventDefault: () => void }, url: string) => void {
    const call = contentsOn.mock.calls.find(([n]) => n === name);
    return call?.[1] as (
      event: { preventDefault: () => void },
      url: string,
    ) => void;
  }

  /** 建窗（懒建）触发加固面注册 */
  async function primeWindow(): Promise<void> {
    const executor = new BridgeExecutor({ pushApproval: vi.fn() });
    await executor.execute(snapshotRequest("harden"));
  }

  it("弹窗一律 deny：setWindowOpenHandler 注册且 handler 返回 {action:'deny'}", async () => {
    await primeWindow();
    expect(setWindowOpenHandler).toHaveBeenCalledTimes(1);
    const handler = setWindowOpenHandler.mock.calls[0][0] as (details: {
      url: string;
    }) => { action: string };
    expect(handler({ url: "https://phish.example.com/" })).toEqual({
      action: "deny",
    });
  });

  it("will-redirect 复查：重定向落 SSRF 封锁地址被 preventDefault，阻断后 loadURL 拒绝转可读错误回传", async () => {
    await primeWindow();
    const handler = registeredNavHandler("will-redirect");
    expect(handler).toBeDefined();
    const blocked = vi.fn();
    handler({ preventDefault: blocked }, "http://169.254.169.254/latest/");
    expect(blocked).toHaveBeenCalledTimes(1);
    // 公网重定向不误伤
    const benign = vi.fn();
    handler({ preventDefault: benign }, "https://example.com/next");
    expect(benign).not.toHaveBeenCalled();
    // 在途 302 被阻断 → loadURL Promise 以裸 ERR_ABORTED 拒绝（Electron
    // preventDefault 语义）→ 包装层转带原因可读错误，navigate 工具收
    // 「导航失败: …」文案（工具层错误结果，回传 server 回喂模型）
    loadURL.mockImplementation(async () => {
      handler({ preventDefault: blocked }, "http://169.254.169.254/latest/");
      throw new Error("ERR_ABORTED");
    });
    const executor = new BridgeExecutor({ pushApproval: vi.fn() });
    const result = await executor.execute({
      requestId: "harden-r",
      sessionId: 5,
      tool: "browser_navigate",
      args: { url: "https://example.com/redir" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain("导航被桥窗安全门阻断");
      expect(result.output).toContain("169.254.169.254");
    }
  });

  it("will-navigate 复查：非 http(s)/封锁地址/非法 URL 被阻断，http(s) 公网放行", async () => {
    await primeWindow();
    const handler = registeredNavHandler("will-navigate");
    expect(handler).toBeDefined();
    const blocked = vi.fn();
    handler({ preventDefault: blocked }, "file:///etc/passwd");
    handler({ preventDefault: blocked }, "http://metadata.google.internal/");
    handler({ preventDefault: blocked }, "::not-a-url::");
    expect(blocked).toHaveBeenCalledTimes(3);
    handler({ preventDefault: blocked }, "https://example.com/page");
    expect(blocked).toHaveBeenCalledTimes(3);
  });
});

describe("handleBridgeToolRequest（respond 回传通道）", () => {
  it("执行结果经 registry.request POST tool/respond（requestId+result 载荷）", async () => {
    const request = vi.fn().mockResolvedValue({ status: 200, body: {} });
    handleBridgeToolRequest({ request }, "conn-1", snapshotRequest("rr-1"));
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("conn-1", "POST", "tool/respond", {
        requestId: "rr-1",
        result: { ok: true, output: expect.stringContaining("示例页") },
      }),
    );
  });

  it("requestId 入口去重（终审 Minor）：同请求多连接重复进入仅首次执行+应答一次", async () => {
    const request = vi.fn().mockResolvedValue({ status: 200, body: {} });
    handleBridgeToolRequest({ request }, "conn-1", snapshotRequest("dup-1"));
    handleBridgeToolRequest({ request }, "conn-2", snapshotRequest("dup-1"));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(executeJavaScript).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe("conn-1");
  });

  it("requestId 完成后清理：不阻塞下一轮同 id 请求", async () => {
    const request = vi.fn().mockResolvedValue({ status: 200, body: {} });
    handleBridgeToolRequest({ request }, "conn-1", snapshotRequest("dup-2"));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    handleBridgeToolRequest({ request }, "conn-1", snapshotRequest("dup-2"));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(executeJavaScript).toHaveBeenCalledTimes(2);
  });

  it("模块单例可执行（缺省装配路径可用）", async () => {
    const result = await bridgeExecutor.execute(snapshotRequest("solo"));
    expect(result).toMatchObject({ ok: true });
  });
});

describe("ipc 接线（eventSink 路由 + decision handler）", () => {
  /** 注册表替身：捕获 eventSink + request 观测 respond 通道 */
  function stubRegistry(): {
    registry: ConnectionRegistry;
    setEventSink: ReturnType<typeof vi.fn>;
    request: ReturnType<typeof vi.fn>;
  } {
    const setEventSink = vi.fn();
    const request = vi.fn().mockResolvedValue({ status: 200, body: {} });
    return {
      registry: { setEventSink, request } as unknown as ConnectionRegistry,
      setEventSink,
      request,
    };
  }

  it("eventSink 过滤 tool.request → 执行 → POST tool/respond（read 直执）", async () => {
    const { registry, setEventSink, request } = stubRegistry();
    registerServerIpc(registry);
    const sink = setEventSink.mock.calls[0][0] as (
      connId: string,
      event: unknown,
    ) => void;
    sink("conn-9", {
      type: "tool.request",
      payload: snapshotRequest("ipc-1"),
    });
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("conn-9", "POST", "tool/respond", {
        requestId: "ipc-1",
        result: { ok: true, output: expect.any(String) },
      }),
    );
  });

  it("write 经 decision handler 应答链：审批未决无 respond → 允许后执行并回传", async () => {
    const { registry, setEventSink, request } = stubRegistry();
    registerServerIpc(registry);
    const sink = setEventSink.mock.calls[0][0] as (
      connId: string,
      event: unknown,
    ) => void;
    executeJavaScript.mockResolvedValue("OK");
    sink("conn-9", {
      type: "tool.request",
      payload: {
        requestId: "ipc-w",
        sessionId: 5,
        tool: "browser_click",
        args: { idx: 1 },
      },
    });
    // 审批未决：无 respond（等待渲染层 decision）
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(request).not.toHaveBeenCalled();
    const decision = vi
      .mocked(ipcMain.handle)
      .mock.calls.filter(([channel]) => channel === "server:bridgeDecision")
      .pop();
    expect(decision).toBeDefined();
    const resolved = await decision![1]({} as never, {
      requestId: "ipc-w",
      approved: true,
    });
    expect(resolved).toBe(true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0]).toEqual([
      "conn-9",
      "POST",
      "tool/respond",
      { requestId: "ipc-w", result: { ok: true, output: "OK" } },
    ]);
  });
});

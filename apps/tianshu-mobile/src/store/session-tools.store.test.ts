import { beforeEach, describe, expect, it, vi } from "vitest";

// —— connections 层替身（AsyncStorage 链不可在 node 加载；transport 由
//  各用例显式注入本 store 方法，替身只兜缺省出口）——
const connMock = vi.hoisted(() => ({
  activeTransport: vi.fn(() => null),
}));
vi.mock("./connections.store", () => ({
  activeTransport: connMock.activeTransport,
}));

import { ENDPOINTS } from "@tianshu/protocol";

import { POLISH_STYLE, useSessionToolsStore } from "./session-tools.store";
import type { Transport } from "../transport/types";

/** 伪 transport：只需 request（vi.fn 保持 mock API 可见） */
function makeTransport() {
  return { request: vi.fn() } as unknown as Transport & {
    request: ReturnType<typeof vi.fn>;
  };
}

function ok(data: unknown) {
  return {
    status: 200,
    body: { code: "2000", success: true, data, message: "success" },
  };
}

function biz(message: string) {
  return {
    status: 200,
    body: { code: "5000", success: false, data: null, message },
  };
}

beforeEach(() => {
  useSessionToolsStore.setState({ compacting: false, polishing: false });
});

describe("compact（A9 阶段 2）", () => {
  it("端点映射：POST session/compact + {sessionId} 载荷", async () => {
    const transport = makeTransport();
    transport.request.mockResolvedValue(ok(null));
    const accepted = await useSessionToolsStore
      .getState()
      .compact(7, transport);
    expect(accepted).toBe(true);
    expect(transport.request).toHaveBeenCalledWith("POST", "session/compact", {
      sessionId: 7,
    });
    expect(ENDPOINTS.session.compact).toBe("session/compact");
  });

  it("业务错返回 false（调用方提示，不抛）", async () => {
    const transport = makeTransport();
    transport.request.mockResolvedValue(biz("SESSION_NOT_FOUND"));
    expect(await useSessionToolsStore.getState().compact(7, transport)).toBe(
      false,
    );
  });

  it("网络层异常返回 false", async () => {
    const transport = makeTransport();
    transport.request.mockRejectedValue(new Error("socket closed"));
    expect(await useSessionToolsStore.getState().compact(7, transport)).toBe(
      false,
    );
  });

  it("compacting 进行中拒绝并发（防重复点）", async () => {
    const transport = makeTransport();
    transport.request.mockResolvedValue(ok(null));
    useSessionToolsStore.setState({ compacting: true });
    expect(await useSessionToolsStore.getState().compact(7, transport)).toBe(
      false,
    );
    expect(transport.request).not.toHaveBeenCalled();
  });
});

describe("polish（A9 阶段 3）", () => {
  it("端点映射：POST session/polish + {text,style,workspaceId} 载荷", async () => {
    const transport = makeTransport();
    transport.request.mockResolvedValue(ok({ text: "润色后文本" }));
    const r = await useSessionToolsStore
      .getState()
      .polish("草稿", 3, transport);
    expect(r).toEqual({ ok: true, text: "润色后文本" });
    expect(transport.request).toHaveBeenCalledWith("POST", "session/polish", {
      text: "草稿",
      style: POLISH_STYLE,
      workspaceId: 3,
    });
    expect(ENDPOINTS.session.polish).toBe("session/polish");
    expect(POLISH_STYLE).toBe("professional");
  });

  it("workspaceId 为 null 时不带该字段（载荷可选语义）", async () => {
    const transport = makeTransport();
    transport.request.mockResolvedValue(ok({ text: "x" }));
    await useSessionToolsStore.getState().polish("草稿", null, transport);
    expect(transport.request).toHaveBeenCalledWith("POST", "session/polish", {
      text: "草稿",
      style: "professional",
    });
  });

  it("成功返回润色文本（调用方据此替换草稿）", async () => {
    const transport = makeTransport();
    transport.request.mockResolvedValue(ok({ text: "更专业的表述" }));
    const r = await useSessionToolsStore
      .getState()
      .polish("粗糙草稿", 1, transport);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("更专业的表述");
  });

  it("失败不动草稿语义：ok=false 且不带替换文本", async () => {
    const transport = makeTransport();
    transport.request.mockResolvedValue(biz("模型调用超时"));
    const r = await useSessionToolsStore
      .getState()
      .polish("原草稿", 1, transport);
    expect(r).toEqual({ ok: false, message: "模型调用超时" });
  });

  it("网络层异常失败（空文案，调用方兜底 i18n 提示）", async () => {
    const transport = makeTransport();
    transport.request.mockRejectedValue(new Error("timeout"));
    const r = await useSessionToolsStore
      .getState()
      .polish("原草稿", 1, transport);
    expect(r).toEqual({ ok: false, message: "" });
  });

  it("回包缺 text 字段视为失败（草稿不动）", async () => {
    const transport = makeTransport();
    transport.request.mockResolvedValue(ok({}));
    const r = await useSessionToolsStore
      .getState()
      .polish("原草稿", 1, transport);
    expect(r.ok).toBe(false);
  });

  it("polishing 进行中拒绝并发（防重复点）", async () => {
    const transport = makeTransport();
    transport.request.mockResolvedValue(ok({ text: "x" }));
    useSessionToolsStore.setState({ polishing: true });
    const r = await useSessionToolsStore
      .getState()
      .polish("草稿", null, transport);
    expect(r).toEqual({ ok: false, message: "" });
    expect(transport.request).not.toHaveBeenCalled();
  });
});

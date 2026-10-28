import { beforeEach, describe, expect, it, vi } from "vitest";

import { wireRequest } from "./wire";
import type { Transport, TransportRequestResult } from "./types";

// —— AsyncStorage 内存替身（经 wire → connections.store 传递 import；node
// vitest 环境无 RN 原生模块，照 connections.store.test.ts 做法） ——
vi.mock("@react-native-async-storage/async-storage", () => {
  const storage = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        storage.set(key, value);
        return Promise.resolve();
      }),
    },
  };
});

// —— transport 工厂替身：阻断 connections.store → connection → direct/relay
// → expo/fetch → react-native（Flow 语法 node 环境不可解析）的传递链，
// 照 connections.store.test.ts 做法 ——
vi.mock("./direct-transport", () => ({ createDirectTransport: vi.fn() }));
vi.mock("./relay-transport", () => ({ createRelayTransport: vi.fn() }));

/** 假 Transport：request 返回固定结果 / 抛错，订阅面全空实现 */
function fakeTransport(
  respond: () => Promise<TransportRequestResult>,
): Transport {
  return {
    request: () => respond(),
    onEvent: () => () => {},
    onState: () => () => {},
    close: () => {},
  };
}

const okBody = (data: unknown): TransportRequestResult => ({
  status: 200,
  body: { code: "2000", success: true, data, message: "success" },
});

describe("wireRequest wire 判别", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("success:true 透传 data", async () => {
    const r = await wireRequest(
      "POST",
      "session/approve",
      { sessionId: 1 },
      fakeTransport(async () => okBody({ responded: true })),
    );
    expect(r).toEqual({ ok: true, data: { responded: true } });
  });

  it("业务错（HTTP 200 + success:false）保留 code/message（4040 审批已应答）", async () => {
    const r = await wireRequest(
      "POST",
      "session/approve",
      { sessionId: 1 },
      fakeTransport(async () => ({
        status: 200,
        body: { code: "4040", success: false, data: null, message: "审批不存在或已应答" },
      })),
    );
    expect(r).toEqual({ ok: false, code: "4040", message: "审批不存在或已应答", status: 200 });
  });

  it("非对象 body / request 抛错 / 无 transport 均归网络层失败（code 空串）", async () => {
    const nullBody = await wireRequest(
      "POST",
      "image",
      { path: "a.png" },
      fakeTransport(async () => ({ status: 0, body: null })),
    );
    expect(nullBody).toEqual({ ok: false, code: "", message: "", status: 0 });

    const rejected = await wireRequest(
      "GET",
      "info",
      undefined,
      fakeTransport(async () => {
        throw new Error("fetch failed");
      }),
    );
    expect(rejected).toEqual({ ok: false, code: "", message: "" });

    const noTransport = await wireRequest("GET", "info", undefined, null);
    expect(noTransport).toEqual({ ok: false, code: "", message: "" });
  });

  it("success 字段缺失或非 true 按业务错处理（message 缺省空串）", async () => {
    const r = await wireRequest(
      "POST",
      "image",
      { path: "a.png" },
      fakeTransport(async () => ({ status: 200, body: {} })),
    );
    expect(r).toEqual({ ok: false, code: "", message: "", status: 200 });
  });
});

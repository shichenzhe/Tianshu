/**
 * relay-transport e2e 状态机单测（安全批 H）：移动端控制端握手/信封/
 * 降级/终局语义，蓝本 mirror electron/domains/server/relay-transport.ts
 * （E2E-T3）。被控端侧用 node 原实现（packages/tianshu-core e2e-crypto）
 * 扮演——顺带再次锁定 wire 互操作。WebSocket 以 FakeWebSocket 替身
 * （RN 全局 WebSocket 形态子集：onopen/onmessage/onclose + send/close）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as nodeE2E from "../../../../packages/tianshu-core/src/e2e-crypto";

vi.mock("expo-crypto", () => {
  const { webcrypto } = require("node:crypto");
  return {
    getRandomValues: (arr: Uint8Array): Uint8Array => {
      webcrypto.getRandomValues(arr);
      return arr;
    },
    getRandomBytes: (n: number): Uint8Array =>
      webcrypto.getRandomValues(new Uint8Array(n)),
  };
});

/** RN WebSocket 替身：记录出站帧，允许测试注入服务端帧/生命周期事件 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code?: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.onclose?.({ code: 1000 });
  }

  /** 测试辅助：服务端推帧 */
  push(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  frames(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

import {
  createRelayTransport,
  type RelayConfig,
} from "./relay-transport";
import type { TransportState } from "./types";

const CONNECTION_ID = "instance-e2e-1";
const HANDSHAKE_MS = 40;

function baseConfig(over: Partial<RelayConfig> = {}): RelayConfig {
  return {
    relayUrl: "ws://127.0.0.1:8411/ws",
    relayToken: "tok",
    connectionId: CONNECTION_ID,
    e2eHandshakeTimeoutMs: HANDSHAKE_MS,
    ...over,
  };
}

/** 被控端（node 原实现）扮演：静态对 + server 会话 + hello 处理 */
function makeServerEnd(helloFrame: { ephemeralKey: string }) {
  const staticPair = nodeE2E.generateStaticPair();
  const fingerprint = nodeE2E.fingerprintOf(staticPair.publicKey);
  const session = nodeE2E.createE2ESession(
    nodeE2E.deriveSessionKeys({
      ephemeralPublicKey: Buffer.from(helloFrame.ephemeralKey, "base64"),
      staticPrivateKey: staticPair.privateKey,
      connectionId: CONNECTION_ID,
    }),
    "server",
  );
  return {
    ackFrame: {
      kind: "e2e-ack",
      staticKey: staticPair.publicKey.toString("base64"),
      fingerprint,
    },
    session,
    fingerprint,
  };
}

describe("relay-transport e2e（控制端状态机）", () => {
  let states: TransportState[];

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    states = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function trackStates(t: ReturnType<typeof createRelayTransport>): void {
    t.onState((s) => states.push(s));
  }

  it("握手成功 → encrypted；业务帧双向走信封；TOFU 指纹上报", async () => {
    const pinned = vi.fn();
    const t = createRelayTransport(baseConfig({ onFingerprintPinned: pinned }));
    trackStates(t);
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.onopen?.();

    // open 配对后即发 e2e-hello（临时公钥 base64）
    const frames = ws.frames();
    expect(frames[0]).toMatchObject({ kind: "open", connectionId: CONNECTION_ID });
    expect(frames[1]).toMatchObject({ kind: "e2e-hello" });
    const hello = frames[1] as { ephemeralKey: string };

    const serverEnd = makeServerEnd(hello);
    ws.push(serverEnd.ackFrame);
    await Promise.resolve();
    expect(states).toContain("encrypted");

    // request 出站为密文信封；被控端解得明文 req 并密文回 res
    const reqPromise = t.request("GET", "info");
    await Promise.resolve();
    const outbound = ws.frames().at(-1) as { kind: string; n: string; ct: string };
    expect(outbound.kind).toBe("e2e-secure");
    const inner = JSON.parse(
      serverEnd.session.open(outbound as never).toString("utf8"),
    );
    expect(inner).toMatchObject({ kind: "req", method: "GET" });
    ws.push(serverEnd.session.seal(JSON.stringify({ kind: "res", id: inner.id, status: 200, body: { ok: true } })));
    const res = await reqPromise;
    expect(res.status).toBe(200);

    // TOFU：config 未带指纹 → ack 指纹上报（注册表回填用）
    expect(pinned).toHaveBeenCalledWith(serverEnd.fingerprint);
    t.close();
  });

  it("指纹不匹配（已存指纹 vs ack 实际）→ mitm-suspect 终局断链不重连", async () => {
    const t = createRelayTransport(
      baseConfig({ fingerprint: "0000111122223333" }),
    );
    trackStates(t);
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.onopen?.();
    const hello = ws.frames()[1] as { ephemeralKey: string };
    ws.push(makeServerEnd(hello).ackFrame);
    await Promise.resolve();
    expect(states).toContain("mitm-suspect");
    expect(ws.closed).toBe(true);
    // 终局粘滞：close 事件不触发重连（无新 WebSocket 实例）
    const count = FakeWebSocket.instances.length;
    await new Promise((r) => setTimeout(r, 10));
    expect(FakeWebSocket.instances.length).toBe(count);
    t.close();
  });

  it("auto 模式握手超时 → 重发 open 降级明文；业务帧明文直发", async () => {
    const t = createRelayTransport(baseConfig());
    trackStates(t);
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.onopen?.();
    // 无 ack，等超时
    await new Promise((r) => setTimeout(r, HANDSHAKE_MS + 30));
    const frames = ws.frames();
    // open 降级重发（第二帧 hello、第三帧 open）
    expect(frames[2]).toMatchObject({ kind: "open" });
    // 降级后业务帧明文（synthConnected 的 info req 已占 id——按最后出站 req 配对）
    const reqPromise = t.request("GET", "info");
    await Promise.resolve();
    const lastReq = ws.frames().at(-1) as { kind: string; id: number; method: string };
    expect(lastReq).toMatchObject({ kind: "req", method: "GET" });
    ws.push({ kind: "res", id: lastReq.id, status: 200, body: null });
    const res = await reqPromise;
    expect(res.status).toBe(200);
    expect(states).not.toContain("encrypted");
    t.close();
  });

  it("required 模式握手超时 → 拒降级断链 required-failed 终局", async () => {
    const t = createRelayTransport(baseConfig({ e2eMode: "required" }));
    trackStates(t);
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.onopen?.();
    await new Promise((r) => setTimeout(r, HANDSHAKE_MS + 30));
    expect(states).toContain("required-failed");
    expect(ws.closed).toBe(true);
    const count = FakeWebSocket.instances.length;
    await new Promise((r) => setTimeout(r, 10));
    expect(FakeWebSocket.instances.length).toBe(count);
    t.close();
  });

  it("会话建立后明文业务帧（注入）→ 断链重连换新协商", async () => {
    const t = createRelayTransport(baseConfig());
    trackStates(t);
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.onopen?.();
    const hello = ws.frames()[1] as { ephemeralKey: string };
    ws.push(makeServerEnd(hello).ackFrame);
    await Promise.resolve();
    expect(states).toContain("encrypted");
    // 注入明文 res（应密文）→ 断链 + backoff 后重连新实例（换新协商）
    ws.push({ kind: "res", id: 9, status: 200, body: null });
    await new Promise((r) => setTimeout(r, 5));
    expect(ws.closed).toBe(true);
    // 首次退避 1s：推进后新 WebSocket 实例出现（新连接新协商）
    await new Promise((r) => setTimeout(r, 1_100));
    expect(FakeWebSocket.instances.length).toBeGreaterThan(1);
    t.close();
  });

  it("解封失败（篡改信封）→ 断链重连", async () => {
    const t = createRelayTransport(baseConfig());
    trackStates(t);
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.onopen?.();
    const hello = ws.frames()[1] as { ephemeralKey: string };
    ws.push(makeServerEnd(hello).ackFrame);
    await Promise.resolve();
    // 篡改密文
    const bad = { kind: "e2e-secure", n: "AAAAAAAAAAAAAAAA", ct: "AAAA" };
    ws.push(bad);
    await new Promise((r) => setTimeout(r, 5));
    expect(ws.closed).toBe(true);
    await new Promise((r) => setTimeout(r, 1_100));
    expect(FakeWebSocket.instances.length).toBeGreaterThan(1);
    t.close();
  });

  it("加密会话中 ping 恒明文：入站 ping 回明文 pong", async () => {
    const t = createRelayTransport(baseConfig());
    trackStates(t);
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.onopen?.();
    const hello = ws.frames()[1] as { ephemeralKey: string };
    ws.push(makeServerEnd(hello).ackFrame);
    await Promise.resolve();
    const before = ws.sent.length;
    ws.push({ kind: "ping" });
    expect(ws.frames().at(-1)).toEqual({ kind: "pong" });
    expect(ws.sent.length).toBe(before + 1);
    t.close();
  });
});

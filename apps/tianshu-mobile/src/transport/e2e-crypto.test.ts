/**
 * 移动端 e2e-crypto 单测（安全批 H：relay e2e 接入）：
 * 1. 字节级 wire 兼容——与本仓 packages/tianshu-core/src/e2e-crypto.ts
 *    （node:crypto 原实现）交叉向量：双端各自生成密钥对、互补半区派生
 *    会话密钥、双向信封互解互验（桌面被控端 ↔ 移动控制端真实互操作面）；
 * 2. 指纹一致（同公钥两实现同 hex16）；
 * 3. 重放/篡改/跨方向防护（本实现单侧语义，与 core 版对齐）。
 * expo-crypto 在 node 测试环境以 node:crypto 替身注入。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import * as nodeE2E from "../../../../packages/tianshu-core/src/e2e-crypto";
import {
  createE2ESession,
  deriveSessionKeys,
  fingerprintOf,
  generateEphemeralPair,
} from "./e2e-crypto";

const CONNECTION_ID = "instance-abc-123";

function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

describe("mobile e2e-crypto（@noble 实现，wire 兼容 node:crypto 原实现）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("交叉向量：互补半区派生一致密钥；mobile(client) seal ↔ node(server) open 往返", () => {
    // node 侧扮演被控端（静态对）；mobile 侧扮演控制端（临时对）
    const staticPair = nodeE2E.generateStaticPair();
    const ephemeralPair = generateEphemeralPair();

    const mobileKeys = deriveSessionKeys({
      ephemeralPrivateKey: ephemeralPair.privateKey,
      staticPublicKey: new Uint8Array(staticPair.publicKey),
      connectionId: CONNECTION_ID,
    });
    const nodeKeys = nodeE2E.deriveSessionKeys({
      ephemeralPublicKey: Buffer.from(ephemeralPair.publicKey),
      staticPrivateKey: staticPair.privateKey,
      connectionId: CONNECTION_ID,
    });
    expect(toB64(mobileKeys.clientToServer)).toBe(
      nodeKeys.clientToServer.toString("base64"),
    );
    expect(toB64(mobileKeys.serverToClient)).toBe(
      nodeKeys.serverToClient.toString("base64"),
    );

    const mobileSession = createE2ESession(mobileKeys, "client");
    const nodeSession = nodeE2E.createE2ESession(nodeKeys, "server");

    // mobile → node（c2s 方向）
    const outbound = mobileSession.seal(JSON.stringify({ kind: "req", id: 1 }));
    expect(outbound.kind).toBe("e2e-secure");
    const opened = nodeSession.open(outbound);
    expect(JSON.parse(opened.toString("utf8"))).toEqual({ kind: "req", id: 1 });

    // node → mobile（s2c 方向）
    const inbound = nodeSession.seal(JSON.stringify({ kind: "res", id: 1 }));
    const mobileOpened = mobileSession.open(inbound);
    expect(JSON.parse(Buffer.from(mobileOpened).toString("utf8"))).toEqual({
      kind: "res",
      id: 1,
    });
  });

  it("指纹一致：同公钥两实现同 hex16；base64 字符串入参同结果", () => {
    const pair = generateEphemeralPair();
    expect(fingerprintOf(pair.publicKey)).toBe(
      nodeE2E.fingerprintOf(Buffer.from(pair.publicKey)),
    );
    expect(fingerprintOf(toB64(pair.publicKey))).toBe(
      nodeE2E.fingerprintOf(Buffer.from(pair.publicKey)),
    );
    expect(fingerprintOf(pair.publicKey)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("篡改信封认证失败抛错；跨方向密文互不可解", () => {
    const keys = deriveSessionKeys({
      ephemeralPrivateKey: generateEphemeralPair().privateKey,
      staticPublicKey: generateEphemeralPair().publicKey,
      connectionId: CONNECTION_ID,
    });
    const client = createE2ESession(keys, "client");
    const server = createE2ESession(keys, "server");

    const envelope = client.seal("payload-x");
    // 篡改密文尾字节（tag 区）
    const raw = Buffer.from(envelope.ct, "base64");
    raw[raw.length - 1] ^= 0xff;
    expect(() =>
      server.open({ ...envelope, ct: raw.toString("base64") }),
    ).toThrow();
  });

  it("重放同信封被拒；乱序窗口内补投被收", () => {
    const keys = deriveSessionKeys({
      ephemeralPrivateKey: generateEphemeralPair().privateKey,
      staticPublicKey: generateEphemeralPair().publicKey,
      connectionId: CONNECTION_ID,
    });
    const sender = createE2ESession(keys, "client");
    const receiver = createE2ESession(keys, "server");

    const first = sender.seal("frame-1");
    expect(Buffer.from(receiver.open(first)).toString("utf8")).toBe("frame-1");
    // 同信封重放 → 拒
    expect(() => receiver.open(first)).toThrow();
    // 新帧照常（重放拒不污染后续）
    expect(
      Buffer.from(receiver.open(sender.seal("frame-2"))).toString("utf8"),
    ).toBe("frame-2");
  });

  it("nonce 前缀钉住：同会话内对端换前缀（跨方向/陈旧会话注入）被拒", () => {
    const keys = deriveSessionKeys({
      ephemeralPrivateKey: generateEphemeralPair().privateKey,
      staticPublicKey: generateEphemeralPair().publicKey,
      connectionId: CONNECTION_ID,
    });
    const senderA = createE2ESession(keys, "client");
    const receiver = createE2ESession(keys, "server");
    // 首帧钉住 senderA 的 nonce 前缀
    expect(
      Buffer.from(receiver.open(senderA.seal("first"))).toString("utf8"),
    ).toBe("first");
    // 另一会话实例（同 keys、不同随机前缀——跨方向/陈旧会话形态）
    const senderB = createE2ESession(keys, "client");
    expect(() => receiver.open(senderB.seal("inject"))).toThrow(
      /nonce prefix mismatch/,
    );
  });

  it("畸形信封拒收（kind/形状/base64/nonce 长度）", () => {
    const keys = deriveSessionKeys({
      ephemeralPrivateKey: generateEphemeralPair().privateKey,
      staticPublicKey: generateEphemeralPair().publicKey,
      connectionId: CONNECTION_ID,
    });
    const receiver = createE2ESession(keys, "server");
    expect(() => receiver.open({ kind: "req" } as never)).toThrow();
    expect(() =>
      receiver.open({ kind: "e2e-secure", n: "!!!", ct: "abc" }),
    ).toThrow();
    expect(() =>
      receiver.open({ kind: "e2e-secure", n: toB64(new Uint8Array(3)), ct: toB64(new Uint8Array(32)) }),
    ).toThrow();
  });

  it("低阶公钥（全零静态公钥）派生拒绝", () => {
    expect(() =>
      deriveSessionKeys({
        ephemeralPrivateKey: generateEphemeralPair().privateKey,
        staticPublicKey: new Uint8Array(32),
        connectionId: CONNECTION_ID,
      }),
    ).toThrow();
  });
});

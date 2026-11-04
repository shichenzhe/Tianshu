// E2E-T1 relay 端到端加密核心模块测试（spec：docs/superpowers/specs/
// 2026-10-18-relay-e2e-design.md §2 密钥模型/握手帧/信封 + §3.1）。
// 覆盖：往返/篡改拒/重放窗口边界（64 内拒+低于下沿拒）/跨方向隔离/
// 指纹稳定/HKDF 双向不同/低阶公钥拒/静态序列化往返。
// 经 "@tianshu/core" 聚合入口 import——顺带钉住 vitest alias 与
// packages/tianshu-core/src/index.ts 收编（对齐 core-package.test.ts 先例）。
import { describe, expect, it, vi } from "vitest";
import {
  createE2ESession,
  deriveSessionKeys,
  E2E_HANDSHAKE_ACK,
  E2E_HANDSHAKE_HELLO,
  E2E_SECURE_KIND,
  fingerprintOf,
  generateEphemeralPair,
  generateStaticPair,
  parseStaticPair,
  serializeStaticPair,
  type E2ESecureEnvelope,
  type E2ESession,
} from "@tianshu/core";

// 模拟「低阶点静默产出全零共享秘密」的旧版 OpenSSL/Node 运行时：标记
// 对端公钥（32B 0xAB）走 diffieHellman 时强制返回全零，其余调用透传
// 真实现——用于钉住 deriveSessionKeys 的显式低阶拒绝分支（新版
// OpenSSL 已在 ECDH 层前置拒绝，不经 mock 无法到达该分支）。
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const LOW_ORDER_MARKER = Buffer.alloc(32, 0xab);
  return {
    ...actual,
    diffieHellman: (...args: Parameters<typeof actual.diffieHellman>) => {
      const peerDer = args[0].publicKey.export({
        type: "spki",
        format: "der",
      }) as Buffer;
      if (peerDer.subarray(peerDer.length - 32).equals(LOW_ORDER_MARKER)) {
        return Buffer.alloc(32);
      }
      return actual.diffieHellman(...args);
    },
  };
});

/** 组装一次完整协商：静态对（被控端）+ 临时对（控制端）+ 双端会话 */
function setupHandshake(connectionId = "conn-test") {
  const staticPair = generateStaticPair();
  const ephemeral = generateEphemeralPair();
  // 被控端视角：持临时公钥（hello 帧带来）+ 自己的静态私钥
  const serverKeys = deriveSessionKeys({
    ephemeralPublicKey: ephemeral.publicKey,
    staticPrivateKey: staticPair.privateKey,
    connectionId,
  });
  // 控制端视角：持自己的临时私钥 + 静态公钥（ack 帧带来）
  const clientKeys = deriveSessionKeys({
    ephemeralPrivateKey: ephemeral.privateKey,
    staticPublicKey: staticPair.publicKey,
    connectionId,
  });
  return {
    staticPair,
    ephemeral,
    clientKeys,
    serverKeys,
    client: createE2ESession(clientKeys, "client"),
    server: createE2ESession(serverKeys, "server"),
  };
}

function decodeBase64(value: string): Buffer {
  return Buffer.from(value, "base64");
}

/** 解出 nonce 的 8B 大端计数器（低 8 字节） */
function nonceCounter(envelope: E2ESecureEnvelope): number {
  return Number(decodeBase64(envelope.n).subarray(4).readBigUInt64BE(0));
}

describe("E2E 加密核心", () => {
  describe("握手帧常量（跨仓单份 wire 契约）", () => {
    it("kind 值与 spec §2.2/§2.3 钉死", () => {
      expect(E2E_HANDSHAKE_HELLO).toBe("e2e-hello");
      expect(E2E_HANDSHAKE_ACK).toBe("e2e-ack");
      expect(E2E_SECURE_KIND).toBe("e2e-secure");
    });
  });

  describe("密钥对生成与静态序列化", () => {
    it("临时/静态对均为 32B 原始 X25519 密钥且每次生成不同", () => {
      const ephemeral = generateEphemeralPair();
      const staticPair = generateStaticPair();
      expect(ephemeral.publicKey.length).toBe(32);
      expect(ephemeral.privateKey.length).toBe(32);
      expect(staticPair.publicKey.length).toBe(32);
      expect(staticPair.privateKey.length).toBe(32);
      expect(
        generateStaticPair().privateKey.equals(staticPair.privateKey),
      ).toBe(false);
    });

    it("静态对序列化往返：parse(serialize(pair)) 键值一致", () => {
      const pair = generateStaticPair();
      const restored = parseStaticPair(serializeStaticPair(pair));
      expect(restored.publicKey.equals(pair.publicKey)).toBe(true);
      expect(restored.privateKey.equals(pair.privateKey)).toBe(true);
    });

    it("parse 拒绝畸形存储（错误前缀/坏 base64/长度错/公私钥不匹配）", () => {
      const pair = generateStaticPair();
      expect(() => parseStaticPair("not-a-key")).toThrow();
      expect(() => parseStaticPair("tianshu-e2e-static-v1:!!!:???")).toThrow();
      expect(() =>
        parseStaticPair(
          `tianshu-e2e-static-v1:${pair.privateKey
            .subarray(0, 16)
            .toString("base64")}:${pair.publicKey.toString("base64")}`,
        ),
      ).toThrow();
      // 篡改公钥：与私钥推 导不一致
      const tamperedPub = Buffer.from(pair.publicKey);
      tamperedPub[0] ^= 0xff;
      expect(() =>
        parseStaticPair(
          `tianshu-e2e-static-v1:${pair.privateKey.toString(
            "base64",
          )}:${tamperedPub.toString("base64")}`,
        ),
      ).toThrow();
    });
  });

  describe("指纹", () => {
    it("稳定且为 16 位 hex；Buffer 与 base64 入参等价", () => {
      const pair = generateStaticPair();
      const fingerprint = fingerprintOf(pair.publicKey);
      expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
      expect(fingerprintOf(pair.publicKey)).toBe(fingerprint);
      expect(fingerprintOf(pair.publicKey.toString("base64"))).toBe(
        fingerprint,
      );
      expect(fingerprintOf(generateStaticPair().publicKey)).not.toBe(
        fingerprint,
      );
    });
  });

  describe("会话密钥派生（HKDF-SHA256）", () => {
    it("双向密钥不同（K_c2s ≠ K_s2c）", () => {
      const { clientKeys } = setupHandshake();
      expect(clientKeys.clientToServer.equals(clientKeys.serverToClient)).toBe(
        false,
      );
    });

    it("双端视角派生一致（临时私钥+静态公钥 = 临时公钥+静态私钥）", () => {
      const { clientKeys, serverKeys } = setupHandshake();
      expect(clientKeys.clientToServer.equals(serverKeys.clientToServer)).toBe(
        true,
      );
      expect(clientKeys.serverToClient.equals(serverKeys.serverToClient)).toBe(
        true,
      );
    });

    it("绑定 context：connectionId 不同或对端密钥不同 → 派生不同", () => {
      const a = setupHandshake("conn-a");
      const b = setupHandshake("conn-b");
      expect(
        a.clientKeys.clientToServer.equals(b.clientKeys.clientToServer),
      ).toBe(false);
      // 同 connectionId 但换静态对（对端身份变化）
      const c = deriveSessionKeys({
        ephemeralPublicKey: a.ephemeral.publicKey,
        staticPrivateKey: generateStaticPair().privateKey,
        connectionId: "conn-a",
      });
      expect(c.clientToServer.equals(a.clientKeys.clientToServer)).toBe(false);
    });

    it("低阶公钥（全零共享秘密）→ derive 拒（任一层拒即安全属性成立）", () => {
      // 被控端半区：hello 帧带来全零临时公钥（经典低阶点）
      expect(() =>
        deriveSessionKeys({
          ephemeralPublicKey: Buffer.alloc(32),
          staticPrivateKey: generateStaticPair().privateKey,
          connectionId: "conn-test",
        }),
      ).toThrow();
      // 控制端半区：ack 帧带来全零静态公钥
      expect(() =>
        deriveSessionKeys({
          ephemeralPrivateKey: generateEphemeralPair().privateKey,
          staticPublicKey: Buffer.alloc(32),
          connectionId: "conn-test",
        }),
      ).toThrow();
      // 非 mock 通路下新版 OpenSSL 已在 ECDH 层前置拒；显式分支见下一用例
    });

    it("低阶点静默全零（旧版 OpenSSL 行为）→ 显式拒并给出低阶错误", () => {
      // 32B 0xAB 为 mock 标记：diffieHellman 强制返回全零共享秘密
      expect(() =>
        deriveSessionKeys({
          ephemeralPublicKey: Buffer.alloc(32, 0xab),
          staticPrivateKey: generateStaticPair().privateKey,
          connectionId: "conn-test",
        }),
      ).toThrow("E2E: 低阶公钥拒绝（无效对端密钥）");
      expect(() =>
        deriveSessionKeys({
          ephemeralPrivateKey: generateEphemeralPair().privateKey,
          staticPublicKey: Buffer.alloc(32, 0xab),
          connectionId: "conn-test",
        }),
      ).toThrow("E2E: 低阶公钥拒绝（无效对端密钥）");
    });
  });

  describe("信封 seal/open 往返", () => {
    it("client seal → server open；server seal → client open，明文一致", () => {
      const { client, server } = setupHandshake();
      const frame = JSON.stringify({
        kind: "req",
        id: 1,
        path: "session/query",
      });
      const envelope = client.seal(frame);
      expect(JSON.parse(server.open(envelope).toString("utf8"))).toEqual(
        JSON.parse(frame),
      );
      const reply = JSON.stringify({ kind: "res", id: 1, status: 200 });
      expect(
        JSON.parse(client.open(server.seal(reply)).toString("utf8")),
      ).toEqual(JSON.parse(reply));
    });

    it("信封形态：kind/n 12B/ct 非空；nonce 前缀稳定、计数器单调递增", () => {
      const { client } = setupHandshake();
      const envelopes = [client.seal("a"), client.seal("b"), client.seal("c")];
      for (const envelope of envelopes) {
        expect(envelope.kind).toBe("e2e-secure");
        expect(decodeBase64(envelope.n).length).toBe(12);
        expect(decodeBase64(envelope.ct).length).toBeGreaterThan(16);
      }
      const prefixes = envelopes.map((e) => decodeBase64(e.n).subarray(0, 4));
      expect(prefixes[1].equals(prefixes[0])).toBe(true);
      expect(prefixes[2].equals(prefixes[0])).toBe(true);
      expect(nonceCounter(envelopes[0])).toBe(1);
      expect(nonceCounter(envelopes[1])).toBe(2);
      expect(nonceCounter(envelopes[2])).toBe(3);
    });

    it("空帧与非字符串明文（Buffer）亦可往返", () => {
      const { client, server } = setupHandshake();
      expect(server.open(client.seal("")).length).toBe(0);
      const binary = Buffer.from([0, 1, 2, 255]);
      expect(Buffer.compare(server.open(client.seal(binary)), binary)).toBe(0);
    });
  });

  describe("篡改拒（AEAD 认证失败 → 抛错）", () => {
    it("ct 翻字节/截断 tag → open 抛错", () => {
      const { client, server } = setupHandshake();
      const envelope = client.seal("payload");
      const flipByte = (env: E2ESecureEnvelope): E2ESecureEnvelope => {
        const ct = Buffer.from(env.ct, "base64");
        ct[ct.length - 1] ^= 0x01;
        return { ...env, ct: ct.toString("base64") };
      };
      expect(() => server.open(flipByte(envelope))).toThrow();
      const truncate = {
        ...envelope,
        ct: decodeBase64(envelope.ct).subarray(0, 8).toString("base64"),
      };
      expect(() => server.open(truncate)).toThrow();
    });

    it("nonce 翻前缀字节（跨方向/会话错配）→ open 抛错", () => {
      const { client, server } = setupHandshake();
      const envelope = client.seal("payload");
      const n = decodeBase64(envelope.n);
      n[0] ^= 0xff;
      expect(() =>
        server.open({ ...envelope, n: n.toString("base64") }),
      ).toThrow();
    });

    it("前缀钉住显式拒路径：首帧成功后换前缀帧 → 拒 prefix mismatch", () => {
      const { client, server } = setupHandshake();
      // 首帧认证成功 → 接收侧前缀被钉住
      expect(server.open(client.seal("first")).toString("utf8")).toBe("first");
      // 后续帧翻前缀字节：命中显式前缀检查（先于 GCM 解密）
      const second = client.seal("second");
      const n = decodeBase64(second.n);
      n[0] ^= 0x01;
      expect(() => server.open({ ...second, n: n.toString("base64") })).toThrow(
        /nonce prefix mismatch/,
      );
    });

    it("nonce 翻计数器字节（aad 绑定被破坏）→ open 抛错", () => {
      const { client, server } = setupHandshake();
      const envelope = client.seal("payload");
      const n = decodeBase64(envelope.n);
      n[11] ^= 0x01;
      expect(() =>
        server.open({ ...envelope, n: n.toString("base64") }),
      ).toThrow();
    });

    it("非信封帧（kind 不符/缺字段/坏 base64）→ open 抛错", () => {
      const { server } = setupHandshake();
      expect(() =>
        server.open({ kind: "req", id: 1 } as unknown as E2ESecureEnvelope),
      ).toThrow();
      expect(() =>
        server.open({ kind: "e2e-secure" } as unknown as E2ESecureEnvelope),
      ).toThrow();
      expect(() =>
        server.open({ kind: "e2e-secure", n: "!!!", ct: "???" }),
      ).toThrow();
      expect(() =>
        server.open({
          kind: "e2e-secure",
          n: Buffer.alloc(4).toString("base64"),
          ct: "AAAA",
        }),
      ).toThrow();
    });
  });

  describe("重放窗口（64 滑动）", () => {
    it("窗口内重复帧拒：同帧二次 open 抛错", () => {
      const { client, server } = setupHandshake();
      const envelope = client.seal("once");
      expect(server.open(envelope).toString("utf8")).toBe("once");
      expect(() => server.open(envelope)).toThrow();
    });

    it("64 帧内重放拒 + 低于窗口下沿重放拒（边界语义）", () => {
      const { client, server } = setupHandshake();
      // 连发 65 帧（计数器 1..65）全部按序接收：窗口记忆最近 64 个（2..65）
      const envelopes = Array.from({ length: 65 }, (_, i) =>
        client.seal(JSON.stringify({ i })),
      );
      for (const envelope of envelopes) {
        server.open(envelope);
      }
      // #30 仍在窗口内且已见过 → 拒
      expect(() => server.open(envelopes[29])).toThrow();
      // #1 低于窗口下沿：有序 WS 传输下诚实路径不可达，必为重放 → 拒
      expect(() => server.open(envelopes[0])).toThrow(/低于窗口下沿/);
    });

    it("认证失败不污染窗口：篡改帧拒后真帧仍可接受", () => {
      const { client, server } = setupHandshake();
      const envelopes = Array.from({ length: 5 }, (_, i) =>
        client.seal(JSON.stringify({ i })),
      );
      for (const envelope of envelopes.slice(0, 4)) {
        server.open(envelope);
      }
      // 篡改 #5 密文：GCM 认证失败 → 拒（接收状态不提交）
      const tamperedCt = Buffer.from(envelopes[4].ct, "base64");
      tamperedCt[tamperedCt.length - 1] ^= 0x01;
      expect(() =>
        server.open({
          ...envelopes[4],
          ct: tamperedCt.toString("base64"),
        }),
      ).toThrow(/authentication failed/);
      // 其后真 #5 帧（计数器未登记过）→ 仍可接受
      expect(JSON.parse(server.open(envelopes[4]).toString("utf8")).i).toBe(4);
    });

    it("窗口内乱序未收 → 接受（真实序号尚未见过）", () => {
      const { client, server } = setupHandshake();
      const first = client.seal("1");
      const second = client.seal("2");
      const third = client.seal("3");
      expect(server.open(third).toString("utf8")).toBe("3");
      expect(server.open(second).toString("utf8")).toBe("2");
      expect(server.open(first).toString("utf8")).toBe("1");
      // 乱序收齐后，窗口内已见计数器重复仍拒
      expect(() => server.open(second)).toThrow();
    });
  });

  describe("跨方向隔离", () => {
    it("自发帧自收向拒：c2s 密文在 c2s 通道打不开（key/aad 双重隔离）", () => {
      const { client, server } = setupHandshake();
      // client 以 c2s 密钥密封，其 open 走 s2c 接收向 → 必须失败
      expect(() => client.open(client.seal("loop"))).toThrow();
      // server 以 s2c 密钥密封，其 open 走 c2s 接收向 → 必须失败
      expect(() => server.open(server.seal("loop"))).toThrow();
    });

    it("跨会话隔离：另一协商（不同静态对）的会话打不开本会话密文", () => {
      const a = setupHandshake();
      const b = setupHandshake("conn-test");
      expect(() => b.server.open(a.client.seal("secret"))).toThrow();
    });
  });

  describe("会话对象能力面", () => {
    it("seal/open 为独立会话闭包（同 keys 双端互不串扰计数器）", () => {
      const { clientKeys, serverKeys } = setupHandshake();
      const left = createE2ESession(clientKeys, "client");
      const right = createE2ESession(serverKeys, "server");
      const another: E2ESession = createE2ESession(
        deriveSessionKeys({
          ephemeralPrivateKey: generateEphemeralPair().privateKey,
          staticPublicKey: generateStaticPair().publicKey,
          connectionId: "conn-test",
        }),
        "client",
      );
      // 各会话计数器从 1 起独立递增
      expect(nonceCounter(left.seal("x"))).toBe(1);
      expect(nonceCounter(another.seal("y"))).toBe(1);
      expect(right.open(left.seal("z")).toString("utf8")).toBe("z");
    });
  });
});

/**
 * relay 地址 scheme 校验（安全批 H；蓝本桌面批二 B7
 * electron/domains/server/connections.ts validateConfig）：明文 ws:// 的
 * 凭证可被链路嗅探——域名/公网地址必须 wss://；loopback 与私网字面 IP
 * 放行（内网直连场景）。判定为纯字面 IP/主机名比对，无 DNS 解析。
 */
import { describe, expect, it, vi } from "vitest";

// expo 系模块以 TS 源直发（metro 解析 .ts；node/vitest 不可加载真身）——
// node 测试环境一律替身（mobile 测试惯例：原生模块全 mock）
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

// —— transport 工厂替身：阻断 connection → direct/relay → expo/fetch →
// react-native（Flow 语法 node 环境不可解析）传递链（wire.test.ts 同款）——
// relay-ak 真身经 e2e-crypto/expo-secure-store 链亦需替身
vi.mock("./direct-transport", () => ({ createDirectTransport: vi.fn() }));
vi.mock("./relay-transport", () => ({ createRelayTransport: vi.fn() }));
vi.mock("expo-secure-store", () => ({
  setItemAsync: vi.fn(async () => undefined),
  getItemAsync: vi.fn(async () => null),
  deleteItemAsync: vi.fn(async () => undefined),
}));

import { validateRelayUrlScheme } from "./connection";

describe("validateRelayUrlScheme（B7 同款明文 relay 拦截）", () => {
  it("wss:// 任意地址放行", () => {
    expect(validateRelayUrlScheme("wss://relay.example.com/ws")).toBe(true);
    expect(validateRelayUrlScheme("wss://8.8.8.8:8411")).toBe(true);
  });

  it("ws:// loopback 与私网字面 IP 放行（内网直连）", () => {
    expect(validateRelayUrlScheme("ws://127.0.0.1:8411/ws")).toBe(true);
    expect(validateRelayUrlScheme("ws://localhost:8411")).toBe(true);
    expect(validateRelayUrlScheme("ws://dev.local.localhost:8411")).toBe(true);
    expect(validateRelayUrlScheme("ws://10.0.0.5:8411")).toBe(true);
    expect(validateRelayUrlScheme("ws://192.168.1.20:8411")).toBe(true);
    expect(validateRelayUrlScheme("ws://172.16.0.1:8411")).toBe(true);
    expect(validateRelayUrlScheme("ws://172.31.255.254:8411")).toBe(true);
  });

  it("ws:// 域名拒绝（凭证明文过公网链路）", () => {
    expect(validateRelayUrlScheme("ws://relay.example.com/ws")).toBe(
      "public-plaintext",
    );
  });

  it("ws:// 公网字面 IP 拒绝", () => {
    expect(validateRelayUrlScheme("ws://8.8.8.8:8411")).toBe(
      "public-plaintext",
    );
    expect(validateRelayUrlScheme("ws://172.32.0.1:8411")).toBe(
      "public-plaintext",
    ); // 172.32 超出私网段
    expect(validateRelayUrlScheme("ws://172.15.0.1:8411")).toBe(
      "public-plaintext",
    );
  });

  it("非 ws(s) scheme 拒绝（http/ftp/无 scheme 等）", () => {
    expect(validateRelayUrlScheme("http://relay.example.com")).toBe(
      "invalid-scheme",
    );
    expect(validateRelayUrlScheme("relay.example.com")).toBe("invalid-scheme");
    expect(validateRelayUrlScheme("")).toBe("invalid-scheme");
  });
});

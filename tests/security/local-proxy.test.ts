/**
 * 本地 CONNECT 代理单测（SP5 Task 4）：CONNECT 放行/拒绝双路径与启停幂等。
 * 全部本地化——echo 目标监听 127.0.0.1（豁免面内），代理自身绑定 127.0.0.1；
 * 拒绝用例只发 CONNECT 头即收 403（判定先于 net.connect，不触真实外连）。
 */
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { NetworkPolicyState } from "../../electron/domains/security/domain-policy";
import { LocalConnectProxy } from "../../electron/domains/security/local-proxy";
import {
  getNetworkGate,
  installNetworkGate,
  uninstallNetworkGateForTest,
} from "../../electron/domains/security/network-gate";

/** 判定输入用全量策略（judgeDomain 直读各名单字段，部分态会抛错走 fail-open） */
const policy = (over: Partial<NetworkPolicyState>): NetworkPolicyState => ({
  exemptDomains: [],
  domainAllow: [],
  domainDeny: [],
  blockAllNetwork: false,
  maliciousDomainProtection: false,
  ...over,
});

/** 本地 echo 目标（模拟放行站点：127.0.0.1 在豁免面） */
function echoServer(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.pipe(socket));
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: (server.address() as net.AddressInfo).port }),
    );
  });
}

describe("LocalConnectProxy", () => {
  beforeAll(() => {
    installNetworkGate({
      policyProvider: () =>
        policy({
          exemptDomains: ["localhost", "127.0.0.1", "::1"],
          domainDeny: ["evil.com"],
        }),
      audit: () => {},
    });
  });
  afterAll(() => uninstallNetworkGateForTest());

  it("CONNECT 放行：管道双向通（经代理连本地 echo）", async () => {
    const { server, port } = await echoServer();
    const proxy = new LocalConnectProxy(() => getNetworkGate());
    const proxyPort = await proxy.start();
    // 客户端 socket 须显式销毁：server.close() 等待存量连接结束，隧道半开会卡死 stop()
    const client = net.connect(proxyPort, "127.0.0.1");
    try {
      const data = await new Promise<string>((resolve, reject) => {
        client.on("connect", () => {
          client.write(
            `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`,
          );
        });
        let greeted = false;
        let echoed = "";
        client.on("data", (chunk) => {
          const text = chunk.toString();
          if (!greeted) {
            greeted = true;
            if (!text.includes("200")) {
              reject(new Error(`期待 200 连接建立响应，实际: ${text}`));
              return;
            }
            // 200 头收到后再发数据（稳妥时序，避免与管道建立竞态）
            client.write("ping");
            return;
          }
          echoed += text;
          if (echoed.includes("ping")) resolve(echoed);
        });
        client.on("error", reject);
      });
      expect(data).toContain("ping");
    } finally {
      client.destroy();
      await proxy.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("CONNECT 拒绝：403 + X-Block-Reason 头 + 审计", async () => {
    const audit = vi.fn();
    // 重装带审计 sink（拒绝判定先于 net.connect，不触真实外连）
    installNetworkGate({
      policyProvider: () => policy({ domainDeny: ["evil.com"] }),
      audit,
    });
    const proxy = new LocalConnectProxy(() => getNetworkGate());
    const proxyPort = await proxy.start();
    const resp = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(proxyPort, "127.0.0.1", () => {
        socket.write(
          "CONNECT evil.com:443 HTTP/1.1\r\nHost: evil.com:443\r\n\r\n",
        );
      });
      socket.on("data", (c) => resolve(c.toString()));
      socket.on("error", reject);
    });
    expect(resp).toContain("403");
    expect(resp).toContain("X-Block-Reason: deny");
    expect(audit).toHaveBeenCalled();
    await proxy.stop();
  });

  it("未启动即 stop / 重复 start 幂等", async () => {
    const proxy = new LocalConnectProxy(() => getNetworkGate());
    await expect(proxy.stop()).resolves.toBeUndefined();
    const first = await proxy.start();
    expect(await proxy.start()).toBe(first);
    expect(proxy.port).toBe(first);
    await proxy.stop();
    expect(proxy.port).toBeUndefined();
  });
});

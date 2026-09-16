/**
 * 本地 CONNECT 代理单测（SP5 Task 4）：CONNECT 放行/拒绝双路径与启停幂等；
 * 明文转发上游错误收口（终审 S1：响应头已发后断流销毁连接 / 未发回 502）。
 * 全部本地化——echo 目标监听 127.0.0.1（豁免面内），代理自身绑定 127.0.0.1；
 * 拒绝用例只发 CONNECT 头即收 403（判定先于 net.connect，不触真实外连）。
 * network-gate 传递依赖 Log（→ electron），经 vi.mock 替换（仓库既有模式）。
 */
import http from "node:http";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../electron/commons/Log", () => ({
  default: { error: vi.fn() },
}));

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

/** 探针取（大概率）空闲端口：listen 0 拿端口后立即关闭 */
function unusedPort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

/** 经代理发明文绝对 URI 请求；resolve 于响应头到达（error 监听常驻防悬置） */
function plainRequest(
  proxyPort: number,
  targetPort: number,
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: proxyPort,
      path: `http://127.0.0.1:${targetPort}/`,
      method: "GET",
    });
    req.on("response", (res) => resolve(res));
    req.on("error", reject);
    req.end();
  });
}

/** 客户端响应终结（断流销毁 / 正常 end 均收口，防用例悬挂） */
function responseSettled(res: http.IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    res.resume(); // 流动模式：暂停态下正常 end 的 close 可能不触发
    res.once("close", () => resolve());
    res.once("error", () => resolve());
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

  it("明文转发：响应头已发后上游断流 → 销毁客户端连接，无未捕获异常（终审 S1）", async () => {
    // 先回包（chunked 首块）的目标，待控制信号再 RST：确保 RST 到达时响应头与
    // 首块已被代理读空转发（headersSent=true、socket 无未读数据）——ECONNRESET
    // 确定性走 request error 路径；旧实现此处 writeHead 抛 ERR_HTTP_HEADERS_SENT
    // 且客户端连接悬置
    let blasting: net.Socket | undefined;
    const control = net.createServer((s) => {
      s.on("data", () => {
        blasting?.resetAndDestroy();
        s.end();
      });
    });
    const controlPort: number = await new Promise((resolve) => {
      control.listen(0, "127.0.0.1", () =>
        resolve((control.address() as net.AddressInfo).port),
      );
    });
    const target = net.createServer((socket) => {
      blasting = socket;
      socket.on("data", () => {
        socket.write(
          "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nping\r\n",
        );
      });
    });
    const targetPort: number = await new Promise((resolve) => {
      target.listen(0, "127.0.0.1", () =>
        resolve((target.address() as net.AddressInfo).port),
      );
    });
    const proxy = new LocalConnectProxy(() => getNetworkGate());
    const proxyPort = await proxy.start();
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on("uncaughtException", onUncaught);
    try {
      const res = await plainRequest(proxyPort, targetPort);
      expect(res.statusCode).toBe(200); // 响应头经代理转发成功（已发出）
      // 首块到达客户端 = 代理已读空上游数据（RST 落在空闲 socket 上必得 ECONNRESET）
      await new Promise<void>((resolve) => {
        res.once("data", (c) => {
          if (c.toString().includes("ping")) resolve();
        });
      });
      net.connect(controlPort, "127.0.0.1").write("GO");
      await responseSettled(res);
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
      await proxy.stop();
      await new Promise<void>((resolve) => target.close(() => resolve()));
      await new Promise<void>((resolve) => control.close(() => resolve()));
    }
  });

  it("明文转发：上游连接失败（未发响应头）→ 502（S1 防护另一分支）", async () => {
    const closedPort = await unusedPort();
    const proxy = new LocalConnectProxy(() => getNetworkGate());
    const proxyPort = await proxy.start();
    try {
      const res = await plainRequest(proxyPort, closedPort);
      expect(res.statusCode).toBe(502);
      await responseSettled(res);
    } finally {
      await proxy.stop();
    }
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

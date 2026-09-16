/**
 * 本地 CONNECT 代理（SP5 spec §5）：127.0.0.1 随机端口；
 * CONNECT 目标 host 经 NetworkGate 判定——拒 403 + X-Block-Reason，放行直连管道。
 * 明文 HTTP 绝对 URI 请求同判定（拒 403，放行转发）。
 * electron-free（node:http + node:net）；上游企业代理链式转发 v1 不做
 * （spec §5 边界：app 代理与子进程门同开时子进程直连，判定仍生效）。
 */
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import type { NetworkGate } from "./network-gate";
import type { NetworkVerdict } from "./domain-policy";

export class LocalConnectProxy {
  private server?: http.Server;
  private portValue?: number;
  /** 启动中/已启动的端口 Promise：并发 start（启动期 onConfigChange 与显式
   * 初对齐同时触发）复用同一 Promise，避免读到未就绪的端口值 */
  private starting?: Promise<number>;

  constructor(
    private readonly getGate: () =>
      Promise<NetworkGate | null> | NetworkGate | null,
  ) {}

  get port(): number | undefined {
    return this.portValue;
  }

  async start(): Promise<number> {
    if (this.starting) return this.starting;
    const server = http.createServer((req, res) => {
      void this.handlePlainRequest(req, res);
    });
    server.on("connect", (req, clientSocket, head) => {
      void this.handleConnect(req, clientSocket, head);
    });
    this.server = server;
    this.starting = new Promise<number>((resolve, reject) => {
      // 监听失败清态可重试；启动后的运行期错误打到已 settle 的 reject 为无害 no-op
      server.once("error", (e) => {
        this.server = undefined;
        this.portValue = undefined;
        this.starting = undefined;
        reject(e);
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as net.AddressInfo;
        this.portValue = addr.port;
        resolve(addr.port);
      });
    });
    return this.starting;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    this.portValue = undefined;
    this.starting = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** CONNECT host:port → 判定 → 管道（照 Node 官方 proxy 示例模式）；
   * clientSocket 为 Duplex（@types/node 的 connect 事件签名，Socket 的超类） */
  private async handleConnect(
    req: http.IncomingMessage,
    clientSocket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const target = String(req.url ?? "");
    const host = target.split(":")[0];
    const gate = await this.getGate();
    const verdict: NetworkVerdict = gate ? gate.judgeHost(host) : { ok: true };
    if (!verdict.ok) {
      gate?.blockedAudit(verdict.host, verdict.rule, "proxy");
      clientSocket.end(
        `HTTP/1.1 403 Forbidden\r\nX-Block-Reason: ${verdict.rule}\r\nConnection: close\r\n\r\n`,
      );
      return;
    }
    const port = Number(target.split(":")[1] ?? 443);
    const upstream = net.connect(port, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
    // 半开清理：对端关闭即整体拆除隧道，保证 stop() 不被悬挂连接卡死
    upstream.on("close", () => clientSocket.destroy());
    clientSocket.on("close", () => upstream.destroy());
  }

  /** 明文 HTTP（绝对 URI）同判定转发；非绝对 URI（origin-form 等）按坏请求拒 */
  private async handlePlainRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let target: URL;
    try {
      target = new URL(String(req.url ?? ""));
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const gate = await this.getGate();
    const verdict: NetworkVerdict = gate
      ? gate.judgeHost(target.hostname)
      : { ok: true };
    if (!verdict.ok) {
      gate?.blockedAudit(verdict.host, verdict.rule, "proxy");
      res.writeHead(403, { "X-Block-Reason": verdict.rule });
      res.end();
      return;
    }
    const upstream = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: target.pathname + target.search,
        method: req.method,
        headers: req.headers,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  }
}

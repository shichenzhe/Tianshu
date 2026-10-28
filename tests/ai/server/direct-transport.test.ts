// T13 DirectTransport：fetch + SSE 手写流解析 + 指数退避重连。
// 假被控端（本机 node:http）实现 mirror server-face 契约：
// - Bearer 鉴权（401 无 token）
// - GET /event → SSE：首帧 server.connected，其后按需推帧 / `: ping` 心跳
// - POST session/query、GET info → starter 包装体 {code:'2000',success,data}
// 覆盖：连上收 server.connected、request 包装体、杀被控端→reconnecting→
// 重启→connected（SSE 重新 GET 全量流）、静默死链 watchdog 判死重连、
// close 不再重连、SSE 解析容错（注释行/单 chunk 多帧）、request 超时窗
// （§13 项 3：挂起请求抛可判错误且不伤 SSE）。
import http from "node:http";
import net from "node:net";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../electron/commons/Log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { DirectTransport } from "../../../electron/domains/server/direct-transport";
import type { ServerEvent } from "../../../electron/domains/server/protocol";

const TOKEN = "direct-token";

function sseFrame(type: string, payload: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** 假被控端（server-face 契约子集）；heartbeat 关 = 发完首帧沉默 */
class FakeFace {
  readonly connectedSent: number[] = [];
  private readonly sseStreams = new Set<http.ServerResponse>();
  private constructor(private readonly server: http.Server) {}

  static async start(
    port: number,
    options: {
      heartbeat?: boolean;
      rawSse?: string;
      /** POST session/query 挂起不回包（request 超时用例） */
      hangRequest?: boolean;
    } = {},
  ): Promise<FakeFace> {
    // holder：request 回调在实例构造前注册、listen 完成后才可能触发——
    // 期间实例已就位（listen 先于任何请求，构造紧随 listen）
    const holder: { face: FakeFace | null } = { face: null };
    const server = http.createServer((req, res) => handle(req, res, options));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const face = new FakeFace(server);
    holder.face = face;
    return face;

    function handle(
      req: http.IncomingMessage,
      res: http.ServerResponse,
      opts: {
        heartbeat?: boolean;
        rawSse?: string;
        hangRequest?: boolean;
      },
    ): void {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "4010", success: false, data: null }));
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/event")) {
        streamSse(req, res, opts);
        return;
      }
      let raw = "";
      req.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf8");
      });
      req.on("end", () => {
        if (req.method === "GET" && req.url?.startsWith("/info")) {
          reply(res, 200, {
            name: "fake-face",
            instanceId: "fake-instance",
            capabilities: ["chat", "provider"],
          });
          return;
        }
        if (req.method === "POST" && req.url?.startsWith("/session/query")) {
          // 挂起模式：不回包（模拟死挂的被控端，request 超时窗兜错）
          if (opts.hangRequest) return;
          const body = raw ? (JSON.parse(raw) as { page?: number }) : {};
          reply(res, 200, {
            page: body.page ?? 1,
            pageSize: 100,
            records: [],
            total: 0,
          });
          return;
        }
        reply(res, 404, null, "4040", "接口不存在");
      });
    }

    function streamSse(
      _req: http.IncomingMessage,
      res: http.ServerResponse,
      opts: { heartbeat?: boolean; rawSse?: string },
    ): void {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
      });
      const face = holder.face!;
      face.sseStreams.add(res);
      res.on("close", () => face.sseStreams.delete(res));
      res.write(
        opts.rawSse ??
          sseFrame("server.connected", {
            instanceId: "fake-instance",
            capabilities: ["chat", "provider"],
          }),
      );
      face.connectedSent.push(Date.now());
      if (opts.heartbeat !== false) {
        const beat = setInterval(() => {
          if (!res.destroyed) res.write(": ping\n\n");
        }, 150);
        res.on("close", () => clearInterval(beat));
      }
    }

    function reply(
      res: http.ServerResponse,
      status: number,
      data: unknown,
      code = "2000",
      message = "success",
    ): void {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ code, success: code === "2000", data, message }),
      );
    }
  }

  /** 向全部 SSE 连接推一帧事件 */
  sendEvent(type: string, payload: unknown): void {
    for (const res of this.sseStreams) {
      if (!res.destroyed) res.write(sseFrame(type, payload));
    }
  }

  /** 杀掉被控端：拆全部连接 + 关监听（closeAllConnections 让 SSE 即断） */
  kill(): Promise<void> {
    this.server.closeAllConnections?.();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

/** 占一个空闲端口后释放（kill/重启同端口复现用） */
function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 5000,
  stepMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor 超时（${timeoutMs}ms）`);
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("DirectTransport（本机假被控端）", () => {
  it("连上收 server.connected；request 拿到 starter 包装体；onState/onEvent 可退订", async () => {
    const port = await reservePort();
    const face = await FakeFace.start(port);
    const transport = new DirectTransport({
      baseUrl: `http://127.0.0.1:${port}`,
      token: TOKEN,
    });
    try {
      expect(transport.state).toBe("connecting");
      const events: ServerEvent[] = [];
      const states: string[] = [];
      const offEvent = transport.onEvent((event) => events.push(event));
      const offState = transport.onState((state) => states.push(state));

      await waitFor(() => transport.state === "connected");
      await waitFor(() => events.length > 0);
      expect(events[0]).toEqual({
        type: "server.connected",
        payload: {
          instanceId: "fake-instance",
          capabilities: ["chat", "provider"],
        },
      });
      expect(states[0]).toBe("connected");

      // POST：starter 包装体原样透传（判错在上层查 body.success）
      const query = await transport.request("POST", "session/query", {
        page: 2,
      });
      expect(query.status).toBe(200);
      expect(query.body).toEqual({
        code: "2000",
        success: true,
        data: { page: 2, pageSize: 100, records: [], total: 0 },
        message: "success",
      });

      // GET + 前导斜杠路径归一
      const info = await transport.request("GET", "/info");
      expect(info.status).toBe(200);
      expect(info.body).toMatchObject({
        code: "2000",
        success: true,
        data: { name: "fake-face" },
      });

      // 退订后不再收事件
      offEvent();
      face.sendEvent("session.updated", {
        id: 1,
        title: null,
        updatedAt: "2026-10-17T00:00:00.000Z",
      });
      await sleep(200);
      expect(
        events.filter((event) => event.type === "session.updated"),
      ).toHaveLength(0);

      offState();
      transport.close();
      expect(transport.state).toBe("closed");
    } finally {
      await face.kill();
    }
  }, 10000);

  it("杀掉被控端 → reconnecting；重启同端口 → connected 且 SSE 全量流重发", async () => {
    const port = await reservePort();
    let face = await FakeFace.start(port);
    const transport = new DirectTransport({
      baseUrl: `http://127.0.0.1:${port}`,
      token: TOKEN,
    });
    const connectedEvents: string[] = [];
    transport.onEvent((event) => {
      if (event.type === "server.connected") connectedEvents.push("c");
    });
    try {
      await waitFor(() => transport.state === "connected");
      await waitFor(() => connectedEvents.length === 1);

      await face.kill();
      await waitFor(() => transport.state === "reconnecting");

      // 重启同端口：1s 退避后重连成功，SSE 重新 GET → server.connected 重发
      face = await FakeFace.start(port);
      await waitFor(() => transport.state === "connected", 8000);
      await waitFor(() => connectedEvents.length === 2, 8000);
      // 新被控端实例恰好收到一次新 SSE 连接（重连建流）
      expect(face.connectedSent.length).toBe(1);

      // 重连后的 request 链路仍可用
      const query = await transport.request("POST", "session/query", {});
      expect(query.body).toMatchObject({ code: "2000", success: true });
      transport.close();
    } finally {
      await face.kill();
    }
  }, 15000);

  it("静默死链：被控端活着但无入站字节 → watchdog 判死主动重连", async () => {
    const port = await reservePort();
    const face = await FakeFace.start(port, { heartbeat: false });
    const transport = new DirectTransport({
      baseUrl: `http://127.0.0.1:${port}`,
      token: TOKEN,
      idleTimeoutMs: 250,
    });
    try {
      await waitFor(() => transport.state === "connected");
      // 服务端发完首帧后沉默：250ms 无字节判死 → 重连 → 新连接重发首帧
      await waitFor(
        () => face.connectedSent.length >= 2 && transport.state === "connected",
        8000,
      );
      transport.close();
    } finally {
      await face.kill();
    }
  }, 12000);

  it("close 后不再重连：重启被控端无新连接", async () => {
    const port = await reservePort();
    let face = await FakeFace.start(port);
    const transport = new DirectTransport({
      baseUrl: `http://127.0.0.1:${port}`,
      token: TOKEN,
    });
    await waitFor(() => transport.state === "connected");
    transport.close();
    await face.kill();
    // 等过退避首窗（1s）再重启：transport 保持 closed、无新 SSE 连接
    await sleep(1300);
    face = await FakeFace.start(port);
    await sleep(600);
    try {
      expect(transport.state).toBe("closed");
      expect(face.connectedSent.length).toBe(0);
      await expect(transport.request("GET", "info")).rejects.toThrow(/关闭/);
    } finally {
      await face.kill();
    }
  }, 10000);

  it("request 超时（spec §13 项 3）：挂起请求超窗抛可判错误；SSE 与后续请求不受影响", async () => {
    const port = await reservePort();
    const face = await FakeFace.start(port, { hangRequest: true });
    const transport = new DirectTransport({
      baseUrl: `http://127.0.0.1:${port}`,
      token: TOKEN,
      requestTimeoutMs: 300,
    });
    try {
      await waitFor(() => transport.state === "connected");
      // 被控端收请求不回：15s 默认窗（此处 300ms 注入缩短）后抛
      // 含「超时/TIMEOUT」的可判错误（与 SSE 流互不影响）
      await expect(
        transport.request("POST", "session/query", { page: 1 }),
      ).rejects.toThrow(/超时|TIMEOUT/);
      expect(transport.state).toBe("connected");
      // 超时只废单次 request：同 transport 后续请求照常
      const info = await transport.request("GET", "/info");
      expect(info.status).toBe(200);
      expect(info.body).toMatchObject({ code: "2000", success: true });
      transport.close();
    } finally {
      await face.kill();
    }
  }, 10_000);

  it("SSE 解析容错：注释行忽略、单 chunk 多帧逐帧分发", async () => {
    const port = await reservePort();
    // 单次 write 三段：首帧 + 注释心跳 + 事件（一个 TCP chunk 到达）
    const rawSse =
      sseFrame("server.connected", {
        instanceId: "fake-instance",
        capabilities: ["chat"],
      }) +
      ": ping\n\n" +
      sseFrame("session.error", {
        sessionId: 9,
        code: "NO_MODEL",
        message: "未选择模型",
      });
    const face = await FakeFace.start(port, { heartbeat: false, rawSse });
    const transport = new DirectTransport({
      baseUrl: `http://127.0.0.1:${port}`,
      token: TOKEN,
    });
    const events: ServerEvent[] = [];
    transport.onEvent((event) => events.push(event));
    try {
      await waitFor(() => transport.state === "connected");
      await waitFor(() => events.length >= 2);
      expect(events).toEqual([
        {
          type: "server.connected",
          payload: { instanceId: "fake-instance", capabilities: ["chat"] },
        },
        {
          type: "session.error",
          payload: { sessionId: 9, code: "NO_MODEL", message: "未选择模型" },
        },
      ]);
      transport.close();
    } finally {
      await face.kill();
    }
  }, 10000);
});

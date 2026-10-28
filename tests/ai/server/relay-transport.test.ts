// T14 RelayTransport：真 relay（tianshu-server 构建产物 spawn 本机实例，
// 产物路径以实测为准 dist/src/relay/relay-main.js）+ 假被控端（Node 全局
// WebSocket 连 role=server）。覆盖：open 配对后 req/res 按 id 配对
// （envelope 契约见 server-face/relay-protocol.ts——共用常量从该处导入）、
// server.connected 连接级合成（GET info）、event 透传、relay 断线重连
// （重 open）、request 超时拒绝（注入缩短）、close 拒绝在途、活性判死
// （ping/pong 应用层心跳——undici ws 无协议层 ping）。
// 产物缺失（无兄弟仓/未 build）时整组 skip——真 relay 是本组的意义所在，
// 不降级为模拟。
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../electron/commons/Log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { RelayTransport } from "../../../electron/domains/server/relay-transport";
import type { ServerEvent } from "../../../electron/domains/server/protocol";

const RELAY_TOKEN = "relay-token";
/** tianshu-server 仓根（monorepo apps/ 下；可用 TIANSHU_SERVER_DIST 覆盖） */
const TS_ROOT = process.env.TIANSHU_SERVER_DIST
  ? path.resolve(process.env.TIANSHU_SERVER_DIST)
  : path.resolve(import.meta.dirname, "../../..", "apps/tianshu-server");
const RELAY_ENTRY = path.join(TS_ROOT, "dist/src/relay/relay-main.js");
const hasRelay = fs.existsSync(RELAY_ENTRY);

interface RelayHandle {
  port: number;
  kill(): Promise<void>;
}

/** 起真 relay 子进程并等启动行（`[relay] listening on port N`） */
function startRelay(port: number): Promise<RelayHandle> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(
      "node",
      [RELAY_ENTRY, "--port", String(port), "--token", RELAY_TOKEN],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = /listening on port (\d+)/.exec(output);
      if (!match) return;
      cleanup();
      resolve({ port: Number(match[1]), kill: () => killRelay(child) });
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.once("error", (e) => reject(new Error(`relay 启动失败: ${e}`)));
    const timer = setTimeout(() => {
      cleanup();
      void killRelay(child);
      reject(new Error(`relay 启动超时，输出: ${output}`));
    }, 8000);
    function cleanup(): void {
      clearTimeout(timer);
    }
  });
}

function killRelay(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
  });
}

interface FakeFrame {
  kind: string;
  [key: string]: unknown;
}

/** 假被控端（role=server 全局 WebSocket）：req→res、ping→pong、可推 event */
class FakeControlledEnd {
  readonly frames: FakeFrame[] = [];
  opensSeen = 0;
  private ws: WebSocket | null = null;

  constructor(
    private readonly port: number,
    private readonly connectionId: string,
    private readonly opts: { reply?: boolean; answerPing?: boolean } = {},
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${this.port}/ws?role=server&token=${RELAY_TOKEN}` +
          `&connectionId=${this.connectionId}`,
      );
      this.ws = ws;
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("假被控端连接失败")));
      ws.addEventListener("message", (event) =>
        this.onFrame(String(event.data)),
      );
    });
  }

  private onFrame(raw: string): void {
    let frame: FakeFrame;
    try {
      frame = JSON.parse(raw) as FakeFrame;
    } catch {
      return;
    }
    this.frames.push(frame);
    if (frame.kind === "open") this.opensSeen += 1;
    if (frame.kind === "ping" && this.opts.answerPing !== false) {
      this.send({ kind: "pong" });
    }
    if (frame.kind === "req" && this.opts.reply !== false) {
      const req = frame as { id: number; method: string; path: string };
      this.send({
        kind: "res",
        id: req.id,
        status: 200,
        body: {
          code: "2000",
          success: true,
          data:
            req.path.replace(/^\//, "") === "info"
              ? {
                  name: "fake-headless",
                  instanceId: "fake-instance",
                  capabilities: ["chat", "provider"],
                }
              : { page: 1, pageSize: 100, records: [], total: 0 },
          message: "success",
        },
      });
    }
  }

  send(frame: Record<string, unknown>): void {
    try {
      this.ws?.send(JSON.stringify(frame));
    } catch {
      /* 对端已关 */
    }
  }

  pushEvent(type: string, payload: unknown): void {
    this.send({ kind: "event", type, payload });
  }

  close(): void {
    try {
      this.ws?.close(1000, "fake-stop");
    } catch {
      /* 已在关闭流程 */
    }
  }
}

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
  timeoutMs = 6000,
  stepMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error(`waitFor 超时（${timeoutMs}ms）`);
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

describe.skipIf(!hasRelay)("RelayTransport（真 relay + 假被控端）", () => {
  it("open 配对 + req/res 按 id 配对 + server.connected 合成 + event 透传", async () => {
    const port = await reservePort();
    const relay = await startRelay(port);
    try {
      const face = new FakeControlledEnd(port, "conn-x");
      await face.connect();
      const transport = new RelayTransport({
        relayUrl: `ws://127.0.0.1:${port}/ws`,
        relayToken: RELAY_TOKEN,
        connectionId: "conn-x",
      });
      const events: ServerEvent[] = [];
      transport.onEvent((event) => events.push(event));
      expect(transport.state).toBe("connecting");
      await waitFor(() => transport.state === "connected");
      await waitFor(() => face.opensSeen === 1);
      expect(face.frames.find((f) => f.kind === "open")).toMatchObject({
        connectionId: "conn-x",
      });

      // 连接级合成事件（与 DirectTransport SSE 首帧同构）：GET info 合成
      await waitFor(() =>
        events.some((event) => event.type === "server.connected"),
      );
      expect(events.find((event) => event.type === "server.connected")).toEqual(
        {
          type: "server.connected",
          payload: {
            instanceId: "fake-instance",
            capabilities: ["chat", "provider"],
          },
        },
      );

      // req/res 配对：envelope {kind:'req',id,method,path,body} 原样达被控端
      const res = await transport.request("POST", "session/query", {
        page: 1,
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        code: "2000",
        success: true,
        data: { total: 0 },
      });
      expect(
        face.frames.find((f) => f.kind === "req" && f.path === "session/query"),
      ).toMatchObject({ method: "POST", body: { page: 1 } });

      // event 帧 → onEvent 透传
      face.pushEvent("session.updated", {
        id: 1,
        title: "t",
        updatedAt: "2026-10-17T00:00:00.000Z",
      });
      await waitFor(() =>
        events.some((event) => event.type === "session.updated"),
      );
      expect(events.find((event) => event.type === "session.updated")).toEqual({
        type: "session.updated",
        payload: { id: 1, title: "t", updatedAt: "2026-10-17T00:00:00.000Z" },
      });
      transport.close();
      expect(transport.state).toBe("closed");
      face.close();
    } finally {
      await relay.kill();
    }
  }, 20000);

  it("relay 断线重连：杀 relay → reconnecting；重启 + 被控端重注册 → 重 open + request 恢复", async () => {
    const port = await reservePort();
    let relay = await startRelay(port);
    try {
      const face = new FakeControlledEnd(port, "conn-y");
      await face.connect();
      const transport = new RelayTransport({
        relayUrl: `ws://127.0.0.1:${port}/ws`,
        relayToken: RELAY_TOKEN,
        connectionId: "conn-y",
      });
      await waitFor(() => transport.state === "connected");
      await waitFor(() => face.opensSeen === 1);

      await relay.kill();
      await waitFor(() => transport.state === "reconnecting");

      relay = await startRelay(port);
      await face.connect(); // 被控端重注册（新 relay 进程）
      await waitFor(() => transport.state === "connected", 9000);
      await waitFor(() => face.opensSeen === 2, 9000); // 重连后重 open
      const res = await transport.request("POST", "session/query", {});
      expect(res.body).toMatchObject({ code: "2000", success: true });
      transport.close();
      face.close();
    } finally {
      await relay.kill();
    }
  }, 25000);

  it("request 超时拒绝（默认 10s，注入缩短）：被控端不回 res", async () => {
    const port = await reservePort();
    const relay = await startRelay(port);
    try {
      const face = new FakeControlledEnd(port, "conn-z", { reply: false });
      await face.connect();
      const transport = new RelayTransport({
        relayUrl: `ws://127.0.0.1:${port}/ws`,
        relayToken: RELAY_TOKEN,
        connectionId: "conn-z",
        requestTimeoutMs: 150,
      });
      await waitFor(() => transport.state === "connected");
      await expect(
        transport.request("POST", "session/query", {}),
      ).rejects.toThrow(/超时/);
      // req 帧确实送达（被控端收而不回）
      await waitFor(() => face.frames.some((f) => f.kind === "req"));
      transport.close();
      face.close();
    } finally {
      await relay.kill();
    }
  }, 15000);

  it("close 拒绝在途请求", async () => {
    const port = await reservePort();
    const relay = await startRelay(port);
    try {
      const face = new FakeControlledEnd(port, "conn-w", { reply: false });
      await face.connect();
      const transport = new RelayTransport({
        relayUrl: `ws://127.0.0.1:${port}/ws`,
        relayToken: RELAY_TOKEN,
        connectionId: "conn-w",
      });
      await waitFor(() => transport.state === "connected");
      const pending = transport.request("POST", "session/query", {});
      await waitFor(() => face.frames.some((f) => f.kind === "req"));
      transport.close();
      await expect(pending).rejects.toThrow(/关闭/);
      face.close();
    } finally {
      await relay.kill();
    }
  }, 15000);

  it("活性判死：被控端不应 pong → 无入站超窗主动重连（重 open）", async () => {
    const port = await reservePort();
    const relay = await startRelay(port);
    try {
      const face = new FakeControlledEnd(port, "conn-v", {
        answerPing: false,
      });
      await face.connect();
      const transport = new RelayTransport({
        relayUrl: `ws://127.0.0.1:${port}/ws`,
        relayToken: RELAY_TOKEN,
        connectionId: "conn-v",
        pingIntervalMs: 60,
        deadAfterMs: 200,
      });
      await waitFor(() => transport.state === "connected");
      await waitFor(() => face.opensSeen === 1);
      // ping 送达被控端（沉默不应答）→ 控制端超窗判死 → 重连重 open
      await waitFor(() => face.opensSeen >= 2, 9000);
      expect(face.frames.some((f) => f.kind === "ping")).toBe(true);
      transport.close();
      face.close();
    } finally {
      await relay.kill();
    }
  }, 20000);
});

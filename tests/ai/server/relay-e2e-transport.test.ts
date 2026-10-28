// 控制端 relay E2E 握手与信封（spec 2026-10-18-relay-e2e §2.2/§2.4/§3.3，
// E2E-T3）：@tianshu/core e2e-crypto 三方消费之三（RelayTransport 控制端）。
// 本机 ws 库 MiniRelay（open 配对转发 + 帧记录）+ FakeServerEnd（真 core
// crypto 走 server 半区握手）：
// - 握手三态：expectedFingerprint 匹配 → 加密会话（req/res 密文信封往返，
//   wire 无明文哨兵）；TOFU（空指纹）→ 加密 + 指纹回填连接配置持久化
//   （ConnectionRegistry 内存持久化断言写入）；不匹配 → 断开 + e2e=
//   mitm-suspect + 不再重连
// - 降级（§2.4）：旧版被控端（hello 无回应）→ 超时重试原 open 帧一次 +
//   明文承载 + e2e=plaintext；required 拒明文 → 隧道断开如实呈现（reconnecting）
// - 对称明文门禁（T2 契约）：会话建立后明文 res → 断开重连（新连接重新
//   协商恢复加密）；ping/pong 恒明文放行（活性不依赖加密态）
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../electron/commons/Log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// connections.ts 经 option 持久化引用 prisma-client（本测试注入内存持久化，
// 模块装载面 mock 防真实客户端连库）
vi.mock("../../../electron/commons/prisma-client", () => ({
  default: { option: {} },
}));

import { WebSocketServer, type WebSocket } from "ws";
import {
  createE2ESession,
  deriveSessionKeys,
  fingerprintOf,
  generateStaticPair,
  E2E_SECURE_KIND,
  type E2ESession,
} from "@tianshu/core";
import {
  RelayTransport,
  type RelayE2eMode,
} from "../../../electron/domains/server/relay-transport";
import {
  ConnectionRegistry,
  type ConnectionConfig,
  type PersistedShape,
} from "../../../electron/domains/server/connections";
import type { E2eStatusChange } from "../../../electron/domains/server/transport";
import type { ServerEvent } from "../../../electron/domains/server/protocol";

const TOKEN = "relay-token";
const TARGET_ID = "fake-server-instance";

/** 被控端替身行为模式：auto=完整握手；legacy=忽略 hello（旧版语义）；
 * rejectPlaintext=忽略 hello 且明文业务帧一律断开（required 拒降级）；
 * lyingFingerprint=完整握手但 ack 的 fingerprint 字段谎报（钉「不信任
 * wire 回显」——控制端自算 staticKey 指纹，E2E-T4/T3 审查 Minor） */
type FakeMode = "auto" | "legacy" | "rejectPlaintext" | "lyingFingerprint";

interface TrackedFrame {
  kind?: unknown;
  [key: string]: unknown;
}

/** 最小 relay：server 角色按 connectionId 注册；client 角色收 open 帧配对，
 * 配对后双向帧原样转发（register 由 relay 消费不下发；server 断开 → 对
 * client 发 close 帧并拆连接；open 目标不存在 → close not-found） */
class MiniRelay {
  readonly fromClient: TrackedFrame[] = [];
  readonly fromServer: TrackedFrame[] = [];
  clientCount = 0;
  private readonly servers = new Map<string, WebSocket>();
  private readonly clientOfServer = new Map<WebSocket, WebSocket>();
  private readonly wss: WebSocketServer;

  private constructor(wss: WebSocketServer) {
    this.wss = wss;
  }

  static async start(): Promise<MiniRelay> {
    const wss = new WebSocketServer({ port: 0 });
    const relay = new MiniRelay(wss);
    wss.on("connection", (ws, req) => relay.onConnection(ws, req));
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    return relay;
  }

  get url(): string {
    const { port } = this.wss.address() as { port: number };
    return `ws://127.0.0.1:${port}/ws`;
  }

  private onConnection(ws: WebSocket, req: { url?: string }): void {
    const query = new URL(req.url ?? "/", "http://relay.local").searchParams;
    const role = query.get("role");
    if (role === "server") {
      const connectionId = query.get("connectionId") ?? "";
      this.servers.set(connectionId, ws);
      ws.on("message", (raw) => {
        const frame = JSON.parse(String(raw)) as TrackedFrame;
        this.fromServer.push(frame);
        if (frame.kind === "register") return; // relay 消费注册元数据
        this.clientOfServer.get(ws)?.send(String(raw));
      });
      ws.on("close", () => {
        this.servers.delete(connectionId);
        const client = this.clientOfServer.get(ws);
        this.clientOfServer.delete(ws);
        if (client && client.readyState === WebSocket.OPEN) {
          client.send(
            JSON.stringify({
              kind: "close",
              connectionId,
              reason: "server-gone",
            }),
          );
          client.terminate();
        }
      });
      return;
    }
    this.clientCount += 1;
    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as TrackedFrame;
      this.fromClient.push(frame);
      if (frame.kind === "open") {
        const target = this.servers.get(String(frame.connectionId ?? ""));
        if (!target || target.readyState !== WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              kind: "close",
              connectionId: frame.connectionId,
              reason: "not-found",
            }),
          );
          ws.close();
          return;
        }
        this.clientOfServer.set(target, ws);
        target.send(String(raw)); // open 帧照转发（被控端忽略，relay 侧配对）
        return;
      }
      const target = [...this.clientOfServer.entries()].find(
        ([, client]) => client === ws,
      )?.[0];
      if (target && target.readyState === WebSocket.OPEN)
        target.send(String(raw));
    });
  }

  async close(): Promise<void> {
    for (const server of this.servers.values()) server.terminate();
    for (const client of this.clientOfServer.values()) client.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

/** 假被控端（role=server 全局 WebSocket）：hello→ack（真静态对）→ 会话
 * 密文 req/res/event；ping 恒明文回明文 pong；legacy 忽略 hello 明文照常；
 * rejectPlaintext 明文 req 断开 */
class FakeServerEnd {
  readonly staticPair = generateStaticPair();
  readonly fingerprint = fingerprintOf(this.staticPair.publicKey);
  readonly frames: TrackedFrame[] = [];
  opensSeen = 0;
  private session: E2ESession | null = null;
  private ws: WebSocket | null = null;

  constructor(private readonly mode: FakeMode) {}

  async connect(relay: MiniRelay): Promise<void> {
    const ws = new WebSocket(
      `${relay.url}?role=server&token=${TOKEN}&connectionId=${TARGET_ID}`,
    );
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("假被控端连接失败")));
    });
    this.ws = ws;
    ws.addEventListener("message", (event) => this.onFrame(String(event.data)));
    this.send({
      kind: "register",
      instanceId: TARGET_ID,
      capabilities: [],
      name: "fake-face",
    });
  }

  private onFrame(raw: string): void {
    let frame: TrackedFrame;
    try {
      frame = JSON.parse(raw) as TrackedFrame;
    } catch {
      return;
    }
    this.frames.push(frame);
    if (frame.kind === "open") this.opensSeen += 1;
    if (frame.kind === "e2e-hello") {
      if (this.mode === "legacy" || this.mode === "rejectPlaintext") {
        return; // 无 e2e 应答
      }
      this.session = createE2ESession(
        deriveSessionKeys({
          ephemeralPublicKey: Buffer.from(String(frame.ephemeralKey), "base64"),
          staticPrivateKey: this.staticPair.privateKey,
          connectionId: TARGET_ID,
        }),
        "server",
      );
      this.send({
        kind: "e2e-ack",
        staticKey: this.staticPair.publicKey.toString("base64"),
        fingerprint:
          this.mode === "lyingFingerprint"
            ? "ffffffffffffffff"
            : this.fingerprint,
      });
      return;
    }
    if (frame.kind === E2E_SECURE_KIND) {
      if (!this.session) throw new Error("假被控端未握手即收信封");
      const inner = JSON.parse(
        this.session.open(frame as never).toString("utf8"),
      ) as TrackedFrame;
      this.dispatch(inner, true);
      return;
    }
    this.dispatch(frame, false);
  }

  /** 业务帧处理（sealed 标记回程通道——对向按来帧通道回） */
  private dispatch(frame: TrackedFrame, sealed: boolean): void {
    if (frame.kind === "req") {
      if (this.mode === "rejectPlaintext" && !sealed) {
        this.ws?.close(1000, "e2e-required");
        return;
      }
      const path = String(frame.path ?? "").replace(/^\//, "");
      this.sendBusiness(
        {
          kind: "res",
          id: frame.id,
          status: 200,
          body: {
            code: "2000",
            success: true,
            data:
              path === "info"
                ? {
                    name: "fake",
                    instanceId: TARGET_ID,
                    capabilities: ["chat"],
                  }
                : { records: [], total: 0 },
            message: "success",
          },
        },
        sealed,
      );
      return;
    }
    if (frame.kind === "ping") {
      this.sendBusiness({ kind: "pong" }, sealed);
    }
  }

  /** 主动推事件（会话已建立即密文——与 T2 被控端出口同口径） */
  pushEvent(type: string, payload: unknown): void {
    this.sendBusiness({ kind: "event", type, payload }, this.session !== null);
  }

  /** 明文直发（对称门禁用例：会话后注入明文 res） */
  sendPlaintext(frame: Record<string, unknown>): void {
    this.send(frame);
  }

  private sendBusiness(frame: Record<string, unknown>, sealed: boolean): void {
    if (sealed && this.session) {
      this.send(this.session.seal(JSON.stringify(frame)));
      return;
    }
    this.send(frame);
  }

  private send(frame: Record<string, unknown>): void {
    try {
      this.ws?.send(JSON.stringify(frame));
    } catch {
      /* 对端已关 */
    }
  }

  close(): void {
    try {
      this.ws?.close(1000, "fake-stop");
    } catch {
      /* 已在关闭流程 */
    }
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 6000,
  stepMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`waitFor 超时（${timeoutMs}ms）`);
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/** 每用例装配：MiniRelay + FakeServerEnd（指定模式） */
async function setup(mode: FakeMode): Promise<{
  relay: MiniRelay;
  serverEnd: FakeServerEnd;
}> {
  const relay = await MiniRelay.start();
  const serverEnd = new FakeServerEnd(mode);
  await serverEnd.connect(relay);
  return { relay, serverEnd };
}

const transports: RelayTransport[] = [];

function makeTransport(
  relay: MiniRelay,
  options: {
    fingerprint?: string;
    e2eHandshakeTimeoutMs?: number;
    e2eMode?: RelayE2eMode;
    pingIntervalMs?: number;
    deadAfterMs?: number;
  } = {},
): RelayTransport {
  const transport = new RelayTransport({
    relayUrl: relay.url,
    relayToken: TOKEN,
    connectionId: TARGET_ID,
    fingerprint: options.fingerprint,
    e2eHandshakeTimeoutMs: options.e2eHandshakeTimeoutMs,
    e2eMode: options.e2eMode,
    pingIntervalMs: options.pingIntervalMs,
    deadAfterMs: options.deadAfterMs,
  });
  transports.push(transport);
  return transport;
}

afterEach(() => {
  for (const transport of transports.splice(0)) transport.close();
});

describe("控制端 relay E2E：握手三态", () => {
  it("指纹匹配 → 加密会话；信封 req/res 往返 wire 无明文；ping 恒明文", async () => {
    const { relay, serverEnd } = await setup("auto");
    try {
      const transport = makeTransport(relay, {
        fingerprint: serverEnd.fingerprint,
        e2eHandshakeTimeoutMs: 4000,
        pingIntervalMs: 60,
        deadAfterMs: 60_000,
      });
      const events: ServerEvent[] = [];
      transport.onEvent((event) => events.push(event));
      const e2eChanges: E2eStatusChange[] = [];
      transport.onE2eState((change) => e2eChanges.push(change));

      await waitFor(() => transport.e2eState === "encrypted");
      expect(e2eChanges.at(-1)).toEqual({
        state: "encrypted",
        fingerprint: serverEnd.fingerprint,
      });
      // hello 携带已存指纹（被控端不校验，仅控制端对 ack 核对）
      const hello = relay.fromClient.find((f) => f.kind === "e2e-hello");
      expect(hello).toMatchObject({
        expectedFingerprint: serverEnd.fingerprint,
      });

      // server.connected 合成（GET info 走密文信封）
      await waitFor(() =>
        events.some((event) => event.type === "server.connected"),
      );

      // 信封 req/res 往返
      const res = await transport.request("POST", "session/query", { page: 1 });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        code: "2000",
        success: true,
        data: { total: 0 },
      });

      // 密文 event 透传
      serverEnd.pushEvent("session.updated", {
        id: 1,
        title: "t",
        updatedAt: "2026-10-18T00:00:00.000Z",
      });
      await waitFor(() =>
        events.some((event) => event.type === "session.updated"),
      );

      // wire 零明文断言：双方向帧流不含业务哨兵；req 以信封形态上行
      await waitFor(() =>
        relay.fromClient.some((f) => f.kind === E2E_SECURE_KIND),
      );
      expect(JSON.stringify(relay.fromClient)).not.toContain("session/query");
      expect(JSON.stringify(relay.fromServer)).not.toContain("session/query");
      expect(relay.fromClient.some((f) => f.kind === "req")).toBe(false);

      // 活性恒明文：ping/pong 直通不拆会话，若干轮后仍加密连接
      await waitFor(() => relay.fromClient.some((f) => f.kind === "ping"));
      await waitFor(() => relay.fromServer.some((f) => f.kind === "pong"));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(transport.e2eState).toBe("encrypted");
      expect(transport.state).toBe("connected");
    } finally {
      await relay.close();
      serverEnd.close();
    }
  }, 15000);

  it("TOFU（空指纹）→ 加密 + 指纹回填连接配置持久化（下次强制）", async () => {
    const { relay, serverEnd } = await setup("auto");
    try {
      let shape: PersistedShape = {
        connections: [
          {
            id: "c1",
            name: "被控端",
            mode: "relay",
            relayUrl: relay.url,
            relayToken: TOKEN,
            connectionId: TARGET_ID,
          },
          {
            id: "c2",
            name: "闲置中继",
            mode: "relay",
            relayUrl: relay.url,
            relayToken: TOKEN,
            connectionId: "other-target",
          },
        ],
        activeConnId: null,
      };
      const registry = new ConnectionRegistry({
        persistence: {
          load: async () => JSON.parse(JSON.stringify(shape)) as PersistedShape,
          save: async (next) => {
            shape = JSON.parse(JSON.stringify(next)) as PersistedShape;
          },
        },
      });
      // hello 不带 expectedFingerprint（TOFU 首连）
      const res = await registry.request("c1", "GET", "info");
      expect(res.body).toMatchObject({ code: "2000" });
      expect(
        relay.fromClient.find((f) => f.kind === "e2e-hello")
          ?.expectedFingerprint,
      ).toBeUndefined();

      // 指纹回填：仅写 c1（TOFU 数据源为协商确认指纹）
      await waitFor(
        () => shape.connections[0].fingerprint === serverEnd.fingerprint,
      );
      expect(shape.connections[1].fingerprint).toBeUndefined();

      // 连接视图：c1 加密徽标数据；闲置 relay 连接无 e2e 值
      const list = await registry.list();
      expect(list.connections.find((c) => c.id === "c1")?.e2e).toBe(
        "encrypted",
      );
      expect(list.connections.find((c) => c.id === "c2")?.e2e).toBeUndefined();
    } finally {
      await relay.close();
      serverEnd.close();
    }
  }, 15000);

  it("指纹不匹配 → 断开 + mitm-suspect + 不再重连 + 请求拒绝", async () => {
    const { relay, serverEnd } = await setup("auto");
    try {
      const transport = makeTransport(relay, {
        fingerprint: "deadbeefdeadbeef",
        e2eHandshakeTimeoutMs: 3000,
      });
      await waitFor(() => transport.e2eState === "mitm-suspect");
      expect(transport.state).toBe("closed");
      await expect(transport.request("GET", "info")).rejects.toThrow(
        /指纹不匹配/,
      );
      // 不再重连：超一个重连基线窗（1s）无新 client 连接
      const clients = relay.clientCount;
      await new Promise((resolve) => setTimeout(resolve, 1800));
      expect(relay.clientCount).toBe(clients);
    } finally {
      await relay.close();
      serverEnd.close();
    }
  }, 15000);
  it("撒谎指纹：ack 带 genuine staticKey + 错误 fingerprint 字段 → 仍受理（自算通过即信任）", async () => {
    const { relay, serverEnd } = await setup("lyingFingerprint");
    try {
      const transport = makeTransport(relay, {
        e2eHandshakeTimeoutMs: 4000,
      });
      const e2eChanges: E2eStatusChange[] = [];
      transport.onE2eState((change) => e2eChanges.push(change));
      await waitFor(() => transport.e2eState === "encrypted");
      // 上报指纹为控制端自算值（=被控端静态对真值），非 wire 谎报字段
      expect(e2eChanges.at(-1)?.fingerprint).toBe(serverEnd.fingerprint);
      const res = await transport.request("GET", "info");
      expect(res.body).toMatchObject({ code: "2000", success: true });
    } finally {
      await relay.close();
      serverEnd.close();
    }
  }, 15000);
});

describe("控制端 relay E2E：降级与门禁", () => {
  it("旧版被控端（hello 无回应）→ 超时重试原 open 帧一次 + 明文承载", async () => {
    const { relay, serverEnd } = await setup("legacy");
    try {
      const transport = makeTransport(relay, { e2eHandshakeTimeoutMs: 150 });
      // 降级完成标志：原 open 帧重发（首连 1 次 + 降级重试 1 次）
      await waitFor(() => serverEnd.opensSeen >= 2);
      expect(transport.e2eState).toBe("plaintext");
      const res = await transport.request("GET", "info");
      expect(res.body).toMatchObject({ code: "2000", success: true });
      // hello 确已发出（被控端忽略）；明文 req 直达
      expect(relay.fromClient.some((f) => f.kind === "e2e-hello")).toBe(true);
      expect(
        serverEnd.frames.some((f) => f.kind === "req" && f.path === "info"),
      ).toBe(true);
    } finally {
      await relay.close();
      serverEnd.close();
    }
  }, 15000);

  it("被控端 required 拒明文降级 → 隧道断开如实呈现（reconnecting）", async () => {
    const { relay, serverEnd } = await setup("rejectPlaintext");
    try {
      const transport = makeTransport(relay, { e2eHandshakeTimeoutMs: 120 });
      await waitFor(() => serverEnd.opensSeen >= 2); // 已降级并重试 open
      await waitFor(() => transport.state === "reconnecting");
      expect(transport.e2eState).toBe("plaintext");
    } finally {
      await relay.close();
      serverEnd.close();
    }
  }, 15000);

  it("连接级 e2e=required：握手无 ack 不降级直接断开（required-failed，不再重连）", async () => {
    const { relay, serverEnd } = await setup("legacy");
    try {
      const transport = makeTransport(relay, {
        e2eHandshakeTimeoutMs: 150,
        e2eMode: "required",
      });
      await waitFor(() => transport.e2eState === "required-failed");
      expect(transport.state).toBe("closed");
      await expect(transport.request("GET", "info")).rejects.toThrow(
        /e2e=required/,
      );
      // 未降级：原 open 不重试（恒 1 次）、无明文 req 出站
      expect(serverEnd.opensSeen).toBe(1);
      expect(relay.fromClient.some((f) => f.kind === "req")).toBe(false);
      // 不再重连：超一个重连基线窗（1s）无新 client 连接
      const clients = relay.clientCount;
      await new Promise((resolve) => setTimeout(resolve, 1800));
      expect(relay.clientCount).toBe(clients);
      expect(transport.state).toBe("closed");
    } finally {
      await relay.close();
      serverEnd.close();
    }
  }, 15000);

  it("会话建立后明文 res（混合通道注入）→ 断开重连，重新协商恢复加密", async () => {
    const { relay, serverEnd } = await setup("auto");
    try {
      const transport = makeTransport(relay, {
        e2eHandshakeTimeoutMs: 4000,
      });
      await waitFor(() => transport.e2eState === "encrypted");
      // 注入明文 res（id 未知也不影响门禁判定：会话后明文业务帧即拒）
      serverEnd.sendPlaintext({
        kind: "res",
        id: 999,
        status: 200,
        body: null,
      });
      await waitFor(() => transport.state === "reconnecting");
      // 新连接重新握手 → 恢复加密（重连自愈，非永久拆链）
      await waitFor(
        () =>
          transport.state === "connected" && transport.e2eState === "encrypted",
        9000,
      );
      const res = await transport.request("GET", "info");
      expect(res.body).toMatchObject({ code: "2000" });
    } finally {
      await relay.close();
      serverEnd.close();
    }
  }, 20000);
});

/** ConnectionConfig 指纹/E2E 模式字段类型面（编译期契约：字段存在且可选） */
describe("ConnectionConfig.fingerprint/e2eMode 类型面", () => {
  it("relay 配置可携带可选指纹与 E2E 模式（校验归一由主进程 validateConfig 收口）", () => {
    const config: ConnectionConfig = {
      id: "c",
      name: "n",
      mode: "relay",
      relayUrl: "ws://127.0.0.1:1/ws",
      relayToken: "t",
      connectionId: "i",
      fingerprint: "0123456789abcdef",
      e2eMode: "required",
    };
    expect(config.fingerprint).toBe("0123456789abcdef");
    expect(config.e2eMode).toBe("required");
  });
});

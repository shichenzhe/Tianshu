// relay E2E 端到端抓帧验证（EE-T4，spec 2026-10-18-relay-e2e §4）：本机
// **真 relay**（tianshu-server 仓 dist/src/relay/relay-main.js 子进程，e2e-
// graph-smoke 同款「sibling 仓产物」事实面）+ 双端真实握手栈——控制端真
// RelayTransport、被控端真 relay-client（server-face node 可测形态：
// setServerFaceDeps 内存替身 + Log/prisma-client 两桩，桩外握手/信封/路由/
// 重连均为生产代码路径）。四链路：
// ① 密文往返：hello→ack→req/res/event 全 e2e-secure 信封（TOFU 指纹自算
//   与被控端静态对一致）
// ② relay 侧零明文：双端与真 relay 之间挂透传抓帧 proxy（ws 库，query
//   原样转接、双向帧全记录——所录即 relay 所见），断言业务哨兵零泄漏、
//   业务帧 kind 全为 e2e-secure（其余仅恒明文生命周期帧 register/open/
//   close/ping/pong）
// ③ 降级路径：被控端 e2e=off（忽略 hello）→ 控制端握手超时降级明文往返
//   成功 + e2e 状态标注 plaintext（抓帧对照：明文 req 含哨兵——与 ② 的
//   反证）
// ④ 指纹不匹配：控制端配错指纹 → ack 即断开 + mitm-suspect + 不再重连
//   （proxy 连接数不增），上报指纹为对端实际值（自算不信任 wire 回显）
// 运行：npm run test:e2e:relayE2E（文件名无 .test. 段不进 vitest 常规集，
// vitest.relay-e2e.config.ts 独立 include——e2e-ui-smoke 同款机制）。
// 环境依赖：apps/tianshu-server 已 npm run build（dist 产物）；缺失即 fail
// fast 并提示（与 e2e-smoke 对产物存在性的假设一致，如实记录见任务报告）。
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../../electron/commons/Log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// option 表内存桩（serverFace 配置行 + e2eKey 静态密钥行——跨链路持久，
// 链路④的「配错指纹」正对此静态对）
const db = vi.hoisted(() => {
  let nextOptionId = 1;
  const optionRows = new Map<
    number,
    { id: number; type: string; name: string; value: string }
  >();
  return {
    optionRows,
    option: {
      findFirst: vi.fn(
        async (args: {
          where: { type: string; name: string };
          select?: { id: true };
        }) => {
          for (const row of optionRows.values()) {
            if (row.type === args.where.type && row.name === args.where.name) {
              return args.select ? { id: row.id } : row;
            }
          }
          return null;
        },
      ),
      update: vi.fn(
        async (args: { where: { id: number }; data: { value: string } }) => {
          const row = optionRows.get(args.where.id);
          if (!row) throw new Error("option 不存在");
          row.value = args.data.value;
          return row;
        },
      ),
      create: vi.fn(
        async (args: {
          data: { type: string; name: string; value: string };
        }) => {
          const id = nextOptionId++;
          const row = { id, ...args.data };
          optionRows.set(id, row);
          return row;
        },
      ),
    },
  };
});
vi.mock("../../../electron/commons/prisma-client", () => ({ default: db }));

import { WebSocket as WsWebSocket, WebSocketServer, type RawData } from "ws";
import { fingerprintOf, parseStaticPair } from "@tianshu/core";
import { RelayTransport } from "../../../electron/domains/server/relay-transport";
import type {
  E2eStatusChange,
  Transport,
} from "../../../electron/domains/server/transport";
import type { ServerEvent } from "../../../electron/domains/server/protocol";
import {
  readServerFaceConfig,
  saveServerFaceConfig,
  type FaceE2eMode,
  type ServerFaceConfig,
} from "../../../electron/domains/server-face/server-face";
import { setServerFaceDeps } from "../../../electron/domains/server-face/deps";
import {
  startRelayClient,
  stopRelayClient,
} from "../../../electron/domains/server-face/relay-client";
import { FACE_INSTANCE_ID } from "../../../electron/domains/server-face/face-info";
import { emitChatChunk } from "../../../electron/domains/server-face/chat-tap";
import type { SessionRecord } from "../../../src-react/domains/ai/api/session.api";

const MIRROR_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const SERVER_DIR =
  process.env.TIANSHU_SERVER_DIR ??
  path.resolve(MIRROR_ROOT, "apps/tianshu-server");
const RELAY_ENTRY = path.join(
  SERVER_DIR,
  "dist",
  "src",
  "relay",
  "relay-main.js",
);
const RELAY_TOKEN = "e2e-relay-token";
const RELAY_BOOT_TIMEOUT_MS = 20_000;
/** 链路④「不再重连」观察窗：覆盖一个默认退避周期（1s 起） */
const NO_RECONNECT_WATCH_MS = 1_600;

// —— 抓帧 proxy：双端 ↔ 真 relay 之间的透传观测点 ——

type TapDirection = "toRelay" | "fromRelay";
interface TapFrame {
  /** 发帧侧的 relay 角色（server=被控端腿 / client=控制端腿） */
  role: "server" | "client" | "?";
  dir: TapDirection;
  text: string;
}

/** RawData 三形态归一 utf8（与 relay 侧 decodeRaw 同口径） */
function rawToText(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  return Buffer.from(raw).toString("utf8");
}

/**
 * 透传抓帧 proxy：query 原样转接（role/token/connectionId 保真——relay
 * 鉴权与注册不受影响），双向帧全记录。所录帧集 = 真 relay 实际转发的
 * 全部帧（「relay 侧零明文」断言的观测依据）。
 */
class RelayTapProxy {
  readonly frames: TapFrame[] = [];
  connections = 0;
  private readonly wss: WebSocketServer;

  private constructor(wss: WebSocketServer) {
    this.wss = wss;
  }

  static async start(upstreamBaseUrl: string): Promise<RelayTapProxy> {
    const wss = new WebSocketServer({ port: 0 });
    const proxy = new RelayTapProxy(wss);
    wss.on("connection", (downstream, req) => {
      proxy.connections += 1;
      const role =
        new URL(req.url ?? "/", "http://tap").searchParams.get("role") ===
        "server"
          ? "server"
          : "client";
      const upstream = new WsWebSocket(`${upstreamBaseUrl}${req.url}`);
      // 上游拨号在下游握手后才起：早到的上行帧先挂账，upstream open 后
      // flush（否则 open/hello 在拨号窗内即被静默丢弃）
      const earlyFrames: string[] = [];
      upstream.on("open", () => {
        for (const text of earlyFrames.splice(0)) upstream.send(text);
      });
      downstream.on("message", (raw) => {
        const text = rawToText(raw);
        proxy.frames.push({ role, dir: "toRelay", text });
        if (upstream.readyState === WsWebSocket.OPEN) upstream.send(text);
        else earlyFrames.push(text);
      });
      upstream.on("message", (raw) => {
        const text = rawToText(raw);
        proxy.frames.push({ role, dir: "fromRelay", text });
        if (downstream.readyState === WsWebSocket.OPEN) downstream.send(text);
      });
      downstream.on("close", () => upstream.close());
      upstream.on("close", () => {
        if (downstream.readyState === WsWebSocket.OPEN)
          downstream.close(1000, "tap-upstream-closed");
      });
      downstream.on("error", () => downstream.terminate());
      upstream.on("error", () => upstream.terminate());
    });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    return proxy;
  }

  get url(): string {
    const { port } = this.wss.address() as { port: number };
    return `ws://127.0.0.1:${port}/ws`;
  }

  /** 抓帧窗口锚点（链路内断言只扫本链路新帧） */
  mark(): number {
    return this.frames.length;
  }

  window(from: number): TapFrame[] {
    return this.frames.slice(from);
  }

  async close(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

function frameKind(frame: TapFrame): unknown {
  try {
    return (JSON.parse(frame.text) as { kind?: unknown }).kind;
  } catch {
    return "<bad-json>";
  }
}

/** 链路②②③④共用：kind 白名单 = 握手/信封 + 恒明文生命周期帧（§2.4） */
const ALLOWED_FRAME_KINDS = new Set([
  "e2e-hello",
  "e2e-ack",
  "e2e-secure",
  "register",
  "open",
  "close",
  "ping",
  "pong",
]);

// —— 真 relay 子进程 ——

interface RealRelay {
  child: ChildProcess;
  baseUrl: string;
}

async function spawnRealRelay(): Promise<RealRelay> {
  if (!fs.existsSync(RELAY_ENTRY)) {
    throw new Error(
      `真 relay 产物缺失：${RELAY_ENTRY}——tianshu-server 仓先 npm run build（E2E 环境依赖，见文件头注）`,
    );
  }
  const child = spawn(
    process.execPath,
    [RELAY_ENTRY, "--port", "0", "--token", RELAY_TOKEN],
    { cwd: SERVER_DIR, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderrTail = "";
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `relay 启动超时（${RELAY_BOOT_TIMEOUT_MS}ms 无 listening 行）stderr: ${stderrTail.slice(-300)}`,
          ),
        ),
      RELAY_BOOT_TIMEOUT_MS,
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      const match = /listening on port (\d+)/.exec(chunk.toString("utf8"));
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `relay 进程早退 code=${code} stderr: ${stderrTail.slice(-300)}`,
        ),
      );
    });
  });
  return { child, baseUrl: `ws://127.0.0.1:${port}` };
}

async function stopRealRelay(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 3_000);
    child.once("exit", () => {
      clearTimeout(killTimer);
      resolve();
    });
  });
}

// —— 被控面装配（真 relay-client + 内存替身）——

/** 链路内可变的会话数据源（session/query 数据面） */
const sessionStore: SessionRecord[] = [];

function makeFaceDeps(): void {
  setServerFaceDeps({
    sessions: {
      async getSession() {
        return null;
      },
      async createSession() {
        return {} as never;
      },
      async listAllSessions() {
        return [...sessionStore];
      },
      // D7a7036c 优化批数据面（回归修复 2026-10-27）：session/query 走
      // querySessions 下推分页——替身最小实现（keyword 大小写敏感包含，
      // 契约同 repo；enrich 字段本链路不消费）
      async querySessions(params, _userId) {
        const page = params?.page ?? 1;
        const pageSize = params?.pageSize ?? 50;
        const keyword =
          typeof params?.keyword === "string" && params.keyword !== ""
            ? params.keyword
            : null;
        const matched = keyword
          ? sessionStore.filter((row) => (row.title ?? "").includes(keyword))
          : [...sessionStore];
        return {
          page,
          pageSize,
          records: matched.slice((page - 1) * pageSize, page * pageSize),
          total: matched.length,
        };
      },
      async getSessionById() {
        throw new Error("SESSION_NOT_FOUND");
      },
      async deleteSession() {},
      async listMessages() {
        return { items: [], hasMore: false, nextBeforeId: null };
      },
    },
    chat: {
      send: async () => {},
      stop: () => {},
      respondApproval: () => false,
    },
    resolveUserId: async () => 7,
    resolveDefaultWorkspaceId: async () => 3,
    approvals: { respond: () => false },
    providers: { listBundle: async () => ({ providers: [], models: [] }) },
    images: { readImage: async () => null },
    info: async () => ({
      name: "tianshu-desktop",
      version: "0.0.0-e2e",
      instanceId: FACE_INSTANCE_ID,
      capabilities: ["chat", "provider"],
      username: "测试用户",
    }),
  });
}

const faceConfig = (e2e: FaceE2eMode): ServerFaceConfig => ({
  enabled: false,
  port: 0,
  token: "",
  host: "127.0.0.1",
  e2e,
});

function setFaceSessionTitle(title: string): void {
  sessionStore.length = 0;
  sessionStore.push({
    id: 101,
    workspaceId: 3,
    title,
    mode: "agent",
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:00:00.000Z",
  });
}

/** 被控端静态对指纹（option 桩行直读——「配错指纹」链路的对照真值） */
function faceStaticFingerprint(): string {
  const row = [...db.optionRows.values()].find(
    (item) => item.name === "serverFace.e2eKey",
  );
  if (!row) throw new Error("被控端静态密钥行缺失（首链路握手应已惰性生成）");
  return fingerprintOf(parseStaticPair(row.value).publicKey);
}

// —— 等待器 ——

async function waitFor(
  label: string,
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor 超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

/** 订阅某类协议事件的到达 Promise（超时兜错） */
function nextEvent(
  transport: Transport,
  type: ServerEvent["type"],
  timeoutMs = 5_000,
): Promise<ServerEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`等待事件 ${type} 超时`)),
      timeoutMs,
    );
    const off = transport.onEvent((event) => {
      if (event.type === type) {
        clearTimeout(timer);
        off();
        resolve(event);
      }
    });
  });
}

function trackE2eChanges(transport: Transport): E2eStatusChange[] {
  const changes: E2eStatusChange[] = [];
  transport.onE2eState((change) => changes.push(change));
  return changes;
}

// —— 场景 ——

describe("relay E2E 端到端（真 relay 子进程 + 双端真实握手栈 + 抓帧 proxy）", () => {
  let relay: RealRelay;
  let proxy: RelayTapProxy;

  beforeAll(async () => {
    relay = await spawnRealRelay();
    proxy = await RelayTapProxy.start(relay.baseUrl);
    makeFaceDeps();
    await saveServerFaceConfig(faceConfig("auto"));
    expect((await readServerFaceConfig()).e2e).toBe("auto");
    await startRelayClient(proxy.url, RELAY_TOKEN);
  }, 40_000);

  afterAll(async () => {
    stopRelayClient();
    if (proxy) await proxy.close();
    if (relay) await stopRealRelay(relay.child);
  });

  it("链路① 密文往返：hello→ack→req/res/event 全 e2e-secure 信封", async () => {
    const sentinel = `e2e-rt-${randomUUID().slice(0, 8)}`;
    setFaceSessionTitle(`会话-${sentinel}`);
    const transport = new RelayTransport({
      relayUrl: proxy.url,
      relayToken: RELAY_TOKEN,
      connectionId: FACE_INSTANCE_ID,
    });
    try {
      const changes = trackE2eChanges(transport);
      // 先订阅再等握手（server.connected 由握手后首个密文 GET info 合成，
      // 晚订阅会与事件到达赛跑）
      const connectedPromise = nextEvent(transport, "server.connected");
      await waitFor(
        "握手迁 encrypted",
        () => transport.e2eState === "encrypted",
      );
      // TOFU：encrypted 上报指纹 = 被控端静态对指纹（自算不信任 wire 回显）
      expect(changes.at(-1)?.fingerprint).toBe(faceStaticFingerprint());

      // 连接级合成事件：GET info 走密文 req/res（announceConnected）
      const connected = await connectedPromise;
      expect(connected.payload).toMatchObject({
        instanceId: FACE_INSTANCE_ID,
      });

      // 密文 req → 密文 res（哨兵经加密信道往返后回显）
      const res = await transport.request("POST", "session/query", {
        page: 1,
        keyword: sentinel,
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        code: "2000",
        success: true,
        data: { total: 1 },
      });
      expect(JSON.stringify(res.body)).toContain(sentinel);

      // 密文 event：chat tap → face 事件总线 → 信封 event 帧 → 控制端
      const chunkText = `${sentinel}-chunk`;
      const chunkEventPromise = nextEvent(transport, "message.chunk");
      emitChatChunk(101, { type: "text-delta", text: chunkText });
      const chunkEvent = await chunkEventPromise;
      expect(chunkEvent.payload).toMatchObject({
        sessionId: 101,
        chunk: { type: "text-delta", text: chunkText },
      });
    } finally {
      transport.close();
    }
  }, 20_000);

  it("链路② relay 侧零明文：抓帧无哨兵、业务帧 kind 全为 e2e-secure", async () => {
    const sentinel = `e2e-plain-${randomUUID().slice(0, 8)}`;
    setFaceSessionTitle(`会话-${sentinel}`);
    const mark = proxy.mark();
    const transport = new RelayTransport({
      relayUrl: proxy.url,
      relayToken: RELAY_TOKEN,
      connectionId: FACE_INSTANCE_ID,
    });
    try {
      await waitFor(
        "握手迁 encrypted",
        () => transport.e2eState === "encrypted",
      );
      const res = await transport.request("POST", "session/query", {
        page: 1,
        keyword: sentinel,
      });
      expect(JSON.stringify(res.body)).toContain(sentinel);
      const chunkText = `${sentinel}-chunk`;
      const chunkEventPromise = nextEvent(transport, "message.chunk");
      emitChatChunk(101, { type: "text-delta", text: chunkText });
      await chunkEventPromise;

      const window = proxy.window(mark);
      // 帧型收口：窗口内只允许握手/信封帧 + 恒明文生命周期帧
      const kinds = new Set(window.map(frameKind));
      for (const kind of kinds) {
        expect(
          ALLOWED_FRAME_KINDS.has(kind as string),
          `relay 视野出现非白名单帧 kind=${String(kind)}`,
        ).toBe(true);
      }
      // 密文信封确实双向过 relay：请求向（client→relay）与应答/事件向
      // （server→relay）均有 e2e-secure 帧
      expect(
        window.some(
          (frame) =>
            frame.role === "client" &&
            frame.dir === "toRelay" &&
            frameKind(frame) === "e2e-secure",
        ),
      ).toBe(true);
      expect(
        window.some(
          (frame) =>
            frame.role === "server" &&
            frame.dir === "toRelay" &&
            frameKind(frame) === "e2e-secure",
        ),
      ).toBe(true);
      // 哨兵零泄漏：全量捕获（含握手段与回程 res）任何帧原文不含哨兵
      // ——relay 对业务载荷零知识
      for (const frame of proxy.frames) {
        expect(frame.text).not.toContain(sentinel);
        expect(frame.text).not.toContain(chunkText);
      }
    } finally {
      transport.close();
    }
  }, 20_000);

  it("链路③ 降级：被控端 e2e=off → 控制端明文往返 + plaintext 标注", async () => {
    stopRelayClient();
    await saveServerFaceConfig(faceConfig("off"));
    await startRelayClient(proxy.url, RELAY_TOKEN);
    const sentinel = `e2e-deg-${randomUUID().slice(0, 8)}`;
    setFaceSessionTitle(`会话-${sentinel}`);
    const mark = proxy.mark();
    const transport = new RelayTransport({
      relayUrl: proxy.url,
      relayToken: RELAY_TOKEN,
      connectionId: FACE_INSTANCE_ID,
      e2eHandshakeTimeoutMs: 400,
    });
    try {
      const changes = trackE2eChanges(transport);
      await waitFor("ws 连接", () => transport.state === "connected");
      // request 先等握手落定（超时降级）再发——明文 req 由此过 relay
      const res = await transport.request("POST", "session/query", {
        page: 1,
        keyword: sentinel,
      });
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).toContain(sentinel);
      // 状态标注：降级后恒 plaintext，从未出现 encrypted
      expect(transport.e2eState).toBe("plaintext");
      expect(changes.some((change) => change.state === "encrypted")).toBe(
        false,
      );
      // 抓帧对照（与链路②互为反证）：降级路径 req 以明文过 relay 且含哨兵
      // （announceConnected 的 GET info 也是明文 req——按哨兵精确定位）
      const plainReq = proxy
        .window(mark)
        .find(
          (frame) =>
            frame.role === "client" &&
            frame.dir === "toRelay" &&
            frameKind(frame) === "req" &&
            frame.text.includes(sentinel),
        );
      expect(plainReq?.text).toContain(sentinel);
    } finally {
      transport.close();
    }
  }, 20_000);

  it("链路④ 指纹不匹配：配错指纹 → 断开 + mitm-suspect + 不再重连", async () => {
    stopRelayClient();
    await saveServerFaceConfig(faceConfig("auto"));
    await startRelayClient(proxy.url, RELAY_TOKEN);
    const transport = new RelayTransport({
      relayUrl: proxy.url,
      relayToken: RELAY_TOKEN,
      connectionId: FACE_INSTANCE_ID,
      fingerprint: "deadbeefdeadbeef",
    });
    try {
      const changes = trackE2eChanges(transport);
      await waitFor(
        "指纹不匹配迁 mitm-suspect",
        () => transport.e2eState === "mitm-suspect",
      );
      expect(transport.state).toBe("closed");
      // 上报指纹为对端实际值（自算），非控制端配置的错值
      expect(changes.at(-1)?.fingerprint).toBe(faceStaticFingerprint());
      expect(changes.at(-1)?.fingerprint).not.toBe("deadbeefdeadbeef");
      // 后续请求即拒（mitm 态不复活）
      await expect(transport.request("GET", "info")).rejects.toThrow(
        /指纹不匹配/,
      );
      // 不再重连：观察窗覆盖一个默认退避周期（1s 起），proxy 无新连接
      const connectionsAtMitm = proxy.connections;
      await new Promise((resolve) =>
        setTimeout(resolve, NO_RECONNECT_WATCH_MS),
      );
      expect(proxy.connections).toBe(connectionsAtMitm);
      expect(transport.state).toBe("closed");
    } finally {
      transport.close();
    }
  }, 20_000);
});

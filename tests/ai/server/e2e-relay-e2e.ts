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
// ⑤-⑩ jwt 多租户链路（Task 18，spec 2026-11-03-relay-multitenant）：另起
//   真 relay 子进程于 jwt 模式（--auth-pubkey 测试密钥 + --internal-secret），
//   测试内以生产同源 jwt-eddsa 模块（apps/tianshu-server 源直引）签发双租户
//   access，raw ws 双端观测 close code 与帧转发——
// ⑤ 双租户隔离：A-client attach B-server → close 4007（tenant-forbidden）
// ⑥ 顶号：B-server 注册 A 已占 connectionId → close 4006（id-conflict）
// ⑦ 配额：quota.maxServers=1 第二个 server 连接 → close 4005
// ⑧ kick：POST /internal/kick {tenantId} → 本租户在线连接被拆、他租户
//   与租户记账无扰
// ⑨ CRL：stub 控制平面名单命中某 ak → 该 ak 新连接 4001、存量连接不断
// ⑩ 存量长寿命：access TTL 到期只拦新连接（4001）、存量配对双向照转发
//   （spec §5.3——relay 不存 exp、不定时拆连接）
// 运行：npm run test:e2e:relayE2E（文件名无 .test. 段不进 vitest 常规集，
// vitest.relay-e2e.config.ts 独立 include——e2e-ui-smoke 同款机制）。
// 环境依赖：apps/tianshu-server 已 npm run build（dist 产物）；缺失即 fail
// fast 并提示（与 e2e-smoke 对产物存在性的假设一致，如实记录见任务报告）。
import { spawn, type ChildProcess } from "node:child_process";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import fs from "node:fs";
import os from "node:os";
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
import { RELAY_CLOSE_CODES } from "@tianshu/protocol";
import { fingerprintOf, parseStaticPair } from "@tianshu/core";
import {
  generateEd25519KeyPems,
  signAccessJwt,
  type AccessClaims,
  type AccessQuota,
} from "../../../apps/tianshu-server/src/relay/jwt-eddsa";
import { openSecret } from "../../../electron/domains/security/secret-field";
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
/** jwt 链路内部端点凭证（/internal/kick、/internal/stats 与 CRL 拉取同源） */
const JWT_INTERNAL_SECRET = "e2e-internal-secret";
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
      // 安全批 I：凭证出 query 后 URL 不再携带 role——连接角色改为
      // 首帧嗅探（auth.role 字段；register=server/open=client 兜底）
      let role: "server" | "client" | null = null;
      const resolveRole = (text: string): "server" | "client" => {
        try {
          const frame = JSON.parse(text) as { kind?: string; role?: string };
          if (
            frame?.kind === "auth" &&
            (frame.role === "server" || frame.role === "client")
          )
            return frame.role;
          if (frame?.kind === "register") return "server";
          if (frame?.kind === "open") return "client";
        } catch {
          /* 坏帧按默认 client 记（与旧 query 缺省口径一致） */
        }
        return "client";
      };
      const upstream = new WsWebSocket(`${upstreamBaseUrl}${req.url}`);
      // 上游拨号在下游握手后才起：早到的上行帧先挂账，upstream open 后
      // flush（否则 open/hello 在拨号窗内即被静默丢弃）
      const earlyFrames: string[] = [];
      upstream.on("open", () => {
        for (const text of earlyFrames.splice(0)) upstream.send(text);
      });
      downstream.on("message", (raw) => {
        const text = rawToText(raw);
        if (role === null) role = resolveRole(text);
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
  // auth=鉴权首帧（安全批 I）：token 对 relay 可见是协议固有（relay 须验
  // 凭证）——与 query 时代等价，改善的是凭证不经反代访问日志；业务帧
  // 仍必须全部在 e2e-secure 信封内
  "auth",
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
  port: number;
}

/** 以给定 CLI 参数起真 relay 子进程并等 listening 行（static/jwt 链路共用
 *  同一启动面，仅参数不同） */
async function spawnRelayProcess(args: string[]): Promise<RealRelay> {
  if (!fs.existsSync(RELAY_ENTRY)) {
    throw new Error(
      `真 relay 产物缺失：${RELAY_ENTRY}——tianshu-server 仓先 npm run build（E2E 环境依赖，见文件头注）`,
    );
  }
  const child = spawn(process.execPath, [RELAY_ENTRY, ...args], {
    cwd: SERVER_DIR,
    stdio: ["ignore", "pipe", "pipe"],
  });
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
  return { child, baseUrl: `ws://127.0.0.1:${port}`, port };
}

/** static 模式（现状四链路）：共享 token 鉴权 */
async function spawnRealRelay(): Promise<RealRelay> {
  return spawnRelayProcess(["--port", "0", "--token", RELAY_TOKEN]);
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

/** 被控端静态对指纹（option 桩行直读——「配错指纹」链路的对照真值；
 *  批三·B 起静态密钥行经 option-secrets 字段级信封密封，先解封再解析） */
async function faceStaticFingerprint(): Promise<string> {
  const row = [...db.optionRows.values()].find(
    (item) => item.name === "serverFace.e2eKey",
  );
  if (!row) throw new Error("被控端静态密钥行缺失（首链路握手应已惰性生成）");
  const stored = await openSecret("serverFace.e2eKey", row.value);
  if (!stored) throw new Error("静态密钥行解封失败（master-key 不可用）");
  return fingerprintOf(parseStaticPair(stored).publicKey);
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

// —— jwt 多租户链路辅助（Task 18）——

/** jwt 链路 relay 句柄：子进程 + 双协议入口（ws 升级 / 内部端点 http） */
interface JwtRelay {
  child: ChildProcess;
  wsUrl: string;
  httpUrl: string;
}

/** relay 侧帧的最小观测面（kind + 透传字段原样记录） */
type WireFrame = { kind: string } & Record<string, unknown>;

/** raw ws 对端：直连 relay（不经 tap proxy——本组观测 close code 与帧
 *  转发，不采集 relay 视野全帧），帧与 close 事件全记录 */
interface RawPeer {
  ws: WsWebSocket;
  frames: WireFrame[];
  /** ws close 事件（code/reason），一次性 settle */
  closeInfo: Promise<{ code: number; reason: string }>;
}

function rawConnect(relayWsUrl: string): Promise<RawPeer> {
  return new Promise((resolve, reject) => {
    const ws = new WsWebSocket(relayWsUrl);
    const frames: WireFrame[] = [];
    let settleClose!: (info: { code: number; reason: string }) => void;
    const closeInfo = new Promise<{ code: number; reason: string }>(
      (resolveClose) => {
        settleClose = resolveClose;
      },
    );
    let opened = false;
    ws.on("open", () => {
      opened = true;
      resolve({ ws, frames, closeInfo });
    });
    ws.on("error", (error: Error) => {
      if (!opened) reject(error);
    });
    ws.on("message", (raw) => {
      try {
        const frame = JSON.parse(rawToText(raw)) as WireFrame;
        if (typeof frame?.kind === "string") frames.push(frame);
      } catch {
        /* 非 JSON 帧忽略（本链路 relay 只发 JSON） */
      }
    });
    ws.on("close", (code: number, reason: Buffer) => {
      settleClose({ code, reason: reason.toString("utf8") });
    });
  });
}

/** 首帧 auth（与 RelayTransport/relay-client 同构——凭证承载 + 角色 +
 *  注册键；connectionId 仅 server 角色携带，对齐真实双端） */
function sendAuth(
  peer: RawPeer,
  token: string,
  role: "server" | "client",
  connectionId?: string,
): void {
  const frame: Record<string, unknown> = { kind: "auth", token, role };
  if (role === "server") frame.connectionId = connectionId;
  peer.ws.send(JSON.stringify(frame));
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`withTimeout 超时：${label}`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** 等本端收到首个匹配帧（帧到达即同步入账，轮询即可） */
async function waitForFrame(
  peer: RawPeer,
  predicate: (frame: WireFrame) => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<WireFrame> {
  await waitFor(label, () => peer.frames.some(predicate), timeoutMs);
  return peer.frames.find(predicate) as WireFrame;
}

/** 等 ws close 并断言 code（多租户三闸门的 wire 契约观察点） */
async function expectCloseCode(
  peer: RawPeer,
  code: number,
  label: string,
): Promise<void> {
  const info = await withTimeout(peer.closeInfo, 5_000, `${label} 等待关闭`);
  expect(info.code, `${label} close code（reason=${info.reason}）`).toBe(code);
}

/** waitFor 的异步谓词版（内部端点轮询——谓词含网络往返） */
async function waitForAsync(
  label: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`waitFor 超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

type TenantStat = { tenantId: string; servers: number; clients: number };

/** 轮询 GET /internal/stats 至断言命中——server 注册 / client 配对的
 *  确定性同步点（首帧 auth 无回执，以记账为凭），顺带钉死内部端点租户
 *  簿记接线 */
async function waitTenantStats(
  relay: JwtRelay,
  matches: (tenants: TenantStat[]) => boolean,
  label: string,
): Promise<void> {
  await waitForAsync(label, async () => {
    try {
      const res = await fetch(`${relay.httpUrl}/internal/stats`, {
        headers: { authorization: `Bearer ${JWT_INTERNAL_SECRET}` },
      });
      const body = (await res.json()) as { tenants?: TenantStat[] };
      return matches(body.tenants ?? []);
    } catch {
      return false; // relay 启动窗内的瞬时失败按未命中重试
    }
  });
}

/** jwt 链路配对装配：server 首帧 auth 注册（stats 记账可见为准）→
 *  client auth + open（server 收到转发 open 帧即配对成立） */
async function pairOverRelay(
  relay: JwtRelay,
  connectionId: string,
  serverToken: string,
  clientToken: string,
  tenantId: string,
): Promise<{ server: RawPeer; client: RawPeer }> {
  const server = await rawConnect(relay.wsUrl);
  sendAuth(server, serverToken, "server", connectionId);
  await waitTenantStats(
    relay,
    (tenants) =>
      tenants.some((item) => item.tenantId === tenantId && item.servers >= 1),
    `${tenantId} server 注册记账`,
  );
  const client = await rawConnect(relay.wsUrl);
  sendAuth(client, clientToken, "client");
  client.ws.send(JSON.stringify({ kind: "open", connectionId }));
  await waitForFrame(
    server,
    (frame) => frame.kind === "open",
    `server 收 open（${connectionId}）`,
  );
  return { server, client };
}

/** 配对后的双向转发验证：client 发 req（id 全局唯一）→ server 收到 →
 *  回 res → client 收到——jwt 链路的业务帧转发面（明文 req/res 直转，
 *  加密封装属链路①-④ 的既有覆盖面） */
let rawReqSeq = 0;
async function roundtripFrames(
  pair: { server: RawPeer; client: RawPeer },
  label: string,
): Promise<void> {
  rawReqSeq += 1;
  const id = rawReqSeq;
  pair.client.ws.send(
    JSON.stringify({ kind: "req", id, method: "GET", path: "info" }),
  );
  await waitForFrame(
    pair.server,
    (frame) => frame.kind === "req" && frame.id === id,
    `${label}：server 收 req#${id}`,
  );
  pair.server.ws.send(
    JSON.stringify({ kind: "res", id, status: 200, body: { via: label } }),
  );
  await waitForFrame(
    pair.client,
    (frame) => frame.kind === "res" && frame.id === id,
    `${label}：client 收 res#${id}`,
  );
}

/** CRL 名单应用收敛探针：auth 后即收 4001 = 名单已应用（目标态）；
 *  存活（300ms 无 close）= 未应用，探针拆断重试。名单落地是 refresh()
 *  的异步 continuation，「stub 响应已回」≠「已应用」，以拒新本身为
 *  收敛点 */
async function eventuallyRejectedAtAuth(
  relayWsUrl: string,
  token: string,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const probe = await rawConnect(relayWsUrl);
    sendAuth(probe, token, "client");
    const code = await Promise.race([
      probe.closeInfo.then((info) => info.code),
      new Promise<number>((resolve) => setTimeout(() => resolve(0), 300)),
    ]);
    probe.ws.terminate();
    // 4001 invalid-token：CRL 命中与凭证失败同归因（不区分原因）
    if (code === 4001) return;
    if (Date.now() > deadline)
      throw new Error(`等待 4001 超时（${label}，末次探针 code=${code}）`);
  }
}

/** CRL 控制平面 stub（Task 12 契约形状 {epoch, revokedAk, revokedTenant}）：
 *  首次响应挂起至 release()——「存量先建、名单后到」的时序控制器（relay
 *  冷启动立即首拉而周期缺省 45s 不可等，故以挂起首响应构造名单落地前
 *  的窗口；单次拉取超时 5s，挂起窗须在其内） */
class CrlAdminStub {
  requests = 0;
  responsesSent = 0;
  private readonly revokedAk: string[];
  private readonly server: HttpServer;
  private readonly firstReleased: Promise<void>;
  private releaseFirst: () => void = () => {};

  private constructor(server: HttpServer, revokedAk: string[]) {
    this.server = server;
    this.revokedAk = revokedAk;
    this.firstReleased = new Promise((resolve) => {
      this.releaseFirst = resolve;
    });
  }

  static async start(revokedAk: string[]): Promise<CrlAdminStub> {
    const holder: { stub?: CrlAdminStub } = {};
    const server = createHttpServer((req, res) => {
      void holder.stub?.handle(req, res);
    });
    const stub = new CrlAdminStub(server, revokedAk);
    holder.stub = stub;
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    return stub;
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.url?.split("?")[0] !== "/relay-admin/revocations") {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${JWT_INTERNAL_SECRET}`) {
      res.writeHead(403).end();
      return;
    }
    this.requests += 1;
    if (this.requests === 1) await this.firstReleased;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        epoch: 1,
        revokedAk: this.revokedAk,
        revokedTenant: [],
      }),
    );
    this.responsesSent += 1;
  }

  /** 放行挂起的首拉响应（名单自此对 relay 可见） */
  release(): void {
    this.releaseFirst();
  }

  get url(): string {
    const { port } = this.server.address() as { port: number };
    return `http://127.0.0.1:${port}`;
  }

  async close(): Promise<void> {
    this.release(); // 兜底放行挂起响应，防句柄滞留
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

function closePeers(peers: RawPeer[]): void {
  for (const peer of peers) peer.ws.terminate();
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
      expect(changes.at(-1)?.fingerprint).toBe(await faceStaticFingerprint());

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
      expect(changes.at(-1)?.fingerprint).toBe(await faceStaticFingerprint());
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

describe("relay E2E 多租户 jwt 链路（真 relay 子进程 + 测试内签发 EdDSA access）", () => {
  let jwtKeys: { publicKeyPem: string; privateKeyPem: string };
  let keyDir: string;

  beforeAll(() => {
    // 生产同源签发栈（relay-admin 侧模块，源码直引）：测试持私钥签发，
    // 子进程 relay（dist 产物）持公钥验签——真跨进程 EdDSA 往返
    jwtKeys = generateEd25519KeyPems();
    keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-relay-jwt-"));
    fs.writeFileSync(path.join(keyDir, "auth-pub.pem"), jwtKeys.publicKeyPem);
  });

  afterAll(() => {
    fs.rmSync(keyDir, { recursive: true, force: true });
  });

  /** jwt 模式起 relay（--auth-pubkey 测试公钥 + --internal-secret） */
  function spawnJwtRelay(extraArgs: string[] = []): Promise<JwtRelay> {
    return spawnRelayProcess([
      "--port",
      "0",
      "--auth-pubkey",
      path.join(keyDir, "auth-pub.pem"),
      "--internal-secret",
      JWT_INTERNAL_SECRET,
      ...extraArgs,
    ]).then(({ child, baseUrl, port }) => ({
      child,
      wsUrl: `${baseUrl}/ws`,
      httpUrl: `http://127.0.0.1:${port}`,
    }));
  }

  /** 测试内签发 access JWT（缺省 10 分钟 TTL / 配额 5×5） */
  function issueAccess(params: {
    tid: string;
    role: "server" | "client";
    ak?: string;
    quota?: AccessQuota;
    ttlSec?: number;
  }): string {
    const nowSec = Math.floor(Date.now() / 1000);
    const claims: AccessClaims = {
      iss: "tianshu-relay",
      sub: `e2e-${params.tid}`,
      tid: params.tid,
      role: params.role,
      ak: params.ak ?? `ak-${randomUUID().slice(0, 8)}`,
      quota: params.quota ?? { maxServers: 5, maxClients: 5 },
      iat: nowSec,
      exp: nowSec + (params.ttlSec ?? 600),
      jti: randomUUID(),
    };
    return signAccessJwt(claims, jwtKeys.privateKeyPem);
  }

  it("jwt⑤ 双租户隔离：A-client attach B-server → close 4007", async () => {
    const relay = await spawnJwtRelay();
    const peers: RawPeer[] = [];
    try {
      const connectionId = "e2e-jwt-tenant-b";
      const pair = await pairOverRelay(
        relay,
        connectionId,
        issueAccess({ tid: "tenant-b", role: "server", ak: "ak-b1" }),
        issueAccess({ tid: "tenant-b", role: "client", ak: "ak-b2" }),
        "tenant-b",
      );
      peers.push(pair.server, pair.client);

      // A 租户控制端（自身凭证合法、目标属他租户）：open B 被控端 → 4007
      const aClient = await rawConnect(relay.wsUrl);
      peers.push(aClient);
      sendAuth(
        aClient,
        issueAccess({ tid: "tenant-a", role: "client", ak: "ak-a1" }),
        "client",
      );
      aClient.ws.send(JSON.stringify({ kind: "open", connectionId }));
      // 拆连接前先收 tenant-forbidden close 帧（sendDirect 即时回执）
      const closeFrame = await waitForFrame(
        aClient,
        (frame) => frame.kind === "close",
        "A-client 收 tenant-forbidden close 帧",
      );
      expect(closeFrame.reason).toBe("tenant-forbidden");
      await expectCloseCode(
        aClient,
        RELAY_CLOSE_CODES.TENANT_FORBIDDEN,
        "A-client 跨租户 attach",
      );

      // B 配对无扰：A 的 open 未透传给 B 被控端（仍只见 B-client 一帧）
      expect(
        pair.server.frames.filter((frame) => frame.kind === "open"),
      ).toHaveLength(1);
      // 记账面：A-client 未成功 attach 不入账，仅 tenant-b 一行
      await waitTenantStats(
        relay,
        (tenants) =>
          tenants.length === 1 &&
          tenants[0].tenantId === "tenant-b" &&
          tenants[0].servers === 1 &&
          tenants[0].clients === 1,
        "4007 后记账仅 tenant-b",
      );
      await roundtripFrames(pair, "隔离被拒后 B 租户往返");
    } finally {
      closePeers(peers);
      await stopRealRelay(relay.child);
    }
  }, 20_000);

  it("jwt⑥ 顶号：B-server 注册 A 已占 connectionId → close 4006", async () => {
    const relay = await spawnJwtRelay();
    const peers: RawPeer[] = [];
    try {
      const connectionId = "e2e-jwt-occupied";
      const aServer = await rawConnect(relay.wsUrl);
      peers.push(aServer);
      sendAuth(
        aServer,
        issueAccess({ tid: "tenant-a", role: "server", ak: "ak-a1" }),
        "server",
        connectionId,
      );
      await waitTenantStats(
        relay,
        (tenants) =>
          tenants.some(
            (item) => item.tenantId === "tenant-a" && item.servers === 1,
          ),
        "A server 注册记账",
      );

      // B 租户被控端抢注同 connectionId → 4006（现有注册不动、B 不入账）
      const bServer = await rawConnect(relay.wsUrl);
      peers.push(bServer);
      sendAuth(
        bServer,
        issueAccess({ tid: "tenant-b", role: "server", ak: "ak-b1" }),
        "server",
        connectionId,
      );
      await expectCloseCode(
        bServer,
        RELAY_CLOSE_CODES.ID_CONFLICT,
        "B 抢注他租户 connectionId",
      );
      expect(aServer.ws.readyState).toBe(WsWebSocket.OPEN);
      await waitTenantStats(
        relay,
        (tenants) =>
          tenants.length === 1 &&
          tenants[0].tenantId === "tenant-a" &&
          tenants[0].servers === 1,
        "4006 后记账仍仅 tenant-a",
      );

      // A 仍是注册方：A-client 照常配对 + 双向转发
      const aClient = await rawConnect(relay.wsUrl);
      peers.push(aClient);
      sendAuth(
        aClient,
        issueAccess({ tid: "tenant-a", role: "client", ak: "ak-a2" }),
        "client",
      );
      aClient.ws.send(JSON.stringify({ kind: "open", connectionId }));
      await waitForFrame(
        aServer,
        (frame) => frame.kind === "open",
        "A-client 配对 open",
      );
      await roundtripFrames(
        { server: aServer, client: aClient },
        "顶号被拒后 A 配对往返",
      );
    } finally {
      closePeers(peers);
      await stopRealRelay(relay.child);
    }
  }, 20_000);

  it("jwt⑦ 配额：quota.maxServers=1 时第二个 server 连接 → close 4005", async () => {
    const relay = await spawnJwtRelay();
    const peers: RawPeer[] = [];
    try {
      const quota: AccessQuota = { maxServers: 1, maxClients: 5 };
      const first = await rawConnect(relay.wsUrl);
      peers.push(first);
      sendAuth(
        first,
        issueAccess({ tid: "tenant-a", role: "server", ak: "ak-a1", quota }),
        "server",
        "e2e-jwt-quota-1",
      );
      await waitTenantStats(
        relay,
        (tenants) =>
          tenants.some(
            (item) => item.tenantId === "tenant-a" && item.servers === 1,
          ),
        "首个 server 占位记账",
      );

      // 同租户第二个 server 连接（不同 connectionId=新增占位）→ 4005
      const second = await rawConnect(relay.wsUrl);
      peers.push(second);
      sendAuth(
        second,
        issueAccess({ tid: "tenant-a", role: "server", ak: "ak-a1b", quota }),
        "server",
        "e2e-jwt-quota-2",
      );
      await expectCloseCode(
        second,
        RELAY_CLOSE_CODES.QUOTA_EXCEEDED,
        "第二 server 连接超配额",
      );

      // 首个连接无扰：client 配对与往返照常（maxClients=5 未触顶）
      const client = await rawConnect(relay.wsUrl);
      peers.push(client);
      sendAuth(
        client,
        issueAccess({ tid: "tenant-a", role: "client", ak: "ak-a2", quota }),
        "client",
      );
      client.ws.send(
        JSON.stringify({ kind: "open", connectionId: "e2e-jwt-quota-1" }),
      );
      await waitForFrame(
        first,
        (frame) => frame.kind === "open",
        "配额内 client 配对 open",
      );
      await roundtripFrames({ server: first, client }, "4005 后配额内配对往返");
    } finally {
      closePeers(peers);
      await stopRealRelay(relay.child);
    }
  }, 20_000);

  it("jwt⑧ kick：POST /internal/kick 拆本租户在线连接、他租户无扰", async () => {
    const relay = await spawnJwtRelay();
    const peers: RawPeer[] = [];
    try {
      const pairA = await pairOverRelay(
        relay,
        "e2e-jwt-kick-a",
        issueAccess({ tid: "tenant-a", role: "server", ak: "ak-a1" }),
        issueAccess({ tid: "tenant-a", role: "client", ak: "ak-a2" }),
        "tenant-a",
      );
      const pairB = await pairOverRelay(
        relay,
        "e2e-jwt-kick-b",
        issueAccess({ tid: "tenant-b", role: "server", ak: "ak-b1" }),
        issueAccess({ tid: "tenant-b", role: "client", ak: "ak-b2" }),
        "tenant-b",
      );
      peers.push(pairA.server, pairA.client, pairB.server, pairB.client);
      await roundtripFrames(pairA, "kick 前 A 往返");
      await roundtripFrames(pairB, "kick 前 B 往返");

      const res = await fetch(`${relay.httpUrl}/internal/kick`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${JWT_INTERNAL_SECRET}`,
        },
        body: JSON.stringify({ tenantId: "tenant-a" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ kicked: 2 });

      // A 双腿被拆：server 先收 kicked close 帧（notifyClose 通知）再
      // terminate；client 无告别帧直拆——两者均以 close 事件为凭
      await waitForFrame(
        pairA.server,
        (frame) => frame.kind === "close" && frame.reason === "kicked",
        "A-server 收 kicked close 帧",
      );
      await withTimeout(pairA.server.closeInfo, 5_000, "A-server 拆除");
      await withTimeout(pairA.client.closeInfo, 5_000, "A-client 拆除");

      // B 无扰 + 记账回落：stats 只剩 tenant-b 一行
      await roundtripFrames(pairB, "kick 后 B 往返");
      await waitTenantStats(
        relay,
        (tenants) =>
          tenants.length === 1 &&
          tenants[0].tenantId === "tenant-b" &&
          tenants[0].servers === 1 &&
          tenants[0].clients === 1,
        "kick 后记账回落仅 tenant-b",
      );
    } finally {
      closePeers(peers);
      await stopRealRelay(relay.child);
    }
  }, 20_000);

  it("jwt⑨ CRL：名单命中 ak 拒新连接 4001、存量连接不断", async () => {
    const crl = await CrlAdminStub.start(["ak-revoked"]);
    const relay = await spawnJwtRelay(["--crl-admin-url", crl.url]);
    const peers: RawPeer[] = [];
    try {
      // 首拉挂起窗内建立存量配对（ak-revoked 此刻不在名单，正常准入）
      const pair = await pairOverRelay(
        relay,
        "e2e-jwt-crl-x",
        issueAccess({ tid: "tenant-x", role: "server", ak: "ak-revoked" }),
        issueAccess({ tid: "tenant-x", role: "client", ak: "ak-x2" }),
        "tenant-x",
      );
      peers.push(pair.server, pair.client);
      await roundtripFrames(pair, "吊销前往返");

      // 放行首拉 → 名单落地 → 该 ak 的新连接 4001（探针重试至拒）
      crl.release();
      await waitFor("CRL 首拉响应送达", () => crl.responsesSent >= 1);
      await eventuallyRejectedAtAuth(
        relay.wsUrl,
        issueAccess({ tid: "tenant-x", role: "client", ak: "ak-revoked" }),
        "吊销 ak 新连接",
      );

      // 存量零扰动：既有配对仍双向转发（CRL 只在 admit 消费，不拆存量）
      await roundtripFrames(pair, "吊销后存量往返");

      // 名单外 ak 新连接照常放行（不扩大打击面）
      const cleanServer = await rawConnect(relay.wsUrl);
      peers.push(cleanServer);
      sendAuth(
        cleanServer,
        issueAccess({ tid: "tenant-y", role: "server", ak: "ak-clean" }),
        "server",
        "e2e-jwt-crl-clean",
      );
      await waitTenantStats(
        relay,
        (tenants) =>
          tenants.some(
            (item) => item.tenantId === "tenant-y" && item.servers === 1,
          ),
        "名单外 ak 放行记账",
      );
    } finally {
      closePeers(peers);
      await stopRealRelay(relay.child);
      await crl.close();
    }
  }, 20_000);

  it("jwt⑩ 存量长寿命：access TTL 到期只拦新连接、存量双向照转发（§5.3）", async () => {
    const relay = await spawnJwtRelay();
    const peers: RawPeer[] = [];
    try {
      const ttlSec = 2;
      const serverToken = issueAccess({
        tid: "tenant-a",
        role: "server",
        ak: "ak-a1",
        ttlSec,
      });
      const clientToken = issueAccess({
        tid: "tenant-a",
        role: "client",
        ak: "ak-a2",
        ttlSec,
      });
      const pair = await pairOverRelay(
        relay,
        "e2e-jwt-longevity",
        serverToken,
        clientToken,
        "tenant-a",
      );
      peers.push(pair.server, pair.client);
      await roundtripFrames(pair, "TTL 窗内往返");

      // 等 TTL 过线（exp 在签发秒边界 +2s，实际 2-3s 内到期，等 3.5s 必过）
      await new Promise((resolve) =>
        setTimeout(resolve, ttlSec * 1000 + 1_500),
      );

      // 存量契约：连接不拆、双向照转发（relay 不存 exp、不定时拆连接）
      expect(pair.server.ws.readyState).toBe(WsWebSocket.OPEN);
      expect(pair.client.ws.readyState).toBe(WsWebSocket.OPEN);
      await roundtripFrames(pair, "TTL 过线后存量往返");

      // 新连接持同 token（此刻已过期）→ 4001——TTL 只拦新连接/重连
      const stale = await rawConnect(relay.wsUrl);
      peers.push(stale);
      sendAuth(stale, serverToken, "server", "e2e-jwt-stale-reconnect");
      await expectCloseCode(stale, 4001, "过期 token 新连接");
    } finally {
      closePeers(peers);
      await stopRealRelay(relay.child);
    }
  }, 20_000);
});

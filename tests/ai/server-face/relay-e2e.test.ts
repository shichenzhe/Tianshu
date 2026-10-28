// relay E2E 被控端握手与信封（spec 2026-10-18-relay-e2e §2.2/§3.2，E2E-T2）：
// @tianshu/core e2e-crypto 三方消费之二（server-face 被控端；控制端
// RelayTransport 为 T3）。本机 ws 库模拟 relay 充当中继/控制端双重替身：
// - 握手往返：e2e-hello（临时公钥）→ e2e-ack（静态公钥+指纹）→ 业务帧
//   e2e-secure 信封往返（req→res；wire 断言不含明文哨兵——relay 零知识）
// - 静态密钥惰性生成与持久化：首次握手落 option 行 serverFace.e2eKey；
//   断线重连重新握手静态公钥不变（同静态对）
// - e2e=required：明文业务帧被拒（断开，无 res）
// - e2e=off：忽略 e2e-hello（旧版语义），明文业务帧照常
// - 会话建立后明文 req（混合通道）/篡改信封 → 断开（GCM/协议错收口）
// - 重放相同 hello 被忽略（会话不重置）+ 其后重放旧密文 req 被拒（EE 终审 F1）
// - IPC：serverFace:status 扩 e2e 字段（模式/公钥/指纹）；setEnabled 合并 e2e
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandlers = vi.hoisted(
  () => new Map<string, (...args: unknown[]) => unknown>(),
);

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) =>
      ipcHandlers.set(channel, fn),
  },
  app: {
    getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`),
    getAppPath: vi.fn(() => `/tmp/tianshu-test-app-${process.pid}`),
    isPackaged: false,
    getVersion: vi.fn(() => "0.0.0-test"),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock("../../../electron/commons/Log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// option 行内存库（serverFace 配置 + e2eKey 静态密钥持久化）
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

import { WebSocketServer, type WebSocket } from "ws";
import {
  E2E_SECURE_KIND,
  createE2ESession,
  deriveSessionKeys,
  fingerprintOf,
  generateEphemeralPair,
  type E2ESession,
  type E2ESecureEnvelope,
} from "@tianshu/core";
import { setServerFaceDeps } from "../../../electron/domains/server-face/deps";
import type { ServerFaceSessions } from "../../../electron/domains/server-face/deps";
import {
  readServerFaceConfig,
  saveServerFaceConfig,
  type ServerFaceConfig,
} from "../../../electron/domains/server-face/server-face";
import {
  startRelayClient,
  stopRelayClient,
} from "../../../electron/domains/server-face/relay-client";
import { attachServerFace } from "../../../electron/domains/server-face/ipc";
import { FACE_INSTANCE_ID } from "../../../electron/domains/server-face/face-info";
import { emitChatChunk } from "../../../electron/domains/server-face/chat-tap";

const TOKEN = "face-secret";
const E2E_KEY_OPTION_NAME = "serverFace.e2eKey";

// —— 测试替身：最小 sessions/chat（session/query 路由数据源）——
function makeDeps() {
  const sessions: ServerFaceSessions = {
    async getSession() {
      return null;
    },
    async createSession() {
      return {} as never;
    },
    async listAllSessions() {
      return [];
    },
    // P1 未读角标批：enriched 数据源替身（本链路无相关断言）
    async listAllSessionsSummarized() {
      return [];
    },
    // face 全表扫描优化批：query 数据源替身（密文帧往返断言空页）
    async querySessions() {
      return { page: 1, pageSize: 100, records: [], total: 0 };
    },
    async getSessionSummary() {
      return null;
    },
    async markSessionRead() {
      return { sessionId: 1, lastReadMessageId: 1, unreadCount: 0 };
    },
    async getSessionById() {
      throw new Error("SESSION_NOT_FOUND");
    },
    async deleteSession() {},
    async listMessages() {
      return { items: [], hasMore: false, nextBeforeId: null };
    },
  };
  setServerFaceDeps({
    sessions,
    chat: { send: vi.fn(), stop: vi.fn(), respondApproval: vi.fn() },
    resolveUserId: async () => 7,
    resolveDefaultWorkspaceId: async () => 3,
    approvals: { respond: () => false },
    providers: { listBundle: async () => ({ providers: [], models: [] }) },
    images: { readImage: async () => null },
    info: async () => ({
      name: "tianshu-desktop",
      version: "0.0.0-test",
      instanceId: FACE_INSTANCE_ID,
      capabilities: [],
      username: "测试用户",
    }),
  });
}

interface TrackedConn {
  ws: WebSocket;
  frames: Array<Record<string, unknown>>;
  waitForFrame(
    predicate: (frame: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
}

function trackConn(ws: WebSocket): TrackedConn {
  const frames: Array<Record<string, unknown>> = [];
  const pending: {
    predicate: (frame: Record<string, unknown>) => boolean;
    resolve: (frame: Record<string, unknown>) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];
  ws.on("message", (raw) => {
    const frame = JSON.parse(String(raw)) as Record<string, unknown>;
    frames.push(frame);
    const index = pending.findIndex((item) => item.predicate(frame));
    if (index >= 0) {
      const [item] = pending.splice(index, 1);
      clearTimeout(item.timer);
      item.resolve(frame);
    }
  });
  return {
    ws,
    frames,
    waitForFrame(predicate, timeoutMs = 4000) {
      const hit = frames.find(predicate);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        pending.push({
          predicate,
          resolve,
          timer: setTimeout(
            () =>
              reject(
                new Error(
                  `waitForFrame 超时，已收帧: ${JSON.stringify(frames)}`,
                ),
              ),
            timeoutMs,
          ),
        });
      });
    },
  };
}

/** 本机 ws 模拟 relay（升级记录 query、帧原样回环） */
async function startFakeRelay() {
  const conns: TrackedConn[] = [];
  const wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (ws) => conns.push(trackConn(ws)));
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const address = wss.address() as { port: number };
  return {
    url: `ws://127.0.0.1:${address.port}/ws`,
    conns,
    async close() {
      for (const conn of conns) conn.ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

const seedOption = async (config: Partial<ServerFaceConfig>) => {
  await saveServerFaceConfig({
    enabled: false,
    port: 0,
    token: "",
    host: "127.0.0.1",
    ...config,
  });
};

/** 控制端视角握手（T1 报告消费提示口径）：hello 临时公钥 → ack 静态公钥 */
async function shakeHands(
  conn: TrackedConn,
): Promise<{ session: E2ESession; staticKey: string; fingerprint: string }> {
  const ephemeral = generateEphemeralPair();
  conn.ws.send(
    JSON.stringify({
      kind: "e2e-hello",
      ephemeralKey: ephemeral.publicKey.toString("base64"),
    }),
  );
  const ack = await conn.waitForFrame((f) => f.kind === "e2e-ack");
  const staticKey = ack.staticKey as string;
  const fingerprint = ack.fingerprint as string;
  expect(fingerprintOf(staticKey)).toBe(fingerprint);
  const keys = deriveSessionKeys({
    ephemeralPrivateKey: ephemeral.privateKey,
    staticPublicKey: Buffer.from(staticKey, "base64"),
    connectionId: FACE_INSTANCE_ID,
  });
  return { session: createE2ESession(keys, "client"), staticKey, fingerprint };
}

/** 控制端发密文业务帧 */
function sendSealed(conn: TrackedConn, session: E2ESession, frame: unknown) {
  conn.ws.send(JSON.stringify(session.seal(JSON.stringify(frame))));
}

/** 控制端收密文帧并解封为业务帧 */
function openSealed(
  session: E2ESession,
  frame: Record<string, unknown>,
): Record<string, unknown> {
  expect(frame.kind).toBe(E2E_SECURE_KIND);
  return JSON.parse(
    session.open(frame as unknown as E2ESecureEnvelope).toString("utf8"),
  ) as Record<string, unknown>;
}

/** 连接关闭等待器 */
function waitClosed(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => ws.once("close", () => resolve()));
}

/** 断言一段时间内无新帧到达（反证型等待） */
async function expectNoNewFrames(
  conn: TrackedConn,
  timeoutMs: number,
): Promise<void> {
  const before = conn.frames.length;
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  expect(conn.frames.length).toBe(before);
}

beforeEach(() => {
  db.optionRows.clear();
  makeDeps();
});

afterEach(() => {
  stopRelayClient();
});

describe("relay E2E 握手与信封（被控端，默认 auto 模式）", () => {
  it("hello→ack→信封 req→res 往返；wire 无明文；静态密钥惰性落库", async () => {
    const relay = await startFakeRelay();
    try {
      await startRelayClient(relay.url, TOKEN);
      const conn = relay.conns[0];
      await conn.waitForFrame((f) => f.kind === "register");

      const { session, staticKey, fingerprint } = await shakeHands(conn);
      expect(staticKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
      expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);

      // 密文业务帧往返：sealed req → sealed res（解封后 starter 包装体）
      sendSealed(conn, session, {
        kind: "req",
        id: 7,
        method: "POST",
        path: "session/query",
        body: { page: 1 },
      });
      const rawRes = await conn.waitForFrame((f) => f.kind === E2E_SECURE_KIND);
      // wire 零明文断言：密文帧不含业务哨兵（relay 只见密文）
      expect(JSON.stringify(rawRes)).not.toContain("session/query");
      const res = openSealed(session, rawRes);
      expect(res).toMatchObject({ kind: "res", id: 7, status: 200 });
      expect(res.body).toMatchObject({
        code: "2000",
        success: true,
        data: { records: [], total: 0 },
      });

      // 密钥持久化：option 行已落（serializeStaticPair 前缀形态）
      const keyRow = [...db.optionRows.values()].find(
        (row) => row.name === E2E_KEY_OPTION_NAME,
      );
      expect(keyRow?.value).toMatch(/^tianshu-e2e-static-v1:/);
    } finally {
      await relay.close();
    }
  });

  it("活性帧恒明文：会话中 ping→pong 直通（活性不依赖加密态）", async () => {
    const relay = await startFakeRelay();
    try {
      await startRelayClient(relay.url, TOKEN);
      const conn = relay.conns[0];
      await conn.waitForFrame((f) => f.kind === "register");
      const { session } = await shakeHands(conn);

      conn.ws.send(JSON.stringify({ kind: "ping" }));
      const pong = await conn.waitForFrame((f) => f.kind === "pong", 5000);
      expect(pong).toEqual({ kind: "pong" });

      // 信封通道不受影响：ping 后密文 req 照常
      sendSealed(conn, session, {
        kind: "req",
        id: 8,
        method: "GET",
        path: "/session/query",
        body: null,
      });
      const rawRes = await conn.waitForFrame((f) => f.kind === E2E_SECURE_KIND);
      expect(openSealed(session, rawRes)).toMatchObject({ id: 8, status: 200 });
    } finally {
      await relay.close();
    }
  });

  it("断线重连：同静态公钥重新握手（静态对跨连接持久）", async () => {
    const relay = await startFakeRelay();
    try {
      await startRelayClient(relay.url, TOKEN);
      const first = await shakeHands(relay.conns[0]);

      relay.conns[0].ws.terminate();
      await waitFor(() => relay.conns.length >= 2, 5000);
      await relay.conns[1].waitForFrame((f) => f.kind === "register", 5000);

      const second = await shakeHands(relay.conns[1]);
      expect(second.staticKey).toBe(first.staticKey);
      expect(second.fingerprint).toBe(first.fingerprint);
    } finally {
      await relay.close();
    }
  });

  it("会话建立后明文业务帧 → 断开（混合通道拒）", async () => {
    const relay = await startFakeRelay();
    try {
      await startRelayClient(relay.url, TOKEN);
      const conn = relay.conns[0];
      await conn.waitForFrame((f) => f.kind === "register");
      await shakeHands(conn);

      const closed = waitClosed(conn.ws);
      conn.ws.send(
        JSON.stringify({
          kind: "req",
          id: 9,
          method: "GET",
          path: "session/query",
        }),
      );
      await closed;
      await expectNoNewFrames(conn, 300);
      expect(conn.frames.some((f) => f.kind === "res" && f.id === 9)).toBe(
        false,
      );
    } finally {
      await relay.close();
    }
  });

  it("篡改信封 → 断开（GCM 认证失败协议错收口）", async () => {
    const relay = await startFakeRelay();
    try {
      await startRelayClient(relay.url, TOKEN);
      const conn = relay.conns[0];
      await conn.waitForFrame((f) => f.kind === "register");
      const { session } = await shakeHands(conn);

      const envelope = session.seal(JSON.stringify("tamper-me"));
      const corrupted =
        envelope.ct.slice(0, -2) + (envelope.ct.endsWith("AA") ? "BB" : "AA");
      const closed = waitClosed(conn.ws);
      conn.ws.send(JSON.stringify({ ...envelope, ct: corrupted }));
      await closed;
      await expectNoNewFrames(conn, 300);
    } finally {
      await relay.close();
    }
  });

  it("重放相同 hello 被忽略：会话不重置，其后重放旧密文 req 被拒（EE 终审 F1）", async () => {
    const relay = await startFakeRelay();
    try {
      await startRelayClient(relay.url, TOKEN);
      const conn = relay.conns[0];
      await conn.waitForFrame((f) => f.kind === "register");

      // 控制端握手（持住临时钥，以便其后字节级重放同一 hello）
      const ephemeral = generateEphemeralPair();
      const helloFrame = JSON.stringify({
        kind: "e2e-hello",
        ephemeralKey: ephemeral.publicKey.toString("base64"),
      });
      conn.ws.send(helloFrame);
      const ack = await conn.waitForFrame((f) => f.kind === "e2e-ack");
      const session = createE2ESession(
        deriveSessionKeys({
          ephemeralPrivateKey: ephemeral.privateKey,
          staticPublicKey: Buffer.from(ack.staticKey as string, "base64"),
          connectionId: FACE_INSTANCE_ID,
        }),
        "client",
      );

      // 首次密文 req 正常往返（计数器 1 进真实会话重放窗）
      const sealedReq = session.seal(
        JSON.stringify({
          kind: "req",
          id: 21,
          method: "GET",
          path: "session/query",
        }),
      );
      conn.ws.send(JSON.stringify(sealedReq));
      const rawRes = await conn.waitForFrame((f) => f.kind === E2E_SECURE_KIND);
      expect(openSealed(session, rawRes)).toMatchObject({
        id: 21,
        status: 200,
      });

      // 重放字节相同的 hello：被忽略（无第二个 ack=会话未重置；连接不拆）
      conn.ws.send(helloFrame);
      await expectNoNewFrames(conn, 300);
      expect(conn.ws.readyState).toBe(conn.ws.OPEN);

      // 其后重放旧密文 req（同 nonce 计数器，窗口内已见）→ 重放拒断开；
      // 若 hello 重放重置了会话，此处会产出第二个 id=21 res（重执行面）
      const closed = waitClosed(conn.ws);
      conn.ws.send(JSON.stringify(sealedReq));
      await closed;
      await expectNoNewFrames(conn, 300);
      expect(conn.frames.filter((f) => f.kind === E2E_SECURE_KIND).length).toBe(
        1,
      );
    } finally {
      await relay.close();
    }
  });

  it("全零 ephemeralKey hello → 忽略不断连，后续合法 hello 仍建立", async () => {
    const relay = await startFakeRelay();
    try {
      await startRelayClient(relay.url, TOKEN);
      const conn = relay.conns[0];
      await conn.waitForFrame((f) => f.kind === "register");

      // 低阶全零公钥：core 派生抛错（EE-T1 审查 F1）→ 本端忽略不拆连接
      conn.ws.send(
        JSON.stringify({
          kind: "e2e-hello",
          ephemeralKey: Buffer.alloc(32).toString("base64"),
        }),
      );
      await expectNoNewFrames(conn, 300);
      expect(conn.ws.readyState).toBe(conn.ws.OPEN);

      const { session } = await shakeHands(conn);
      sendSealed(conn, session, {
        kind: "req",
        id: 12,
        method: "GET",
        path: "session/query",
      });
      const rawRes = await conn.waitForFrame((f) => f.kind === E2E_SECURE_KIND);
      expect(openSealed(session, rawRes)).toMatchObject({
        id: 12,
        status: 200,
      });
    } finally {
      await relay.close();
    }
  });

  it("未握手收 e2e-secure → 断开（无会话即无密钥，协议错收口）", async () => {
    const relay = await startFakeRelay();
    try {
      await startRelayClient(relay.url, TOKEN);
      const conn = relay.conns[0];
      await conn.waitForFrame((f) => f.kind === "register");

      const closed = waitClosed(conn.ws);
      conn.ws.send(
        JSON.stringify({
          kind: E2E_SECURE_KIND,
          n: Buffer.alloc(12).toString("base64"),
          ct: Buffer.alloc(32).toString("base64"),
        }),
      );
      await closed;
      await expectNoNewFrames(conn, 300);
    } finally {
      await relay.close();
    }
  });
});

describe("relay E2E 模式（required / off）", () => {
  it("required：明文业务帧被拒（断开，无 res）", async () => {
    await seedOption({ e2e: "required" });
    const relay = await startFakeRelay();
    try {
      await startRelayClient(relay.url, TOKEN);
      const conn = relay.conns[0];
      await conn.waitForFrame((f) => f.kind === "register");

      const closed = waitClosed(conn.ws);
      conn.ws.send(
        JSON.stringify({
          kind: "req",
          id: 10,
          method: "GET",
          path: "session/query",
        }),
      );
      await closed;
      await expectNoNewFrames(conn, 300);
      expect(conn.frames.some((f) => f.kind === "res")).toBe(false);
    } finally {
      await relay.close();
    }
  });

  it("required 未握手：出站 event 帧被丢弃（零明文 wire，连接不拆）", async () => {
    await seedOption({ e2e: "required" });
    const relay = await startFakeRelay();
    try {
      await startRelayClient(relay.url, TOKEN);
      const conn = relay.conns[0];
      await conn.waitForFrame((f) => f.kind === "register");

      // face 事件推送：required 且未握手 → 业务帧不得明文出站（不降级）
      emitChatChunk(1, { type: "text-delta", text: "密" });
      await expectNoNewFrames(conn, 300);
      expect(conn.frames.some((f) => f.kind === "event")).toBe(false);
      expect(conn.ws.readyState).toBe(conn.ws.OPEN);
    } finally {
      await relay.close();
    }
  });

  it("off：忽略 e2e-hello（旧版语义），明文业务帧照常", async () => {
    await seedOption({ e2e: "off" });
    const relay = await startFakeRelay();
    try {
      await startRelayClient(relay.url, TOKEN);
      const conn = relay.conns[0];
      await conn.waitForFrame((f) => f.kind === "register");

      const ephemeral = generateEphemeralPair();
      conn.ws.send(
        JSON.stringify({
          kind: "e2e-hello",
          ephemeralKey: ephemeral.publicKey.toString("base64"),
        }),
      );
      await expectNoNewFrames(conn, 400);

      conn.ws.send(
        JSON.stringify({
          kind: "req",
          id: 11,
          method: "GET",
          path: "session/query",
        }),
      );
      const res = await conn.waitForFrame(
        (f) => f.kind === "res" && f.id === 11,
      );
      expect(res.status).toBe(200);
    } finally {
      await relay.close();
    }
  });
});

describe("IPC：serverFace:status / setEnabled 扩 e2e 字段", () => {
  it("status 惰性生成并回显公钥/指纹/模式；setEnabled 合并 e2e 模式", async () => {
    attachServerFace({
      sessions: {
        async getSession() {
          return null;
        },
        async createSession() {
          return {} as never;
        },
        async listAllSessions() {
          return [];
        },
        // P1 未读角标批：enriched 数据源替身（本链路无相关断言）
        async listAllSessionsSummarized() {
          return [];
        },
        // face 全表扫描优化批：query 数据源替身（status 链路不涉）
        async querySessions() {
          return { page: 1, pageSize: 100, records: [], total: 0 };
        },
        async getSessionSummary() {
          return null;
        },
        async markSessionRead() {
          return { sessionId: 1, lastReadMessageId: 1, unreadCount: 0 };
        },
        async getSessionById() {
          throw new Error("SESSION_NOT_FOUND");
        },
        async deleteSession() {},
        async listMessages() {
          return { items: [], hasMore: false, nextBeforeId: null };
        },
      },
      chatService: { send: vi.fn(), stop: vi.fn(), respondApproval: vi.fn() },
      providerRepo: {} as never,
      modelRepo: {} as never,
    });

    const status = (await (
      ipcHandlers.get("serverFace:status") as () => unknown
    )()) as {
      e2eMode: string;
      e2ePublicKey: string;
      e2eFingerprint: string;
      e2eActive: boolean;
    };
    // 默认 auto；status 查询即惰性生成静态对（设置面指纹带外传递入口）
    expect(status.e2eMode).toBe("auto");
    expect(status.e2ePublicKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(status.e2eFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprintOf(status.e2ePublicKey)).toBe(status.e2eFingerprint);
    expect(status.e2eActive).toBe(false);

    // setEnabled 合并 e2e 模式（status 回显新值；静态对不随模式切换重生）
    const updated = (await (
      ipcHandlers.get("serverFace:setEnabled") as (
        ...args: unknown[]
      ) => unknown
    )(undefined, { enabled: false, e2e: "required" })) as {
      e2eMode: string;
      e2ePublicKey: string;
    };
    expect(updated.e2eMode).toBe("required");
    expect(updated.e2ePublicKey).toBe(status.e2ePublicKey);
    expect((await readServerFaceConfig()).e2e).toBe("required");

    // 非法模式值拒绝（回落只读快照，配置不动）
    const rejected = (await (
      ipcHandlers.get("serverFace:setEnabled") as (
        ...args: unknown[]
      ) => unknown
    )(undefined, { enabled: false, e2e: "yolo" })) as { e2eMode: string };
    expect(rejected.e2eMode).toBe("required");
    expect((await readServerFaceConfig()).e2e).toBe("required");
  });
});

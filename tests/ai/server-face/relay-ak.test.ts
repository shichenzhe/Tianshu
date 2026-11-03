// relay AK 凭证通道（relay 多租户 Task 15 / spec §5.4 消费侧）：
// - IPC 三字段配置面（akId/akSecret/adminUrl）：setEnabled 合并落库 +
//   status 回显；AK 三要素齐备且无 relayToken 时 relay 连接首帧 auth
//   token=换发的 access（Basic 出示 akId:akSecret）
// - static 优先零漂移：relayToken 在场时零 AK 请求（解析层短路 +
//   startRelayClient 装配层守卫双层）
// - 续期循环（T14 语义同构）：shouldRenew 真值换新（10min 巡检测试注入
//   短间隔）；续期换新后断线重连用新 token（auth 首帧读当前值）；续期
//   401 = AK 失效粘滞终局（断开 + 告警 + 不再重连）；启动 401 干净失败
//   不连 relay；瞬态失败退避重试；stop 清理续期计时器（停用无泄漏）
// - admin 桩：node:http 最小行为（记录 Basic 出示 + 可编程响应序列）
import http from "node:http";
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
}));
vi.mock("../../../electron/commons/Log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// option 行内存库（serverFace 配置持久化/恢复 + e2eKey 行）
const db = vi.hoisted(() => {
  let nextOptionId = 1;
  const optionRows = new Map<
    number,
    { id: number; type: string; name: string; value: string }
  >();
  return {
    optionRows,
    user: { findFirst: vi.fn(async () => ({ id: 7 })) },
    workspace: { findFirst: vi.fn(async () => ({ id: 3 })) },
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
import Log from "../../../electron/commons/Log";
import {
  setServerFaceDeps,
  type ServerFaceSessions,
} from "../../../electron/domains/server-face/deps";
import { readServerFaceConfig } from "../../../electron/domains/server-face/server-face";
import {
  isRelayConnected,
  startRelayClient,
  stopRelayClient,
} from "../../../electron/domains/server-face/relay-client";
import { attachServerFace } from "../../../electron/domains/server-face/ipc";
import type { SessionRecord } from "../../../src-react/domains/ai/api/session.api";

const logError = vi.mocked(Log.error);

// —— 测试替身：最小 sessions + chat（relay 连接路径不触业务路由）——
function makeDeps() {
  const sessions: ServerFaceSessions = {
    async getSession() {
      return null;
    },
    async createSession() {
      return {} as SessionRecord;
    },
    async listAllSessions() {
      return [];
    },
    async listAllSessionsSummarized() {
      return [];
    },
    async querySessions() {
      return { page: 1, pageSize: 100, records: [], total: 0 };
    },
    async getSessionSummary() {
      return null;
    },
    async markSessionRead() {
      return { sessionId: 1, lastMessageId: 9, unreadCount: 0 };
    },
    async getSessionById() {
      throw new Error("SESSION_NOT_FOUND");
    },
    async deleteSession() {},
    async listMessages() {
      return { items: [], hasMore: false, nextBeforeId: null };
    },
  };
  const chat = { send: vi.fn(), stop: vi.fn() };
  setServerFaceDeps({
    sessions,
    chat,
    resolveUserId: async () => 7,
    resolveDefaultWorkspaceId: async () => 3,
    approvals: {
      respondRemember: async () => ({ hit: false, remembered: false }),
    },
    providers: { listBundle: async () => ({ providers: [], models: [] }) },
    images: { readImage: async () => null },
    info: async () => ({
      name: "tianshu-desktop",
      version: "0.0.0-test",
      instanceId: "iid",
      capabilities: [],
      username: null,
    }),
  });
  return { sessions, chat };
}

// —— 本机 ws 模拟 relay（server-face.test 同款）——
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

// —— node:http 模拟 relay-admin token 端点（T12 契约消费面）——
interface AdminResponse {
  status: number;
  body: unknown;
}

/** access TTL 对齐 T12 真实值（30d）——shouldRenew 半衰阈值随之真实 */
const ACCESS_MAX_AGE_SEC = 30 * 24 * 3600;
/** 短剩余（60s < 半衰 15d）：首个巡检周期 shouldRenew 即真值 */
const REMAIN_SHORT_MS = 60_000;
/** 满剩余（30d）：巡检恒不触发续期 */
const REMAIN_FULL_MS = ACCESS_MAX_AGE_SEC * 1000;

function accessEnvelope(token: string, remainingMs: number): AdminResponse {
  return {
    status: 200,
    body: {
      code: "2000",
      message: "ok",
      data: {
        accessToken: token,
        expiresAt: Date.now() + remainingMs,
        maxAgeSec: ACCESS_MAX_AGE_SEC,
      },
    },
  };
}

const unauthorized = (): AdminResponse => ({
  status: 401,
  body: { code: "4010", success: false, data: null, message: "AK 已被禁用" },
});

async function startFakeAdmin(
  respond: (index: number) => AdminResponse | Promise<AdminResponse>,
) {
  const requests: Array<{
    method: string;
    url: string;
    authorization: string | undefined;
  }> = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const index = requests.length;
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: req.headers.authorization,
      });
      void Promise.resolve(respond(index)).then((out) => {
        res.writeHead(out.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out.body));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const akCreds = (adminUrl: string) => ({
  adminUrl,
  akId: "ak-test",
  akSecret: "sk-test",
});

/** 等待谓词成立（续期/重连异步收口轮询） */
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

const waitClosed = (ws: WebSocket) =>
  new Promise<void>((resolve) => ws.on("close", () => resolve()));

beforeEach(() => {
  db.optionRows.clear();
  makeDeps();
  logError.mockClear();
});

afterEach(() => {
  stopRelayClient();
});

describe("IPC：serverFace AK 三字段配置面（akId/akSecret/adminUrl）", () => {
  it("AK 三字段配置后 relay 连接使用换发的 access（首帧 auth token=access；Basic 出示 akId:akSecret；status 回显三字段）", async () => {
    const relay = await startFakeRelay();
    const admin = await startFakeAdmin(() =>
      accessEnvelope("ipc-access", REMAIN_FULL_MS),
    );
    try {
      const wired = makeDeps();
      attachServerFace({
        sessions: wired.sessions,
        chatService: wired.chat,
      });
      const setEnabled = ipcHandlers.get("serverFace:setEnabled") as (
        ...args: unknown[]
      ) => Promise<unknown>;

      const status = (await setEnabled(undefined, {
        enabled: true,
        port: 0,
        relayUrl: relay.url,
        adminUrl: admin.url,
        akId: "ak-ipc",
        akSecret: "sk-ipc",
      })) as {
        akId: string;
        akSecret: string;
        adminUrl: string;
        relayConnected: boolean;
      };

      // 换发请求：POST /relay-admin/token + Basic base64(akId:akSecret)
      expect(admin.requests.length).toBe(1);
      expect(admin.requests[0].method).toBe("POST");
      expect(admin.requests[0].url).toBe("/relay-admin/token");
      expect(admin.requests[0].authorization).toBe(
        `Basic ${Buffer.from("ak-ipc:sk-ipc").toString("base64")}`,
      );

      // 首帧 auth 使用换发的 access（非 AK 凭证本身）
      const auth = await relay.conns[0].waitForFrame((f) => f.kind === "auth");
      expect(auth).toMatchObject({ token: "ipc-access", role: "server" });

      // status 回显 + option 持久化往返（akSecret 与 relayToken 同敏感级口径）
      expect(status).toMatchObject({
        akId: "ak-ipc",
        akSecret: "sk-ipc",
        adminUrl: admin.url,
        relayConnected: true,
      });
      await expect(readServerFaceConfig()).resolves.toMatchObject({
        akId: "ak-ipc",
        akSecret: "sk-ipc",
        adminUrl: admin.url,
      });
    } finally {
      await relay.close();
      await admin.close();
    }
  });

  it("static 优先：relayToken 在场时零 AK 请求（解析层短路）", async () => {
    const relay = await startFakeRelay();
    const admin = await startFakeAdmin(() =>
      accessEnvelope("unused", REMAIN_FULL_MS),
    );
    try {
      const wired = makeDeps();
      attachServerFace({
        sessions: wired.sessions,
        chatService: wired.chat,
      });
      const setEnabled = ipcHandlers.get("serverFace:setEnabled") as (
        ...args: unknown[]
      ) => Promise<unknown>;

      const status = (await setEnabled(undefined, {
        enabled: true,
        port: 0,
        relayUrl: relay.url,
        relayToken: "static-ipc",
        adminUrl: admin.url,
        akId: "ak-ipc",
        akSecret: "sk-ipc",
      })) as { relayConnected: boolean };

      expect(admin.requests.length).toBe(0); // token 在场 → AK 机制整体旁路
      const auth = await relay.conns[0].waitForFrame((f) => f.kind === "auth");
      expect(auth.token).toBe("static-ipc");
      expect(status.relayConnected).toBe(true);
    } finally {
      await relay.close();
      await admin.close();
    }
  });

  it("AK 缺要素（无 adminUrl）不成 AK 模式：不连 relay 零换发请求", async () => {
    const relay = await startFakeRelay();
    const admin = await startFakeAdmin(() =>
      accessEnvelope("unused", REMAIN_FULL_MS),
    );
    try {
      const wired = makeDeps();
      attachServerFace({
        sessions: wired.sessions,
        chatService: wired.chat,
      });
      const setEnabled = ipcHandlers.get("serverFace:setEnabled") as (
        ...args: unknown[]
      ) => Promise<unknown>;

      const status = (await setEnabled(undefined, {
        enabled: true,
        port: 0,
        relayUrl: relay.url,
        akId: "ak-ipc",
        akSecret: "sk-ipc",
      })) as { relayConnected: boolean };

      expect(status.relayConnected).toBe(false);
      expect(admin.requests.length).toBe(0);
      expect(relay.conns.length).toBe(0);
    } finally {
      await relay.close();
      await admin.close();
    }
  });
});

describe("startRelayClient 装配层守卫（static 优先零漂移）", () => {
  it("token 与 ak 同传：AK 整体旁路（零 admin 请求，auth token=static）", async () => {
    const relay = await startFakeRelay();
    const admin = await startFakeAdmin(() =>
      accessEnvelope("unused", REMAIN_FULL_MS),
    );
    try {
      await startRelayClient(relay.url, "static-wins", {
        ak: akCreds(admin.url),
        renewCheckIntervalMs: 60,
      });
      expect(admin.requests.length).toBe(0);
      const auth = await relay.conns[0].waitForFrame((f) => f.kind === "auth");
      expect(auth.token).toBe("static-wins");
    } finally {
      await relay.close();
      await admin.close();
    }
  });

  it("未配 token 且无 AK 拒启（不裸连）", async () => {
    await expect(startRelayClient("ws://127.0.0.1:1/ws", "")).rejects.toThrow(
      /token/,
    );
  });
});

describe("AK 续期循环（T14 语义同构）", () => {
  it("续期换新后断线重连用新 token（auth 首帧读当前值，存量连接不拆）", async () => {
    const relay = await startFakeRelay();
    const admin = await startFakeAdmin((index) =>
      index === 0
        ? accessEnvelope("access-old", REMAIN_SHORT_MS)
        : accessEnvelope("access-new", REMAIN_FULL_MS),
    );
    try {
      await startRelayClient(relay.url, "", {
        ak: akCreds(admin.url),
        renewCheckIntervalMs: 60,
      });
      expect(
        (await relay.conns[0].waitForFrame((f) => f.kind === "auth")).token,
      ).toBe("access-old");

      // 短剩余 → 巡检即续期（内存换新，不拆存量连接——D5 语义）
      await waitFor(() => admin.requests.length >= 2);
      expect(isRelayConnected()).toBe(true);

      // 断线 → 退避重连 → 首帧 auth 用新 access
      relay.conns[0].ws.terminate();
      await waitFor(() => relay.conns.length >= 2, 5000);
      const auth2 = await relay.conns[1].waitForFrame(
        (f) => f.kind === "auth",
        5000,
      );
      expect(auth2.token).toBe("access-new");
    } finally {
      await relay.close();
      await admin.close();
    }
  });

  it("续期 401：断开 + 告警 + 不再重连（粘滞终局）", async () => {
    const relay = await startFakeRelay();
    const admin = await startFakeAdmin((index) =>
      index === 0 ? accessEnvelope("a1", REMAIN_SHORT_MS) : unauthorized(),
    );
    try {
      await startRelayClient(relay.url, "", {
        ak: akCreds(admin.url),
        renewCheckIntervalMs: 60,
      });
      const conn = relay.conns[0];
      expect((await conn.waitForFrame((f) => f.kind === "auth")).token).toBe(
        "a1",
      );

      // 续期 401 → 连接被断开 + face 日志告警（单点在换发模块）
      await waitClosed(conn.ws);
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining("AK 凭证失效（disabled/expired）"),
      );
      expect(isRelayConnected()).toBe(false);

      // 等过重连退避首窗（基数 1s）：无新连接——粘滞不重连
      await new Promise((resolve) => setTimeout(resolve, 1300));
      expect(relay.conns.length).toBe(1);
    } finally {
      await relay.close();
      await admin.close();
    }
  });

  it("启动换发 401：干净失败不连 relay（告警日志）", async () => {
    const relay = await startFakeRelay();
    const admin = await startFakeAdmin(() => unauthorized());
    try {
      await expect(
        startRelayClient(relay.url, "", { ak: akCreds(admin.url) }),
      ).rejects.toThrow(/AK 凭证失效/);
      expect(relay.conns.length).toBe(0); // 未进连接/重连循环
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining("AK 凭证失效（disabled/expired）"),
      );
    } finally {
      await relay.close();
      await admin.close();
    }
  });

  it("瞬态失败退避重试直至成功（注入小基数；网络/非 401 异常态）", async () => {
    const relay = await startFakeRelay();
    const admin = await startFakeAdmin((index) =>
      index === 0
        ? { status: 502, body: "bad gateway" }
        : accessEnvelope("access-late", REMAIN_FULL_MS),
    );
    try {
      await startRelayClient(relay.url, "", {
        ak: akCreds(admin.url),
        akRetryBaseMs: 60,
      });
      expect(admin.requests.length).toBeGreaterThanOrEqual(2);
      const auth = await relay.conns[0].waitForFrame((f) => f.kind === "auth");
      expect(auth.token).toBe("access-late");
    } finally {
      await relay.close();
      await admin.close();
    }
  });

  it("stopRelayClient 清理续期计时器（停用后不再换发——无泄漏）", async () => {
    const relay = await startFakeRelay();
    const admin = await startFakeAdmin((index) =>
      accessEnvelope(`a${index + 1}`, REMAIN_SHORT_MS),
    );
    try {
      await startRelayClient(relay.url, "", {
        ak: akCreds(admin.url),
        renewCheckIntervalMs: 60,
      });
      await relay.conns[0].waitForFrame((f) => f.kind === "register");

      stopRelayClient();
      const countAtStop = admin.requests.length;
      // 等多个巡检周期：无后续换发请求（计时器已清）
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(admin.requests.length).toBe(countAtStop);
      expect(relay.conns.length).toBe(1); // 停用不重连
    } finally {
      await relay.close();
      await admin.close();
    }
  });
});

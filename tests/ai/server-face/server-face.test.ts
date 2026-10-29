// 被控面 send 桥 + SSE + relay 客户端 + IPC（server-face spec §6 / T12）：
// - send 桥：handleRoute session/send → chat.send(params, userId, undefined)
//   无头调用，chunk 流经 chat-tap → face 事件总线 → SSE 帧与 relay event 帧
//   （chat 替身以 emitChatChunk 驱动 tap——ChatService→tap 段由
//   chat-tap.test.ts 集成覆盖，此处测桥接段）
// - SSE：T7 同款编码/首帧 server.connected/退订收口
// - relay 客户端：本机 ws 库模拟 relay——register 元数据、req→res 配对
//   （envelope 契约见 relay-protocol.ts）、断线指数退避重连+重注册
// - HTTP 面：Bearer/?token 双口径鉴权；未配 token 拒启（不裸奔）
// - IPC：serverFace:status/setEnabled + option 持久化（token 自动生成）
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

// option 行内存库（serverFace 配置持久化/恢复）+ user/workspace 单用户读
const db = vi.hoisted(() => {
  let nextOptionId = 1;
  const optionRows = new Map<
    number,
    { id: number; type: string; name: string; value: string }
  >();
  return {
    optionRows,
    user: { findFirst: vi.fn(async () => ({ id: 7 })) },
    workspace: {
      findFirst: vi.fn(async () => ({ id: 3 })),
    },
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
  setServerFaceDeps,
  faceDeps,
} from "../../../electron/domains/server-face/deps";
import type { ServerFaceSessions } from "../../../electron/domains/server-face/deps";
import {
  encodeSseFrame,
  ensureServerFace,
  readServerFaceConfig,
  saveServerFaceConfig,
  stopServerFace,
  type ServerFaceConfig,
} from "../../../electron/domains/server-face/server-face";
import {
  startRelayClient,
  stopRelayClient,
} from "../../../electron/domains/server-face/relay-client";
import { handleRoute } from "../../../electron/domains/server-face/routes";
import { onFaceEvent } from "../../../electron/domains/server-face/face-events";
import { emitChatChunk } from "../../../electron/domains/server-face/chat-tap";
import { attachServerFace } from "../../../electron/domains/server-face/ipc";
import {
  FACE_INSTANCE_ID,
  FACE_CAPABILITIES,
} from "../../../electron/domains/server-face/face-info";
import type { SessionRecord } from "../../../src-react/domains/ai/api/session.api";
import type { ProviderRepository } from "../../../electron/domains/ai/provider/provider.repo";
import type { ModelRepository } from "../../../electron/domains/ai/provider/model.repo";

const UID = 7;
const TOKEN = "face-secret";

// —— 测试替身：内存 sessions + chat（send 以 emitChatChunk 驱动 tap）——
function makeDeps() {
  const sessions: ServerFaceSessions = {
    async getSession(id: number) {
      return id === 1
        ? {
            id: 1,
            userId: UID,
            title: "会话一",
            archivedAt: null,
            updatedAt: new Date("2026-10-17T00:00:00Z"),
          }
        : null;
    },
    async createSession() {
      return {} as SessionRecord;
    },
    async listAllSessions() {
      return [];
    },
    // P1 未读角标批：enriched 数据源替身（SSE session.updated 携带角标）
    async listAllSessionsSummarized() {
      return [];
    },
    // face 全表扫描优化批：query 数据源替身（本链路无相关断言）
    async querySessions() {
      return { page: 1, pageSize: 100, records: [], total: 0 };
    },
    async getSessionSummary(id: number, userId: number) {
      if (id === 1 && userId === UID) {
        return {
          id: 1,
          workspaceId: 3,
          title: "会话一",
          mode: "agent",
          createdAt: "2026-10-17T00:00:00.000Z",
          updatedAt: "2026-10-17T00:00:00.000Z",
          unreadCount: 1,
          lastMessage: {
            id: 9,
            role: "assistant",
            kind: "text",
            text: "遥控一条",
            createdAt: "2026-10-17T00:00:01.000Z",
          },
        } as never;
      }
      return null;
    },
    async markSessionRead() {
      return { sessionId: 1, lastReadMessageId: 9, unreadCount: 0 };
    },
    async getSessionById() {
      throw new Error("SESSION_NOT_FOUND");
    },
    async deleteSession() {},
    async listMessages() {
      return { items: [], hasMore: false, nextBeforeId: null };
    },
  };
  const chat = {
    send: vi.fn(async (params: { sessionId: number }) => {
      emitChatChunk(params.sessionId, { type: "text-delta", text: "遥" });
      emitChatChunk(params.sessionId, { type: "finish" });
    }),
    stop: vi.fn(),
  };
  setServerFaceDeps({
    sessions,
    chat,
    resolveUserId: async () => UID,
    resolveDefaultWorkspaceId: async () => 3,
    approvals: {
      // 审批记住批替身：tc-hit 命中，remembered = 请求记忆且上送工具名
      // 且为批准（拒绝不写记忆）
      respondRemember: async (
        _sessionId: number,
        toolCallId: string,
        approved: boolean,
        _userId: number,
        remember: boolean,
        toolName: string | null,
      ) =>
        toolCallId === "tc-hit"
          ? {
              hit: true,
              remembered:
                remember && approved && toolName != null && toolName !== "",
            }
          : { hit: false, remembered: false },
    },
    providers: {
      listBundle: async () => ({ providers: [], models: [] }),
    },
    images: {
      readImage: async () => null,
    },
    info: async () => ({
      name: "tianshu-desktop",
      version: "0.0.0-test",
      instanceId: FACE_INSTANCE_ID,
      capabilities: [...FACE_CAPABILITIES],
      username: "测试用户",
    }),
  });
  return { sessions, chat };
}

/** 帧等待器（tianshu-server relay.spec 同款手法） */
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

/** 本机 ws 模拟 relay（最小行为：升级记录 query、帧原样回环给测试断言） */
async function startFakeRelay() {
  const conns: TrackedConn[] = [];
  const handshakes: string[] = [];
  const wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (ws, req) => {
    handshakes.push(req.url ?? "");
    conns.push(trackConn(ws));
  });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const address = wss.address() as { port: number };
  return {
    url: `ws://127.0.0.1:${address.port}/ws`,
    conns,
    handshakes,
    async close() {
      for (const conn of conns) conn.ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

/** 逐帧读取 SSE 流（跳过 `: ping` 注释行） */
function makeSseReader(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const nextEvent = async (
    timeoutMs = 4000,
  ): Promise<{ event: string; data: string }> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = buffer.indexOf("\n\n");
      if (index >= 0) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (raw.startsWith(":")) continue; // 心跳注释行
        return {
          event: /^event: (.+)$/m.exec(raw)?.[1] ?? "",
          data: /^data: (.+)$/m.exec(raw)?.[1] ?? "",
        };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`SSE 帧等待超时，缓冲: ${JSON.stringify(buffer)}`);
      }
      const read = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), remaining),
        ),
      ]);
      if (read === "timeout") continue;
      if (read.done) throw new Error("SSE 流提前关闭");
      buffer += decoder.decode(read.value, { stream: true });
    }
  };
  return { nextEvent, cancel: () => void reader.cancel() };
}

/** 等待谓词成立（重连/异步收口轮询） */
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

beforeEach(() => {
  db.optionRows.clear();
  makeDeps();
});

afterEach(async () => {
  await stopServerFace();
  stopRelayClient();
});

describe("SSE 编码（T7 同款）", () => {
  it("event/data 双行 + 空行结尾，payload JSON 化", () => {
    const frame = encodeSseFrame({
      type: "message.chunk",
      payload: { sessionId: 1, chunk: { type: "text-delta", text: "你好" } },
    });
    expect(frame).toBe(
      'event: message.chunk\ndata: {"sessionId":1,"chunk":{"type":"text-delta","text":"你好"}}\n\n',
    );
  });

  it("server.connected 首帧形状（instanceId + capabilities）", () => {
    const frame = encodeSseFrame({
      type: "server.connected",
      payload: { instanceId: "iid", capabilities: ["chat", "provider"] },
    });
    expect(frame.startsWith("event: server.connected\ndata: ")).toBe(true);
    expect(frame.endsWith("\n\n")).toBe(true);
  });
});

describe("HTTP 面（ensureServerFace）", () => {
  it("未配 token 拒绝启动（不裸奔），配置 token 后可启动", async () => {
    await seedOption({ enabled: true, token: "", port: 0 });
    await expect(ensureServerFace()).rejects.toThrow(/token/);

    await seedOption({ enabled: true, token: TOKEN, port: 0 });
    const port = await ensureServerFace();
    expect(port).toBeGreaterThan(0);
  });

  it("未启用为空操作（默认关）", async () => {
    await seedOption({ enabled: false, token: TOKEN, port: 0 });
    await expect(ensureServerFace()).resolves.toBe(0);
  });

  it("鉴权：无/错 token 401；Bearer 与 ?token= 双口径等效", async () => {
    await seedOption({ enabled: true, token: TOKEN, port: 0 });
    const port = await ensureServerFace();

    const noToken = await fetch(`http://127.0.0.1:${port}/info`);
    expect(noToken.status).toBe(401);
    const wrong = await fetch(`http://127.0.0.1:${port}/info?token=WRONG`);
    expect(wrong.status).toBe(401);

    const byBearer = await fetch(`http://127.0.0.1:${port}/info`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(byBearer.status).toBe(200);
    await expect(byBearer.json()).resolves.toMatchObject({
      code: "2000",
      success: true,
      data: { capabilities: [...FACE_CAPABILITIES] },
    });

    const byQuery = await fetch(`http://127.0.0.1:${port}/info?token=${TOKEN}`);
    expect(byQuery.status).toBe(200);
  });

  it("POST 经路由表：session/query 直连闭环", async () => {
    await seedOption({ enabled: true, token: TOKEN, port: 0 });
    const port = await ensureServerFace();
    const res = await fetch(`http://127.0.0.1:${port}/session/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ page: 1 }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      code: "2000",
      success: true,
      data: { page: 1, pageSize: 100, records: [], total: 0 },
    });
  });
});

describe("send 桥 → SSE 事件流", () => {
  it("首帧 server.connected；send 后 message.chunk 逐帧可见 + 收尾 session.updated", async () => {
    await seedOption({ enabled: true, token: TOKEN, port: 0 });
    const port = await ensureServerFace();
    const response = await fetch(
      `http://127.0.0.1:${port}/event?token=${TOKEN}`,
    );
    expect(response.status).toBe(200);
    const reader = makeSseReader(response.body!);

    const connected = await reader.nextEvent();
    expect(connected.event).toBe("server.connected");
    // 能力清单以包常量为准（UD-T1 增 ui-drive——chat/provider/ui-drive）
    expect(JSON.parse(connected.data)).toEqual({
      instanceId: FACE_INSTANCE_ID,
      capabilities: [...FACE_CAPABILITIES],
    });

    // send：202 受理（HTTP 面同端口 POST）
    const send = await fetch(`http://127.0.0.1:${port}/session/send`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ sessionId: 1, content: "遥控一条" }),
    });
    expect(send.status).toBe(202);

    // chunk 流（chat 替身经 tap 驱动）：text-delta → finish → session.updated
    const chunk1 = await reader.nextEvent();
    expect(JSON.parse(chunk1.data)).toEqual({
      sessionId: 1,
      chunk: { type: "text-delta", text: "遥" },
    });
    const chunk2 = await reader.nextEvent();
    expect(JSON.parse(chunk2.data)).toEqual({
      sessionId: 1,
      chunk: { type: "finish" },
    });
    const updated = await reader.nextEvent();
    expect(updated.event).toBe("session.updated");
    expect(JSON.parse(updated.data)).toEqual({
      id: 1,
      title: "会话一",
      updatedAt: "2026-10-17T00:00:00.000Z",
      // P1 未读角标批：收尾事件携未读数 + 末条摘要
      unreadCount: 1,
      lastMessage: {
        id: 9,
        role: "assistant",
        kind: "text",
        text: "遥控一条",
        createdAt: "2026-10-17T00:00:01.000Z",
      },
    });
    reader.cancel();
  });

  it("chat.send 失败 → session.error 事件（错误码+文案映射）", async () => {
    const wired = makeDeps();
    wired.chat.send.mockRejectedValue(new Error("CONCURRENT_REQUEST"));
    const events: Array<{ type: string; payload: unknown }> = [];
    const off = onFaceEvent((event) => events.push(event));

    const result = await handleRoute("POST", "session/send", {
      sessionId: 1,
      content: "hi",
    });
    expect(result.status).toBe(202);
    await waitFor(() => events.some((e) => e.type === "session.error"));
    off();

    expect(events.find((e) => e.type === "session.error")).toMatchObject({
      type: "session.error",
      payload: {
        sessionId: 1,
        code: "CONCURRENT_REQUEST",
        message: "会话已有进行中的请求",
      },
    });
  });

  it("send 预检：会话不存在 4040 业务错（不受理）", async () => {
    const result = await handleRoute("POST", "session/send", {
      sessionId: 999,
      content: "hi",
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ code: "4040", success: false });
  });
});

describe("relay 客户端（本机 ws 模拟 relay）", () => {
  it("注册 + req→res 配对 + tap 事件帧（envelope 与 HTTP 同构）", async () => {
    const relay = await startFakeRelay();
    try {
      await startRelayClient(relay.url, TOKEN);
      expect(relay.conns.length).toBe(1);
      expect(relay.handshakes[0]).toContain("role=server");
      expect(relay.handshakes[0]).toContain(`connectionId=${FACE_INSTANCE_ID}`);

      const conn = relay.conns[0];
      const register = await conn.waitForFrame((f) => f.kind === "register");
      expect(register).toMatchObject({
        instanceId: FACE_INSTANCE_ID,
        capabilities: [...FACE_CAPABILITIES],
      });

      // req 帧 → handleRoute → res 帧（body 含 starter 包装——envelope 契约）
      conn.ws.send(
        JSON.stringify({
          kind: "req",
          id: 7,
          method: "POST",
          path: "session/query",
          body: { page: 1 },
        }),
      );
      const res = await conn.waitForFrame(
        (f) => f.kind === "res" && f.id === 7,
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        code: "2000",
        success: true,
        data: { records: [], total: 0 },
      });

      // tap → event 帧（仅已连接时；payload = message.chunk 原样）
      emitChatChunk(1, { type: "text-delta", text: "控" });
      const event = await conn.waitForFrame((f) => f.kind === "event");
      expect(event).toEqual({
        kind: "event",
        type: "message.chunk",
        payload: { sessionId: 1, chunk: { type: "text-delta", text: "控" } },
      });
    } finally {
      await relay.close();
    }
  });

  it("活性应答：收到 ping 帧回 pong（应用层心跳，undici ws 无协议层 ping）", async () => {
    const relay = await startFakeRelay();
    try {
      await startRelayClient(relay.url, TOKEN);
      const conn = relay.conns[0];
      await conn.waitForFrame((f) => f.kind === "register");
      conn.ws.send(JSON.stringify({ kind: "ping" }));
      const pong = await conn.waitForFrame((f) => f.kind === "pong", 5000);
      expect(pong).toEqual({ kind: "pong" });
    } finally {
      await relay.close();
    }
  });

  it("断线重连：指数退避后重新 register（同 instanceId 顶掉旧连接）", async () => {
    const relay = await startFakeRelay();
    try {
      await startRelayClient(relay.url, TOKEN);
      await relay.conns[0].waitForFrame((f) => f.kind === "register");

      // 服务侧拆连接 → 客户端 1s 起退避重连 → 新连接重新 register
      relay.conns[0].ws.terminate();
      await waitFor(() => relay.conns.length >= 2, 5000);
      const second = await relay.conns[1].waitForFrame(
        (f) => f.kind === "register",
        5000,
      );
      expect(second.instanceId).toBe(FACE_INSTANCE_ID);
      expect(relay.handshakes[1]).toContain(`connectionId=${FACE_INSTANCE_ID}`);
    } finally {
      await relay.close();
    }
  });

  it("stopRelayClient 关连接且不再重连", async () => {
    const relay = await startFakeRelay();
    try {
      await startRelayClient(relay.url, TOKEN);
      const conn = relay.conns[0];
      await conn.waitForFrame((f) => f.kind === "register");
      const closed = new Promise<void>((resolve) =>
        conn.ws.on("close", () => resolve()),
      );
      stopRelayClient();
      await closed;
      // 等过退避首窗（1s）：无新连接
      await new Promise((resolve) => setTimeout(resolve, 1300));
      expect(relay.conns.length).toBe(1);
    } finally {
      await relay.close();
    }
  });

  it("未配 token 拒绝启动 relay 客户端", async () => {
    await expect(startRelayClient("ws://127.0.0.1:1/ws", "")).rejects.toThrow(
      /token/,
    );
  });
});

describe("IPC：serverFace:status / setEnabled + option 持久化", () => {
  it("attachServerFace 登记 handler；setEnabled(true) 落库+自动生成 token+起服务面", async () => {
    const wired = makeDeps();
    attachServerFace({
      sessions: wired.sessions,
      chatService: wired.chat,
    });
    expect(ipcHandlers.has("serverFace:status")).toBe(true);
    expect(ipcHandlers.has("serverFace:setEnabled")).toBe(true);

    const status = await (
      ipcHandlers.get("serverFace:status") as () => unknown
    )();
    expect(status).toMatchObject({ enabled: false, running: false });

    await seedOption({ enabled: false, token: "", port: 0 });
    const enabledStatus = (await (
      ipcHandlers.get("serverFace:setEnabled") as (
        ...args: unknown[]
      ) => unknown
    )(undefined, true)) as {
      enabled: boolean;
      running: boolean;
      port: number;
      token: string;
    };

    // option 行已持久化（enabled + 自动生成的 token）
    const persisted = await readServerFaceConfig();
    expect(persisted.enabled).toBe(true);
    expect(persisted.token).toMatch(/^[0-9a-f]{48}$/);
    expect(enabledStatus).toMatchObject({
      enabled: true,
      running: true,
      token: persisted.token,
    });
    expect(enabledStatus.port).toBeGreaterThan(0);

    // 停用：服务面与持久化双双回落
    const offStatus = (await (
      ipcHandlers.get("serverFace:setEnabled") as (
        ...args: unknown[]
      ) => unknown
    )(undefined, false)) as { enabled: boolean; running: boolean };
    expect(offStatus).toMatchObject({ enabled: false, running: false });
    expect((await readServerFaceConfig()).enabled).toBe(false);
  });

  it("attachServerFace 组装穿透类实例原型方法（spread 丢原型回归钉）", async () => {
    // 真身 SessionRepository 是类——方法在 prototype 上，组装 spread 拷贝
    // 会丢；querySessions/listAllSessionsSummarized/getSessionSummary/
    // markSessionRead 曾漏点名包装，移动端 session/query 5000 "not a
    // function" 真机暴露（桌面本地 IPC 直持 repo 实例不受影响，故单测全绿）
    class ProtoSessions {
      hitCount = 0;
      async querySessions() {
        this.hitCount += 1;
        return { page: 1, pageSize: 1, records: [], total: 0 };
      }
      async listAllSessionsSummarized() {
        this.hitCount += 1;
        return [];
      }
      async getSessionSummary() {
        this.hitCount += 1;
        return null;
      }
      async markSessionRead() {
        this.hitCount += 1;
        return 1;
      }
    }
    const proto = new ProtoSessions();
    const wired = makeDeps();
    attachServerFace({
      sessions: proto as unknown as typeof wired.sessions,
      chatService: wired.chat,
    });
    const assembled = faceDeps().sessions;
    for (const method of [
      "querySessions",
      "listAllSessionsSummarized",
      "getSessionSummary",
      "markSessionRead",
    ] as const) {
      expect(typeof assembled[method]).toBe("function");
      await assembled[method](1 as never, 1 as never, 1 as never);
    }
    expect(proto.hitCount).toBe(4);
  });

  it("对象载荷（spec §13 项 1/T20 minor）：非法 port 拒绝回落只读快照；合法对象合并落库", async () => {
    const wired = makeDeps();
    attachServerFace({
      sessions: wired.sessions,
      chatService: wired.chat,
    });
    await seedOption({ enabled: false, token: TOKEN, port: 29_000 });
    const setEnabled = ipcHandlers.get("serverFace:setEnabled") as (
      ...args: unknown[]
    ) => Promise<unknown>;

    // 非法 port（越界/非整数/负数）→ 回落只读 status 快照，配置不动
    for (const badPort of [99_999, 1.5, -1]) {
      const rejected = (await setEnabled(undefined, {
        enabled: true,
        port: badPort,
      })) as { enabled: boolean; running: boolean; port: number };
      expect(rejected).toMatchObject({
        enabled: false,
        running: false,
        port: 29_000,
      });
    }
    expect(await readServerFaceConfig()).toMatchObject({
      enabled: false,
      port: 29_000,
    });

    // 合法对象：enabled+host+port(0=随机) 合并落库并起服务面
    const applied = (await setEnabled(undefined, {
      enabled: true,
      port: 0,
      host: "0.0.0.0",
      regenerateToken: true,
    })) as {
      enabled: boolean;
      running: boolean;
      port: number;
      token: string;
      host: string;
    };
    const persisted = await readServerFaceConfig();
    expect(persisted).toMatchObject({ enabled: true, host: "0.0.0.0" });
    expect(persisted.token).toMatch(/^[0-9a-f]{48}$/); // regenerateToken 生效
    expect(applied).toMatchObject({
      enabled: true,
      running: true,
      host: "0.0.0.0",
      token: persisted.token,
    });
    expect(applied.port).toBeGreaterThan(0); // port 0 → 实听随机口
  });

  it("配置读写往返（缺省 0.0.0.0、显式回环 127.0.0.1 保留）", async () => {
    const defaults = await readServerFaceConfig();
    expect(defaults).toMatchObject({
      enabled: false,
      host: "0.0.0.0",
      token: "",
    });

    await saveServerFaceConfig({
      enabled: true,
      port: 28_888,
      token: "t",
      host: "127.0.0.1",
      relayUrl: "ws://relay/ws",
      relayToken: "rt",
    });
    await expect(readServerFaceConfig()).resolves.toMatchObject({
      enabled: true,
      port: 28_888,
      host: "127.0.0.1",
      relayUrl: "ws://relay/ws",
      relayToken: "rt",
    });
  });
});

describe("IPC：登录用户上报（问题 2 方案 A）——resolveUserId/info 跟随", () => {
  it("reportActiveUser(number) 后 resolveUserId 直取上报值（不查 user 表），info 按上报 id 查身份", async () => {
    const wired = makeDeps();
    attachServerFace({ sessions: wired.sessions, chatService: wired.chat });
    const report = ipcHandlers.get("serverFace:reportActiveUser") as (
      ...args: unknown[]
    ) => unknown;
    report(undefined, 7);
    db.user.findFirst.mockClear();

    await expect(faceDeps().resolveUserId()).resolves.toBe(7);
    expect(db.user.findFirst).not.toHaveBeenCalled(); // 上报值优先，零 DB 查询

    db.user.findFirst.mockResolvedValueOnce({
      id: 7,
      username: "u7",
      nickname: "昵称七",
    });
    const info = await faceDeps().info();
    expect(db.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 7 } }),
    );
    expect(info).toMatchObject({ username: "昵称七" });
  });

  it("上报 null（登出）或非法载荷 → 清空回落 user 表最新（旧语义）；info 回落 nickname 缺省 username", async () => {
    const wired = makeDeps();
    attachServerFace({ sessions: wired.sessions, chatService: wired.chat });
    const report = ipcHandlers.get("serverFace:reportActiveUser") as (
      ...args: unknown[]
    ) => unknown;
    report(undefined, null); // 起点复位（模块级状态跨用例存续）

    db.user.findFirst.mockResolvedValueOnce({ id: 9 });
    await expect(faceDeps().resolveUserId()).resolves.toBe(9);
    expect(db.user.findFirst).toHaveBeenCalledWith({ orderBy: { id: "desc" } });

    report(undefined, 5); // 先报 5 再以非法载荷登出
    report(undefined, "evil");
    db.user.findFirst.mockResolvedValueOnce({ id: 9 });
    await expect(faceDeps().resolveUserId()).resolves.toBe(9);

    db.user.findFirst.mockResolvedValueOnce({
      id: 9,
      username: "latest",
      nickname: null,
    });
    const info = await faceDeps().info();
    expect(db.user.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({ orderBy: { id: "desc" } }),
    );
    expect(info).toMatchObject({ username: "latest" }); // nickname 缺省回落
  });
});

describe("approve / provider / image 三新端点", () => {
  it("session/approve 转发应答，未命中 pending 返回 4040", async () => {
    const res = await handleRoute("POST", "session/approve", {
      sessionId: 1,
      toolCallId: "tc-x",
      approved: true,
    });
    expect(res.body).toMatchObject({ code: "4040", success: false });
    // 替身 respond 返回 false → 4040；命中时返回 2000（见下一断言组）
  });

  it("session/approve 命中 pending 返回 2000（responded）", async () => {
    const res = await handleRoute("POST", "session/approve", {
      sessionId: 1,
      toolCallId: "tc-hit",
      approved: false,
    });
    expect(res.body).toMatchObject({
      code: "2000",
      success: true,
      data: { responded: true },
    });
  });

  it("session/approve 参数不合法返回 5000", async () => {
    const res = await handleRoute("POST", "session/approve", { approved: 1 });
    expect(res.body).toMatchObject({ code: "5000", success: false });
  });

  it("session/approve remember+toolName 透传，返回 remembered", async () => {
    const res = await handleRoute("POST", "session/approve", {
      sessionId: 1,
      toolCallId: "tc-hit",
      approved: true,
      remember: true,
      toolName: "write",
    });
    expect(res.body).toMatchObject({
      code: "2000",
      success: true,
      data: { responded: true, remembered: true },
    });
  });

  it("session/approve 拒绝时 remember 不写记忆（remembered=false）", async () => {
    const res = await handleRoute("POST", "session/approve", {
      sessionId: 1,
      toolCallId: "tc-hit",
      approved: false,
      remember: true,
      toolName: "write",
    });
    expect(res.body).toMatchObject({
      code: "2000",
      data: { responded: true, remembered: false },
    });
  });

  it("session/approve remember/toolName 类型不合法返回 5000", async () => {
    const res = await handleRoute("POST", "session/approve", {
      sessionId: 1,
      toolCallId: "tc-hit",
      approved: true,
      remember: "yes",
    });
    expect(res.body).toMatchObject({ code: "5000", success: false });
    const res2 = await handleRoute("POST", "session/approve", {
      sessionId: 1,
      toolCallId: "tc-hit",
      approved: true,
      remember: true,
      toolName: 42,
    });
    expect(res2.body).toMatchObject({ code: "5000", success: false });
  });

  it("provider/query 返回 providers+models 全量", async () => {
    const res = await handleRoute("POST", "provider/query", null);
    expect(res.body).toMatchObject({
      success: true,
      data: { providers: expect.any(Array), models: expect.any(Array) },
    });
  });

  it("provider/query 密钥脱敏：apiKey/extraHeaders 有值掩码、空值原样（M5）", async () => {
    const wired = makeDeps();
    // 经 attachServerFace 装配真实 listBundle 闭包（脱敏收口处），
    // providerRepo 替身返回带明文密钥的行
    attachServerFace({
      sessions: wired.sessions,
      chatService: wired.chat,
      providerRepo: {
        list: async () => [
          {
            id: 1,
            name: "has-key",
            type: "openai-compatible",
            baseUrl: "http://x",
            apiKey: "sk-real",
            extraHeaders: '{"X-Key":"hv-real","X-Empty":""}',
            enabled: true,
            createdAt: "2026-10-17T00:00:00.000Z",
            updatedAt: "2026-10-17T00:00:00.000Z",
          },
          {
            id: 2,
            name: "no-key",
            type: "ollama",
            baseUrl: "http://y",
            apiKey: null,
            extraHeaders: null,
            enabled: false,
            createdAt: "2026-10-17T00:00:00.000Z",
            updatedAt: "2026-10-17T00:00:00.000Z",
          },
        ],
      } as unknown as ProviderRepository,
      modelRepo: { listAll: async () => [] } as unknown as ModelRepository,
    });
    try {
      const res = await handleRoute("POST", "provider/query", null);
      const data = (res.body as { data: { providers: unknown[] } }).data;
      expect(data.providers).toEqual([
        // 有值 → REDACTED 掩码；extraHeaders 键名保留、逐值掩码（空值不掩）
        expect.objectContaining({
          name: "has-key",
          apiKey: "__REDACTED__",
          extraHeaders: '{"X-Key":"__REDACTED__","X-Empty":""}',
        }),
        // 空值原样（空与已配置可区分）
        expect.objectContaining({
          name: "no-key",
          apiKey: null,
          extraHeaders: null,
        }),
      ]);
    } finally {
      // 复位替身 deps：attachServerFace 覆盖了 providers/images 桥（image
      // 用例依赖替身 readImage），防装配泄漏影响后续用例
      makeDeps();
    }
  });

  it("image 路径逃逸数据根返回 4040", async () => {
    const res = await handleRoute("POST", "image", {
      path: "../../etc/passwd",
    });
    expect(res.body).toMatchObject({ code: "4040", success: false });
  });

  it("image 白名单外扩展名返回 4040", async () => {
    const res = await handleRoute("POST", "image", { path: "logs/x.txt" });
    expect(res.body).toMatchObject({ code: "4040", success: false });
  });
});

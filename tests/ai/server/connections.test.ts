// T16 连接注册表 + 控制端 IPC 面：CRUD 持久化（option 表 prisma 替身——
// type="app" name="serverConnections" JSON）/配置校验/testConnection（真
// DirectTransport 打假被控端：capabilities 协商与 401→invalid-token）/
// session 透传（starter 包装体原样返回 + 401/4010 → 连接态 invalid-token
// 粘滞）/事件桥（message.chunk→server:chunk:<connId>:<sessionId>、
// session.*→server:event:<connId> 合并通道）/本地无头端（临时产物脚本
// spawn dist/src/main.js 实测路径 + upsert local 连接 + 启停状态）。
import http from "node:http";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  // app.isPackaged=false：本地无头端仅 dev 态（spawn 链路见 supervisor-local.test）
  app: { isPackaged: false },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
vi.mock("../../../electron/commons/Log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// prisma 替身：option 表三操作内存实现（findFirst/update/create）
const optionRows: Array<{
  id: number;
  type: string;
  name: string;
  value: string;
}> = [];
const prismaStub = vi.hoisted(() => ({
  option: {
    findFirst: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
  },
}));
vi.mock("../../../electron/commons/prisma-client", () => ({
  default: prismaStub,
}));

import { ipcMain, BrowserWindow } from "electron";
import {
  ConnectionRegistry,
  LOCAL_CONNECTION_ID,
  localServerStatus,
  startLocalServer,
  stopLocalServer,
  type ConnectionConfig,
  type PersistedShape,
  type ServerEvent,
} from "../../../electron/domains/server/connections";
import { registerServerIpc } from "../../../electron/domains/server/ipc";
import { HANDSHAKE_PREFIX } from "../../../electron/domains/server/supervisor";

/** option 表内存实现装配（每用例重置行与调用记录） */
function resetOptionTable(): void {
  optionRows.length = 0;
  prismaStub.option.findFirst.mockImplementation(
    async (args: {
      where: { type: string; name: string };
      select?: unknown;
    }) => {
      const row = optionRows.find(
        (r) => r.type === args.where.type && r.name === args.where.name,
      );
      if (!row) return null;
      return args.select ? { id: row.id } : row;
    },
  );
  prismaStub.option.update.mockImplementation(
    async (args: { where: { id: number }; data: { value: string } }) => {
      const row = optionRows.find((r) => r.id === args.where.id)!;
      row.value = args.data.value;
      return row;
    },
  );
  prismaStub.option.create.mockImplementation(
    async (args: { data: { type: string; name: string; value: string } }) => {
      const row = { id: optionRows.length + 1, ...args.data };
      optionRows.push(row);
      return row;
    },
  );
}

function readPersistedShape(): PersistedShape {
  expect(optionRows).toHaveLength(1);
  return JSON.parse(optionRows[0].value) as PersistedShape;
}

const DIRECT_CONFIG: ConnectionConfig = {
  id: "conn-1",
  name: "测试直连",
  mode: "direct",
  baseUrl: "http://127.0.0.1:1",
  token: "face-token",
};

/** 假被控端：Bearer 鉴权（token=null 关鉴权）+ /info + /event（SSE 首帧
 * server.connected）+ POST session/query（direct-transport.test 同构子集） */
class FakeFace {
  private readonly sseStreams = new Set<http.ServerResponse>();
  /** POST /session/approve 收到的请求体（T17 透传断言用） */
  public readonly approveRequests: unknown[] = [];
  private constructor(
    private readonly server: http.Server,
    public token: string | null,
  ) {}

  static async start(port: number, token: string | null): Promise<FakeFace> {
    const holder: { face: FakeFace | null } = { face: null };
    const server = http.createServer((req, res) => handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const face = new FakeFace(server, token);
    holder.face = face;
    return face;

    function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
      const face = holder.face!;
      if (
        face.token !== null &&
        req.headers.authorization !== `Bearer ${face.token}`
      ) {
        reply(res, 401, null, "4010", "未认证");
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/event")) {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
        });
        face.sseStreams.add(res);
        res.on("close", () => face.sseStreams.delete(res));
        res.write(
          sseFrame("server.connected", {
            instanceId: "fake-instance",
            capabilities: ["chat", "provider"],
          }),
        );
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
            version: "0.0.0",
            instanceId: "fake-instance",
            capabilities: ["chat", "provider"],
          });
          return;
        }
        if (req.method === "POST" && req.url?.startsWith("/session/query")) {
          const body = raw ? (JSON.parse(raw) as { page?: number }) : {};
          reply(res, 200, {
            page: body.page ?? 1,
            pageSize: 100,
            records: [],
            total: 0,
          });
          return;
        }
        if (req.method === "POST" && req.url?.startsWith("/session/approve")) {
          face.approveRequests.push(raw ? JSON.parse(raw) : {});
          reply(res, 200, { responded: true });
          return;
        }
        reply(res, 404, null, "4040", "接口不存在");
      });
    }
  }

  sendEvent(type: string, payload: unknown): void {
    for (const res of this.sseStreams) {
      if (!res.destroyed) res.write(sseFrame(type, payload));
    }
  }

  kill(): Promise<void> {
    this.server.closeAllConnections?.();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

function sseFrame(type: string, payload: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function reply(
  res: http.ServerResponse,
  status: number,
  data: unknown,
  code = "2000",
  message = "success",
): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ code, success: code === "2000", data, message }));
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

const registries: ConnectionRegistry[] = [];

function newRegistry(
  options: { testTimeoutMs?: number } = {},
): ConnectionRegistry {
  const registry = new ConnectionRegistry(options);
  registries.push(registry);
  return registry;
}

beforeEach(() => {
  resetOptionTable();
  vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
    { webContents: { send: vi.fn() } } as never,
  ]);
});

afterEach(() => {
  for (const registry of registries) registry.closeAll();
  registries.length = 0;
});

describe("连接注册表 CRUD（option 表持久化）", () => {
  it("save 持久化到 option 行；list 合并运行态；delete 移除并清活动", async () => {
    const registry = newRegistry();
    const afterSave = await registry.saveConnection(DIRECT_CONFIG);
    expect(afterSave.connections).toHaveLength(1);
    expect(afterSave.connections[0]).toMatchObject({
      id: "conn-1",
      mode: "direct",
      state: "idle",
    });
    expect(readPersistedShape().connections[0]).toEqual(DIRECT_CONFIG);

    await registry.activate("conn-1");
    expect(readPersistedShape().activeConnId).toBe("conn-1");

    const afterDelete = await registry.deleteConnection("conn-1");
    expect(afterDelete).toEqual({ activeConnId: null, connections: [] });
    expect(readPersistedShape().connections).toEqual([]);
  });

  it("配置校验：缺 id/名称、非法 mode、direct 缺 baseUrl、relay 缺三元组拒绝", async () => {
    const registry = newRegistry();
    await expect(
      registry.saveConnection({ ...DIRECT_CONFIG, id: "" }),
    ).rejects.toThrow(/id/);
    await expect(
      registry.saveConnection({ ...DIRECT_CONFIG, name: " " }),
    ).rejects.toThrow(/名称/);
    await expect(
      registry.saveConnection({ ...DIRECT_CONFIG, mode: "p2p" as never }),
    ).rejects.toThrow(/direct 或 relay/);
    await expect(
      registry.saveConnection({
        id: "c2",
        name: "n",
        mode: "direct",
        baseUrl: "notaurl",
      }),
    ).rejects.toThrow(/baseUrl/);
    await expect(
      registry.saveConnection({
        id: "c3",
        name: "n",
        mode: "relay",
        relayUrl: "ws://127.0.0.1:1/ws",
      }),
    ).rejects.toThrow(/relayToken/);
    await expect(
      registry.saveConnection({
        id: "c4",
        name: "n",
        mode: "relay",
        relayUrl: "ws://127.0.0.1:1/ws",
        relayToken: "t",
        connectionId: "i",
        e2eMode: "off" as never,
      }),
    ).rejects.toThrow(/auto 或 required/);
  });
});

describe("testConnection", () => {
  it("假被控端：capabilities 协商成功", async () => {
    const port = await reservePort();
    const face = await FakeFace.start(port, "face-token");
    try {
      const registry = newRegistry();
      const result = await registry.test({
        ...DIRECT_CONFIG,
        baseUrl: `http://127.0.0.1:${port}`,
      });
      expect(result).toEqual({
        ok: true,
        instanceId: "fake-instance",
        capabilities: ["chat", "provider"],
      });
    } finally {
      await face.kill();
    }
  }, 10_000);

  it("token 错误：401/4010 → reason=invalid-token（区别 lost/超时）", async () => {
    const port = await reservePort();
    const face = await FakeFace.start(port, "face-token");
    try {
      const registry = newRegistry();
      const result = await registry.test({
        ...DIRECT_CONFIG,
        baseUrl: `http://127.0.0.1:${port}`,
        token: "wrong-token",
      });
      expect(result).toMatchObject({ ok: false, reason: "invalid-token" });
    } finally {
      await face.kill();
    }
  }, 10_000);

  it("端口不通：reason=unreachable；relay 等不到建链：reason=timeout", async () => {
    const deadPort = await reservePort();
    const registry = newRegistry({ testTimeoutMs: 1_500 });
    const unreachable = await registry.test({
      ...DIRECT_CONFIG,
      baseUrl: `http://127.0.0.1:${deadPort}`,
    });
    expect(unreachable.ok).toBe(false);
    expect(["unreachable", "timeout"]).toContain(unreachable.reason);

    const timeout = await registry.test({
      id: "r",
      name: "r",
      mode: "relay",
      relayUrl: `ws://127.0.0.1:${deadPort}/ws`,
      relayToken: "rt",
      connectionId: "target",
    });
    expect(timeout).toMatchObject({ ok: false, reason: "timeout" });
  }, 10_000);
});

describe("session 透传与 invalid-token 连接态", () => {
  it("活动连接请求：包装体原样返回；事件 sink 分发；401/4010 → invalid-token 粘滞", async () => {
    const port = await reservePort();
    const face = await FakeFace.start(port, "face-token");
    const registry = newRegistry();
    const events: Array<{ connId: string; event: ServerEvent }> = [];
    registry.setEventSink((connId, event) => events.push({ connId, event }));
    try {
      await registry.saveConnection({
        ...DIRECT_CONFIG,
        baseUrl: `http://127.0.0.1:${port}`,
      });
      await registry.activate("conn-1");

      const query = await registry.request(null, "POST", "session/query", {
        page: 2,
      });
      expect(query.status).toBe(200);
      expect(query.body).toEqual({
        code: "2000",
        success: true,
        data: { page: 2, pageSize: 100, records: [], total: 0 },
        message: "success",
      });

      // SSE 建流后 server.connected 就地消化为连接态 + 下发 sink（§13 项 2
      // 重连全量刷新——渲染层订阅 server:event:<connId> 后 refetch）
      await vi.waitFor(async () => {
        const list = await registry.list();
        expect(list.connections[0].state).toBe("connected");
        expect(list.connections[0].capabilities).toEqual(["chat", "provider"]);
      });
      await vi.waitFor(() =>
        expect(events.map((e) => e.event.type)).toEqual(["server.connected"]),
      );
      face.sendEvent("message.chunk", {
        sessionId: 9,
        chunk: { type: "text", text: "hi" },
      });
      face.sendEvent("session.updated", {
        id: 9,
        title: null,
        updatedAt: "2026-10-17T00:00:00.000Z",
      });
      await vi.waitFor(() =>
        expect(events.map((e) => e.event.type)).toEqual([
          "server.connected",
          "message.chunk",
          "session.updated",
        ]),
      );
      expect(events[0].connId).toBe("conn-1");
      expect(events[0].event).toEqual({
        type: "server.connected",
        payload: {
          instanceId: "fake-instance",
          capabilities: ["chat", "provider"],
        },
      });

      // 撤 token：请求 401+4010 → 连接态 invalid-token（与 lost 区分）
      face.token = "rotated";
      const denied = await registry.request(null, "POST", "session/query", {});
      expect(denied.status).toBe(401);
      const list = await registry.list();
      expect(list.connections[0].state).toBe("invalid-token");
    } finally {
      await face.kill();
    }
  }, 12_000);

  it("无活动连接时请求拒绝；显式 connId 透传并切换活动连接", async () => {
    const port = await reservePort();
    const face = await FakeFace.start(port, "face-token");
    const registry = newRegistry();
    try {
      await expect(
        registry.request(null, "POST", "session/query", {}),
      ).rejects.toThrow(/活动连接/);
      await registry.saveConnection({
        ...DIRECT_CONFIG,
        baseUrl: `http://127.0.0.1:${port}`,
      });
      await registry.saveConnection({
        ...DIRECT_CONFIG,
        id: "conn-2",
        name: "第二连接",
        baseUrl: `http://127.0.0.1:${port}`,
      });
      // 显式 conn-2：透传 + 活动连接粘性切换
      const query = await registry.request(
        "conn-2",
        "POST",
        "session/query",
        {},
      );
      expect(query.body).toMatchObject({ code: "2000", success: true });
      expect(readPersistedShape().activeConnId).toBe("conn-2");
      // 缺省走新活动连接
      const again = await registry.request(null, "POST", "session/query", {});
      expect(again.body).toMatchObject({ code: "2000", success: true });
      // ghost connId（T15/T16 minor F1）：只报错不粘死 activeConnId——
      // 粘性持久化必须晚于存在性校验，否则首个 ghost 请求把缺省路径一并卡死
      await expect(
        registry.request("ghost", "POST", "session/query", {}),
      ).rejects.toThrow(/连接不存在/);
      expect(readPersistedShape().activeConnId).toBe("conn-2");
      const afterGhost = await registry.request(
        null,
        "POST",
        "session/query",
        {},
      );
      expect(afterGhost.body).toMatchObject({ code: "2000", success: true });
    } finally {
      await face.kill();
    }
  }, 12_000);
});

describe("IPC 装配（registerServerIpc）", () => {
  it("48 通道注册（P1 尾 +sessionRead；T17 +sessionApprove；GA-T8 +graph/automation 九端点；UD-T2 +ui 三端点；TB-T2 +bridgeDecision；模型面 +provider 查存/删/测/拉取五端点；会话 +sessionDelete/update/regenerate；专家 +assistantQuery；CU 批 +editAndResend/accessMode；AL 批 +usage/skills 三端点；PM 批 +skillsSetEnabled；FA-T3 +files 三端点；WH 消费端批 +webhook 配置三端点）；sessionList 走活动连接；事件桥推 server:chunk:*/server:event:*", async () => {
    const port = await reservePort();
    const face = await FakeFace.start(port, "face-token");
    const registry = newRegistry();
    registerServerIpc(registry);
    const send = vi.mocked(
      BrowserWindow.getAllWindows()[0].webContents.send,
    ) as ReturnType<typeof vi.fn>;
    try {
      const handlers = new Map(
        vi
          .mocked(ipcMain.handle)
          .mock.calls.map(([channel, handler]) => [channel as string, handler]),
      );
      expect([...handlers.keys()].sort()).toEqual([
        "server:assistantQuery",
        "server:automationDelete",
        "server:automationQuery",
        "server:automationRunNow",
        "server:automationSave",
        "server:bridgeDecision",
        "server:connectionDelete",
        "server:connectionList",
        "server:connectionSave",
        "server:filesList",
        "server:filesRead",
        "server:filesUploadImage",
        "server:graphDelete",
        "server:graphQuery",
        "server:graphRun",
        "server:graphRunAbort",
        "server:graphSave",
        "server:localStart",
        "server:localStatus",
        "server:localStop",
        "server:providerDelete",
        "server:providerFetchModels",
        "server:providerQuery",
        "server:providerSave",
        "server:providerTest",
        "server:sessionAbort",
        "server:sessionAccessMode",
        "server:sessionApprove",
        "server:sessionCreate",
        "server:sessionDelete",
        "server:sessionEditResend",
        "server:sessionGet",
        "server:sessionList",
        "server:sessionRead",
        "server:sessionRegenerate",
        "server:sessionSend",
        "server:sessionUpdate",
        "server:sessionUsage",
        "server:skillsQuery",
        "server:skillsRead",
        "server:skillsSetEnabled",
        "server:testConnection",
        "server:uiNotify",
        "server:uiOpenRoute",
        "server:uiOpenSession",
        "server:webhookDisable",
        "server:webhookEnable",
        "server:webhookStatus",
        "server:workspaceList",
      ]);

      await handlers.get("server:connectionSave")!({} as never, {
        ...DIRECT_CONFIG,
        baseUrl: `http://127.0.0.1:${port}`,
      });
      // 激活（建链）→ connectionList 运行态合并出 connected + capabilities
      await registry.activate("conn-1");
      await vi.waitFor(async () => {
        const list = (await handlers.get("server:connectionList")!(
          {} as never,
        )) as {
          activeConnId: string | null;
          connections: Array<{ state: string }>;
        };
        expect(list.activeConnId).toBe("conn-1");
        expect(list.connections[0].state).toBe("connected");
      });
      const query = (await handlers.get("server:sessionList")!(
        {} as never,
        { page: 3 },
        undefined,
      )) as { status: number; body: { data: { page: number } } };
      expect(query.body.data.page).toBe(3);

      // T17 审批应答透传：活动连接 POST session/approve（路径与参数原样）
      const approve = (await handlers.get("server:sessionApprove")!(
        {} as never,
        { sessionId: 9, toolCallId: "w-1", approved: true },
        undefined,
      )) as {
        status: number;
        body: { success: boolean; data: { responded: boolean } };
      };
      expect(approve.body.success).toBe(true);
      expect(approve.body.data.responded).toBe(true);
      expect(face.approveRequests).toEqual([
        { sessionId: 9, toolCallId: "w-1", approved: true },
      ]);

      // 事件桥：server.connected（建流首帧，§13 项 2）+ chunk → server:chunk:
      // <connId>:<sessionId>；session.* → server:event:<connId>
      await vi.waitFor(() =>
        expect(send.mock.calls.length).toBeGreaterThanOrEqual(1),
      );
      expect(send.mock.calls[0][0]).toBe("server:event:conn-1");
      expect(send.mock.calls[0][1]).toMatchObject({ type: "server.connected" });
      face.sendEvent("message.chunk", {
        sessionId: 9,
        chunk: { type: "text", text: "x" },
      });
      face.sendEvent("session.error", {
        sessionId: 9,
        code: "NO_MODEL",
        message: "未选择模型",
      });
      await vi.waitFor(() => expect(send.mock.calls.length).toBe(3));
      expect(send.mock.calls[1]).toEqual([
        "server:chunk:conn-1:9",
        { type: "text", text: "x" },
      ]);
      expect(send.mock.calls[2][0]).toBe("server:event:conn-1");
      expect(send.mock.calls[2][1]).toMatchObject({ type: "session.error" });
      // GA-T8 编排事件（graph.run.updated / automation.changed）同走合并通道
      face.sendEvent("graph.run.updated", {
        runId: 7,
        graphId: 3,
        state: "running",
      });
      face.sendEvent("automation.changed", { taskId: 5, enabled: false });
      await vi.waitFor(() => expect(send.mock.calls.length).toBe(5));
      expect(send.mock.calls[3]).toEqual([
        "server:event:conn-1",
        {
          type: "graph.run.updated",
          payload: { runId: 7, graphId: 3, state: "running" },
        },
      ]);
      expect(send.mock.calls[4][0]).toBe("server:event:conn-1");
      expect(send.mock.calls[4][1]).toMatchObject({
        type: "automation.changed",
        payload: { taskId: 5 },
      });
    } finally {
      await face.kill();
    }
  }, 12_000);
});

describe("本地无头端（Supervisor 装配）", () => {
  it("startLocalServer：spawn <dir>/dist/src/main.js → 握手 → upsert+激活 local 连接；localStop 停止", async () => {
    // 临时产物目录：dist/src/main.js 打握手行保活（SIGTERM 处理器先注册）
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-local-"));
    fs.mkdirSync(path.join(projectDir, "dist", "src"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "dist", "src", "main.js"),
      [
        "process.on('SIGTERM', () => process.exit(0));",
        `console.log('${HANDSHAKE_PREFIX}${JSON.stringify({
          port: 3999,
          token: "spawned",
          instanceId: "local-inst",
        })}');`,
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
    );
    const registry = newRegistry();
    try {
      const info = await startLocalServer(registry, projectDir);
      expect(info).toEqual({
        port: 3999,
        token: "spawned",
        instanceId: "local-inst",
      });
      expect(info.token).not.toBe(""); // supervisor 注入的 TIANSHU_TOKEN 回显

      const list = await registry.list();
      expect(list.activeConnId).toBe(LOCAL_CONNECTION_ID);
      expect(list.connections[0]).toMatchObject({
        id: LOCAL_CONNECTION_ID,
        mode: "direct",
        baseUrl: "http://127.0.0.1:3999",
        local: true,
      });
      expect(localServerStatus()).toMatchObject({
        running: true,
        state: "running",
        port: 3999,
        instanceId: "local-inst",
      });

      await stopLocalServer(registry);
      expect(localServerStatus()).toMatchObject({
        running: false,
        state: "stopped",
      });
      // local 连接行保留（状态 closed），可重启复用
      const afterStop = await registry.list();
      expect(afterStop.connections[0].id).toBe(LOCAL_CONNECTION_ID);
    } finally {
      await stopLocalServer(registry);
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("产物缺失时给出有用错误（提示 npm run build）", async () => {
    const registry = newRegistry();
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-empty-"));
    try {
      await expect(startLocalServer(registry, emptyDir)).rejects.toThrow(
        /dist\/src\/main\.js.*npm run build|npm run build.*dist\/src\/main\.js/s,
      );
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

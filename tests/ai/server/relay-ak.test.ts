// 控制端 relay 连接 AK 凭证（relay 多租户 Task 17 / spec §5.4 消费侧）：
// - 主机页连接配置增 akId/akSecret/adminUrl 三字段：validateConfig 接受
//   AK 三要素齐备的 relay 配置（static relayToken 优先——在场零 AK 请求）
// - 建连前 ensureFreshAccess（短连接语义，同 T16 移动端——无常驻续期
//   循环）：存量新鲜直用零 admin 请求；缺失/剩<50%/换绑 → POST token
//   端点换新；换新瞬态失败且存量未过期降级照常连；换发 access 消费于
//   relay 首帧 auth（token=access，非 AK 凭证本身）
// - 401 / 无存量+换新失败 → 连接态 invalid-token 粘滞（复用既有凭证
//   失效呈现面；请求路径不自动重试，save 重建自愈）
// - 顶替守卫（T15 fix-round 教训）：换发 await 窗口内 save 顶掉旧配置
//   → 迟到结果不落地（不装 stale transport、不踩新配置）
// - admin 桩：node:http 最小行为（记录 Basic 出示 + 可编程响应序列）；
//   relay 桩：ws WebSocketServer（T15 测试同款）
import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

vi.mock("electron", () => ({
  app: { isPackaged: false },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  // option-secrets 密封链（注入 persistence 时不执行，import 面兜底）
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error("safeStorage unavailable in test");
    },
    decryptString: () => {
      throw new Error("safeStorage unavailable in test");
    },
  },
}));
vi.mock("../../../electron/commons/Log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../../electron/commons/prisma-client", () => ({
  default: {
    option: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
  },
}));

import {
  ConnectionRegistry,
  type ConnectionConfig,
  type PersistedShape,
} from "../../../electron/domains/server/connections";
import {
  clearRelayAccess,
  resolveRelayAccessToken,
  type RelayAkCredentials,
} from "../../../electron/domains/server/relay-ak";

// —— relay 桩（ws WebSocketServer——接受任意 auth，记录首帧）——

interface TrackedConn {
  frames: Array<Record<string, unknown>>;
  waitForFrame(
    predicate: (frame: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
}

async function startFakeRelay() {
  const conns: TrackedConn[] = [];
  const sockets: import("ws").WebSocket[] = [];
  const wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (ws) => {
    sockets.push(ws);
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
    conns.push({
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
    });
  });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const address = wss.address() as { port: number };
  return {
    url: `ws://127.0.0.1:${address.port}/ws`,
    conns,
    async close() {
      // 先硬断服务端 socket：客户端 transport 未关时 wss.close() 会挂住
      // （finally 里 afterEach 的 registry.closeAll 还没轮到）
      for (const socket of sockets) socket.terminate();
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
/** 短剩余（60s < 半衰 15d）：shouldRenew 真值但未过期（降级可用） */
const REMAIN_SHORT_MS = 60_000;
/** 满剩余（30d）：shouldRenew 假值（存量直用） */
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
    /** 硬杀（undici keep-alive 连接池下 close 会挂住——mid-test 断供用） */
    async kill() {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
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

/** AK 三要素 relay 连接配置（e2eMode auto——避开 required 握手终局拆链） */
function akRelayConfig(
  id: string,
  adminUrl: string,
  relayUrl: string,
  extra: Partial<ConnectionConfig> = {},
): ConnectionConfig {
  return {
    id,
    name: `AK 中继 ${id}`,
    mode: "relay",
    relayUrl,
    connectionId: "inst-ak",
    e2eMode: "auto",
    adminUrl,
    akId: "ak-test",
    akSecret: "sk-test",
    ...extra,
  };
}

/** 内存 persistence（registry CRUD 面收口；不触 option 表密封链） */
function memoryPersistence() {
  let shape: PersistedShape = { connections: [], activeConnId: null };
  return {
    async load(): Promise<PersistedShape> {
      return JSON.parse(JSON.stringify(shape)) as PersistedShape;
    },
    async save(next: PersistedShape): Promise<void> {
      shape = JSON.parse(JSON.stringify(next)) as PersistedShape;
    },
  };
}

const registries: ConnectionRegistry[] = [];

function newRegistry(
  options: { testTimeoutMs?: number } = {},
): ConnectionRegistry {
  const registry = new ConnectionRegistry({
    persistence: memoryPersistence(),
    ...options,
  });
  registries.push(registry);
  return registry;
}

afterEach(() => {
  for (const registry of registries) registry.closeAll();
  registries.length = 0;
});

describe("主机页 relay 连接 AK 凭证（Task 17）", () => {
  it("AK 三要素建连：换发 access 消费于首帧 auth（Basic 出示 akId:akSecret；POST token 端点）", async () => {
    const relay = await startFakeRelay();
    const admin = await startFakeAdmin(() =>
      accessEnvelope("access-1", REMAIN_FULL_MS),
    );
    try {
      const registry = newRegistry();
      await registry.saveConnection(akRelayConfig("conn-ak-1", admin.url, relay.url));
      await registry.activate("conn-ak-1");

      // 换发请求：POST /relay-admin/token + Basic base64(akId:akSecret)
      await vi.waitFor(() => expect(admin.requests.length).toBe(1));
      expect(admin.requests[0].method).toBe("POST");
      expect(admin.requests[0].url).toBe("/relay-admin/token");
      expect(admin.requests[0].authorization).toBe(
        `Basic ${Buffer.from("ak-test:sk-test").toString("base64")}`,
      );

      // 首帧 auth 使用换发的 access（非 AK 凭证本身）
      await vi.waitFor(() => expect(relay.conns.length).toBe(1));
      const auth = await relay.conns[0].waitForFrame((f) => f.kind === "auth");
      expect(auth).toMatchObject({ token: "access-1", role: "client" });

      // 连接态走 regular 通道（ws open 即 connected）
      await vi.waitFor(async () => {
        const list = await registry.list();
        expect(list.connections[0].state).toBe("connected");
      });
    } finally {
      await relay.close();
      await admin.kill();
    }
  }, 12_000);

  it("401 → 凭证失效态（invalid-token 粘滞，不连 relay；请求路径不自动重试）", async () => {
    const relay = await startFakeRelay();
    const admin = await startFakeAdmin(() => unauthorized());
    try {
      const registry = newRegistry();
      await registry.saveConnection(akRelayConfig("conn-401", admin.url, relay.url));
      await registry.activate("conn-401");

      await vi.waitFor(() => expect(admin.requests.length).toBe(1));
      await vi.waitFor(async () => {
        const list = await registry.list();
        expect(list.connections[0].state).toBe("invalid-token");
      });
      // 未裸连（无凭证不建 relay ws）
      expect(relay.conns.length).toBe(0);

      // 请求路径：拒绝且给出可读错误；不重复打 admin（粘滞）
      await expect(
        registry.request("conn-401", "GET", "info"),
      ).rejects.toThrow(/AK 凭证失效/);
      expect(admin.requests.length).toBe(1);
    } finally {
      await relay.close();
      await admin.kill();
    }
  }, 12_000);

  it("static 优先：relayToken 在场时零 AK 请求（解析层短路，auth token=static）", async () => {
    const relay = await startFakeRelay();
    const admin = await startFakeAdmin(() =>
      accessEnvelope("unused", REMAIN_FULL_MS),
    );
    try {
      const registry = newRegistry();
      await registry.saveConnection(
        akRelayConfig("conn-static", admin.url, relay.url, {
          relayToken: "static-wins",
        }),
      );
      await registry.activate("conn-static");

      await vi.waitFor(() => expect(relay.conns.length).toBe(1));
      const auth = await relay.conns[0].waitForFrame((f) => f.kind === "auth");
      expect(auth.token).toBe("static-wins");
      expect(admin.requests.length).toBe(0); // token 在场 → AK 机制整体旁路
    } finally {
      await relay.close();
      await admin.kill();
    }
  }, 12_000);

  it("换新瞬态失败且存量未过期 → 降级照常连（auth token=存量 access）", async () => {
    const relay = await startFakeRelay();
    // 首发短剩余（60s，shouldRenew 真值但未过期）
    const admin = await startFakeAdmin(() =>
      accessEnvelope("access-old", REMAIN_SHORT_MS),
    );
    try {
      const registry = newRegistry();
      const config = akRelayConfig("conn-degrade", admin.url, relay.url);
      await registry.saveConnection(config);
      await registry.activate("conn-degrade");
      await vi.waitFor(() => expect(relay.conns.length).toBe(1));
      expect(
        (await relay.conns[0].waitForFrame((f) => f.kind === "auth")).token,
      ).toBe("access-old");

      // admin 断供（硬杀——undici 池不挂住）→ 重建连接：换新失败降级用存量
      await admin.kill();
      await registry.saveConnection(config); // save → 拆 transport，下次使用重建
      await registry.activate("conn-degrade");
      await vi.waitFor(() => expect(relay.conns.length).toBe(2), { timeout: 6000 });
      expect(
        (await relay.conns[1].waitForFrame((f) => f.kind === "auth")).token,
      ).toBe("access-old");
      expect(admin.requests.length).toBe(1); // 断供后无第二发成功请求
    } finally {
      await relay.close();
    }
  }, 15_000);

  it("换控制平面：同 connId 同 akId 改 adminUrl → 存量作废，向新 admin 换发（终审 Minor 9）", async () => {
    const relay = await startFakeRelay();
    const adminOld = await startFakeAdmin(() =>
      accessEnvelope("access-old-admin", REMAIN_FULL_MS),
    );
    const adminNew = await startFakeAdmin(() =>
      accessEnvelope("access-new-admin", REMAIN_FULL_MS),
    );
    try {
      const registry = newRegistry();
      const id = "conn-admin-url";
      await registry.saveConnection(
        akRelayConfig(id, adminOld.url, relay.url),
      );
      await registry.activate(id);
      await vi.waitFor(() => expect(adminOld.requests.length).toBe(1));
      await vi.waitFor(() => expect(relay.conns.length).toBe(1));
      expect(
        (await relay.conns[0].waitForFrame((f) => f.kind === "auth")).token,
      ).toBe("access-old-admin");

      // 改 config 的 adminUrl（akId 不变）→ 旧 admin 签发的 access 不复用
      await registry.saveConnection(
        akRelayConfig(id, adminNew.url, relay.url),
      );
      await registry.activate(id);
      await vi.waitFor(() => expect(adminNew.requests.length).toBe(1), {
        timeout: 6000,
      });
      await vi.waitFor(() => expect(relay.conns.length).toBe(2), {
        timeout: 6000,
      });
      expect(
        (await relay.conns[1].waitForFrame((f) => f.kind === "auth")).token,
      ).toBe("access-new-admin");
      expect(adminOld.requests.length).toBe(1); // 旧 admin 不再被请求
    } finally {
      await relay.close();
      await adminOld.kill();
      await adminNew.kill();
    }
  }, 15_000);

  it("无存量 + admin 不可达 → 凭证失效态（不能无凭证连接）", async () => {
    const relay = await startFakeRelay();
    const deadPort = await reservePort();
    try {
      const registry = newRegistry();
      await registry.saveConnection(
        akRelayConfig("conn-dead", `http://127.0.0.1:${deadPort}`, relay.url),
      );
      await registry.activate("conn-dead");

      await vi.waitFor(async () => {
        const list = await registry.list();
        expect(list.connections[0].state).toBe("invalid-token");
      });
      expect(relay.conns.length).toBe(0);
    } finally {
      await relay.close();
    }
  }, 12_000);

  it("顶替守卫：换发挂起期间 save 顶掉旧配置 → 迟到成功不落地（无 stale 连接）", async () => {
    const relay = await startFakeRelay();
    // 首个换发请求挂起（受控放行）；其后响应换绑后的新凭证换发
    const held = (() => {
      let release!: (out: AdminResponse) => void;
      const promise = new Promise<AdminResponse>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    })();
    const admin = await startFakeAdmin((index) =>
      index === 0 ? held.promise : accessEnvelope("access-new", REMAIN_FULL_MS),
    );
    try {
      const registry = newRegistry();
      const id = "conn-race";
      await registry.saveConnection(akRelayConfig(id, admin.url, relay.url));
      await registry.activate(id); // 建连挂起在换发 fetch 上（≤30s 窗口）
      await vi.waitFor(() => expect(admin.requests.length).toBe(1));

      // 新配置顶掉（akId 换绑 → 存量 akId 不匹配防线兜底）
      await registry.saveConnection(
        akRelayConfig(id, admin.url, relay.url, { akId: "ak-new" }),
      );

      // 放行旧换发（迟到成功）：旧建连须就地收场——不开 stale 连接
      held.release(accessEnvelope("access-stale", REMAIN_FULL_MS));
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(relay.conns.length).toBe(0);

      // 新配置正常建连（换绑 akId → 重新换发 access-new）
      await registry.activate(id);
      await vi.waitFor(() => expect(relay.conns.length).toBe(1), { timeout: 6000 });
      const auth = await relay.conns[0].waitForFrame((f) => f.kind === "auth");
      expect(auth.token).toBe("access-new");
      expect(admin.requests.length).toBe(2);
    } finally {
      await relay.close();
      await admin.kill();
    }
  }, 15_000);

  it("删除连接清存量 access（重建后重新换发）", async () => {
    const relay = await startFakeRelay();
    const admin = await startFakeAdmin((index) =>
      accessEnvelope(`a${index + 1}`, REMAIN_FULL_MS),
    );
    try {
      const registry = newRegistry();
      const config = akRelayConfig("conn-del", admin.url, relay.url);
      await registry.saveConnection(config);
      await registry.activate("conn-del");
      await vi.waitFor(() => expect(admin.requests.length).toBe(1));

      await registry.deleteConnection("conn-del");
      await registry.saveConnection(config);
      await registry.activate("conn-del");
      // 存量已清 → 重新换发（第二发），auth 用新 access
      await vi.waitFor(() => expect(admin.requests.length).toBe(2));
      await vi.waitFor(() => expect(relay.conns.length).toBeGreaterThanOrEqual(1));
      const auth = await relay.conns[relay.conns.length - 1].waitForFrame(
        (f) => f.kind === "auth",
      );
      expect(auth.token).toBe("a2");
    } finally {
      await relay.close();
      await admin.kill();
    }
  }, 12_000);

  it("配置校验：AK 缺要素/管理端地址非法拒绝；static+AK 并存放行", async () => {
    const relay = await startFakeRelay();
    const admin = await startFakeAdmin(() =>
      accessEnvelope("unused", REMAIN_FULL_MS),
    );
    try {
      const registry = newRegistry();
      const base = akRelayConfig("conn-valid", admin.url, relay.url);
      // 无任何凭证（relayToken 与 AK 均缺）
      const { adminUrl: _a, akId: _i, akSecret: _s, ...bare } = base;
      await expect(registry.saveConnection(bare)).rejects.toThrow(
        /relayToken|AK/,
      );
      // 部分 AK（缺 akSecret）
      const { akSecret: _secret, ...partial } = base;
      await expect(registry.saveConnection(partial)).rejects.toThrow(/三要素/);
      // 管理端地址非 http(s)
      await expect(
        registry.saveConnection({ ...base, adminUrl: "ftp://admin.example.com" }),
      ).rejects.toThrow(/http/);
      // static + AK 并存放行（static 优先）
      await expect(
        registry.saveConnection({ ...base, relayToken: "static" }),
      ).resolves.toBeDefined();
    } finally {
      await relay.close();
      await admin.kill();
    }
  }, 12_000);

  it("testConnection：AK 401 → invalid-token；static 在场零 AK 请求", async () => {
    const relay = await startFakeRelay();
    const admin = await startFakeAdmin((index) =>
      index === 0 ? unauthorized() : accessEnvelope("unused", REMAIN_FULL_MS),
    );
    try {
      const registry = newRegistry({ testTimeoutMs: 1_500 });
      const denied = await registry.test(
        akRelayConfig("draft-401", admin.url, relay.url),
      );
      expect(denied).toMatchObject({ ok: false, reason: "invalid-token" });
      expect(admin.requests.length).toBe(1);

      // static 优先：草稿带 relayToken → 零 AK 请求（假 relay 无被控端
      // 应答 → timeout 是预期失败面，断言主体是 admin 零请求）
      const staticResult = await registry.test(
        akRelayConfig("draft-static", admin.url, relay.url, {
          relayToken: "static-draft",
        }),
      );
      expect(admin.requests.length).toBe(1);
      expect(staticResult.ok).toBe(false);
      expect(staticResult.ok === false && staticResult.reason).toBe("timeout");
    } finally {
      await relay.close();
      await admin.kill();
    }
  }, 15_000);
});

describe("resolveRelayAccessToken（短连接收口——T16 移动端语义同构）", () => {
  const creds = (adminUrl: string, akId = "ak-mod"): RelayAkCredentials => ({
    adminUrl,
    akId,
    akSecret: "sk-mod",
  });

  it("存量新鲜直用：第二次解析零 admin 请求", async () => {
    const admin = await startFakeAdmin(() =>
      accessEnvelope("m1", REMAIN_FULL_MS),
    );
    try {
      clearRelayAccess("mod-fresh");
      const first = await resolveRelayAccessToken("mod-fresh", creds(admin.url));
      expect(first).toEqual({ ok: true, accessToken: "m1" });
      const before = admin.requests.length;

      const second = await resolveRelayAccessToken("mod-fresh", creds(admin.url));
      expect(second).toEqual({ ok: true, accessToken: "m1" });
      expect(admin.requests.length).toBe(before); // 零换发请求
    } finally {
      await admin.kill();
    }
  }, 8_000);

  it("akId 换绑 → 存量作废重新换发（旧租户 access 不可复用）", async () => {
    const admin = await startFakeAdmin((index) =>
      accessEnvelope(`m${index + 1}`, REMAIN_FULL_MS),
    );
    try {
      clearRelayAccess("mod-rebind");
      await resolveRelayAccessToken("mod-rebind", creds(admin.url, "ak-a"));
      const rebound = await resolveRelayAccessToken(
        "mod-rebind",
        creds(admin.url, "ak-b"),
      );
      expect(rebound).toEqual({ ok: true, accessToken: "m2" });
      expect(admin.requests.length).toBe(2);
    } finally {
      await admin.kill();
    }
  }, 8_000);

  it("存量该换（剩<50%）→ 换新返回新 access", async () => {
    const admin = await startFakeAdmin((index) =>
      index === 0
        ? accessEnvelope("m-old", REMAIN_SHORT_MS)
        : accessEnvelope("m-new", REMAIN_FULL_MS),
    );
    try {
      clearRelayAccess("mod-renew");
      await resolveRelayAccessToken("mod-renew", creds(admin.url));
      const renewed = await resolveRelayAccessToken("mod-renew", creds(admin.url));
      expect(renewed).toEqual({ ok: true, accessToken: "m-new" });
      expect(admin.requests.length).toBe(2);
    } finally {
      await admin.kill();
    }
  }, 8_000);
});

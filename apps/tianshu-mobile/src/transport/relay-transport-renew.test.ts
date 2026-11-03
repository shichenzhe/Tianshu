/**
 * relay 连接 AK 凭证——连接前续期（relay 多租户，T16）：移动端控制端
 * 短连接语义（无常驻续期循环，每次连接前收口），全链路真实件驱动
 * （connections.store → connection → relay-ak → relay-transport 真身）：
 * - 静态 relayToken 优先：在场零 admin 请求（解析层短路守卫）；
 * - AK 三要素：本地 access 新鲜（剩 >50%）→ 直连零 admin 请求；缺失或
 *   shouldRenew 真（剩 <50%，@tianshu/core 单源）→ POST
 *   {adminUrl}/relay-admin/token（Basic akId:akSecret，T12 契约）换新后
 *   首帧 auth token=新 access，换新记录回写 SecureStore；
 * - 换新 401 → invalid-token 粘滞（不连、不重试——复用 4001 语义面，
 *   连接页红点提示重贴 AK）；无存量+网络失败同归 invalid-token；
 * - 换新网络失败 + 存量未过期 → 降级照常连；
 * - 换 AK（akId 变更）→ 存量作废重换（防旧租户 access 复用）；
 * - 顶替竞态（T15 教训携带）：激活切换后迟到的换新成功不踩新状态；
 * - shouldRenew 与 packages/tianshu-core 单源交叉锁（双份移植防漂移）。
 * mock 面：FakeWebSocket + stubGlobal fetch（relay-transport-e2e.test.ts
 * 同款）；AsyncStorage/SecureStore 内存替身（connections.store.test.ts
 * 同款）；direct-transport 工厂替身（阻断 expo/fetch 传递链）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as coreCredential from "../../../../packages/tianshu-core/src/relay-credential";

vi.mock("expo-crypto", () => {
  const { webcrypto } = require("node:crypto");
  return {
    getRandomValues: (arr: Uint8Array): Uint8Array => {
      webcrypto.getRandomValues(arr);
      return arr;
    },
    getRandomBytes: (n: number): Uint8Array =>
      webcrypto.getRandomValues(new Uint8Array(n)),
  };
});

// —— AsyncStorage 内存 Map 替身（node vitest 环境无 RN 原生模块） ——
const storageMock = vi.hoisted(() => {
  const storage = new Map<string, string>();
  return {
    storage,
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      storage.set(key, value);
      return Promise.resolve();
    }),
  };
});

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: storageMock,
}));

// —— expo-secure-store 内存替身（access 记录/akSecret 均落此处） ——
const secureMock = vi.hoisted(() => {
  const storage = new Map<string, string>();
  return {
    storage,
    setItemAsync: vi.fn(async (key: string, value: string) => {
      storage.set(key, value);
    }),
    getItemAsync: vi.fn(async (key: string) => storage.get(key) ?? null),
    deleteItemAsync: vi.fn(async (key: string) => {
      storage.delete(key);
    }),
  };
});

vi.mock("expo-secure-store", () => secureMock);

// —— direct-transport 工厂替身：阻断 connection → direct-transport →
// expo/fetch → react-native 传递链（本套件只走 relay 路径；顶替用例需
// 一个可观测的 direct 假件） ——
const directMock = vi.hoisted(() => ({
  createDirectTransport: vi.fn(() => ({
    request: vi.fn(),
    onEvent: vi.fn(() => () => undefined),
    onState: vi.fn(() => () => undefined),
    close: vi.fn(),
  })),
}));
vi.mock("./direct-transport", () => ({
  createDirectTransport: directMock.createDirectTransport,
}));

import { FakeWebSocket } from "../testing/fake-websocket";
import { useConnectionsStore } from "../store/connections.store";
import { isValidConfig, type ConnectionConfig } from "./connection";
import { shouldRenew } from "./relay-ak";

/** T12 契约：maxAgeSec=2592000（30d） */
const MAX_AGE_SEC = 2_592_000;
const ACCESS_KEY = "tianshu-mobile.relay-access.r1";

const akRelayCfg: ConnectionConfig = {
  id: "r1",
  name: "中继 AK",
  mode: "relay",
  relayUrl: "ws://127.0.0.1:8411/ws",
  connectionId: "inst-1",
  adminUrl: "http://127.0.0.1:8412",
  akId: "ak-1",
  akSecret: "sk-1",
};

const directCfg: ConnectionConfig = {
  id: "d1",
  name: "直连",
  mode: "direct",
  baseUrl: "http://192.168.1.10:8787",
  token: "tk",
};

/** 统一信封成功响应（T12：{code,message,data} + 真状态码 200） */
const okTokenResponse = (accessToken: string) => ({
  ok: true,
  status: 200,
  json: async () => ({
    code: "2000",
    message: "ok",
    data: { accessToken, expiresAt: Date.now() + MAX_AGE_SEC * 1000, maxAgeSec: MAX_AGE_SEC },
  }),
});

/** 本地存量 access 记录播种：remainRatio=剩余寿命占比（0~1）；adminUrl
 *  随记（缓存键成员——与 config 不符即作废），缺省对齐 akRelayCfg */
function seedAccess(
  remainRatio: number,
  akId = "ak-1",
  adminUrl = akRelayCfg.adminUrl!,
): void {
  secureMock.storage.set(
    ACCESS_KEY,
    JSON.stringify({
      akId,
      adminUrl,
      accessToken: "access-stored",
      expiresAt: Date.now() + MAX_AGE_SEC * 1000 * remainRatio,
      maxAgeSec: MAX_AGE_SEC,
    }),
  );
}

/** store 是模块级单例：用例间拆残留实例并复位 state */
function resetStore(): void {
  const s = useConnectionsStore.getState();
  for (const c of s.list()) s.remove(c.id);
  useConnectionsStore.setState({
    configs: [],
    activeConnId: null,
    states: {},
    capabilitiesByConn: {},
  });
}

const fetchMock = vi.fn();
/** 激活的换新/建连链路是异步 fire-and-forget：等一个宏任务窗收口 */
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("relay 连接 AK 凭证——连接前续期", () => {
  beforeEach(() => {
    resetStore();
    storageMock.storage.clear();
    secureMock.storage.clear();
    directMock.createDirectTransport.mockClear();
    fetchMock.mockReset();
    FakeWebSocket.instances = [];
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("AK 配置 + access 新鲜（剩 >50%）→ 直连零 admin 请求，首帧 auth 用存量", async () => {
    seedAccess(0.9);
    const s = useConnectionsStore.getState();
    s.save(akRelayCfg);
    s.activate("r1");
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.onopen?.();
    const auth = ws.frames()[0] as { kind: string; token: string; role: string };
    expect(auth).toMatchObject({ kind: "auth", role: "client" });
    expect(auth.token).toBe("access-stored");
  });

  it("shouldRenew 真 → 换新后连接：URL/POST/Basic 契约 + auth=新 access + 回写", async () => {
    seedAccess(0.1);
    fetchMock.mockResolvedValueOnce(okTokenResponse("access-new"));
    const s = useConnectionsStore.getState();
    s.save(akRelayCfg);
    s.activate("r1");
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8412/relay-admin/token");
    expect(init.method).toBe("POST");
    // Basic 头独立计算（Buffer），非实现自比
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("ak-1:sk-1").toString("base64")}`,
    );
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.onopen?.();
    expect((ws.frames()[0] as { token: string }).token).toBe("access-new");
    // 换新记录回写 SecureStore（akId 随记，换 AK 即作废）
    const rec = JSON.parse(secureMock.storage.get(ACCESS_KEY)!) as {
      akId: string;
      accessToken: string;
    };
    expect(rec).toMatchObject({ akId: "ak-1", accessToken: "access-new" });
  });

  it("无存量 access → 必换新（缺失视同该换）", async () => {
    fetchMock.mockResolvedValueOnce(okTokenResponse("access-first"));
    const s = useConnectionsStore.getState();
    s.save(akRelayCfg);
    s.activate("r1");
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.onopen?.();
    expect((ws.frames()[0] as { token: string }).token).toBe("access-first");
  });

  it("换新 401 → invalid-token 粘滞：不建连、不重试（复用 4001 语义面）", async () => {
    seedAccess(0.1);
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ code: "4010", message: "disabled", data: { reason: "disabled" } }),
    });
    const s = useConnectionsStore.getState();
    s.save(akRelayCfg);
    s.activate("r1");
    await settle();

    expect(useConnectionsStore.getState().states["r1"]).toBe("invalid-token");
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(useConnectionsStore.getState().selectActive()).toBeNull();
    await settle(80);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 粘滞：零重试
  });

  it("换新网络失败 + 存量未过期 → 降级照常连（auth=存量 access）", async () => {
    seedAccess(0.3); // 剩 30%：shouldRenew 真但未过期
    fetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
    const s = useConnectionsStore.getState();
    s.save(akRelayCfg);
    s.activate("r1");
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.onopen?.();
    expect((ws.frames()[0] as { token: string }).token).toBe("access-stored");
  });

  it("无存量 + 网络失败 → invalid-token 态（不能无凭证连接）", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
    const s = useConnectionsStore.getState();
    s.save(akRelayCfg);
    s.activate("r1");
    await settle();

    expect(useConnectionsStore.getState().states["r1"]).toBe("invalid-token");
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("static 优先：relayToken 在场零 AK 请求，auth 用静态 token", async () => {
    seedAccess(0.1); // 即便存量该换新，static 在场也不触 admin
    const s = useConnectionsStore.getState();
    s.save({ ...akRelayCfg, relayToken: "static-tok" });
    s.activate("r1");
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.onopen?.();
    expect((ws.frames()[0] as { token: string }).token).toBe("static-tok");
  });

  it("换 AK（akId 变更）→ 存量作废重换，auth 用新 AK 的 access", async () => {
    seedAccess(0.9, "ak-old"); // 新鲜但属于旧 AK
    fetchMock.mockResolvedValueOnce(okTokenResponse("access-ak2"));
    const s = useConnectionsStore.getState();
    s.save({ ...akRelayCfg, akId: "ak-2", akSecret: "sk-2" });
    s.activate("r1");
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.onopen?.();
    expect((ws.frames()[0] as { token: string }).token).toBe("access-ak2");
  });

  it("换控制平面（adminUrl 变更、akId 不变）→ 存量作废重换，向新 admin 换发", async () => {
    seedAccess(0.9, "ak-1", "http://old-admin.example.com"); // 新鲜但旧 admin 签发
    fetchMock.mockResolvedValueOnce(okTokenResponse("access-new-admin"));
    const s = useConnectionsStore.getState();
    s.save(akRelayCfg); // config 的 adminUrl 与存量不符（akId 未变）
    s.activate("r1");
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8412/relay-admin/token");
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.onopen?.();
    expect((ws.frames()[0] as { token: string }).token).toBe("access-new-admin");
    // 旧档被覆盖：adminUrl 随记新值（同 adminUrl 后续直用零请求）
    const rec = JSON.parse(secureMock.storage.get(ACCESS_KEY)!) as {
      adminUrl: string;
      accessToken: string;
    };
    expect(rec).toMatchObject({
      adminUrl: "http://127.0.0.1:8412",
      accessToken: "access-new-admin",
    });
  });

  it("旧版无 adminUrl 的存量档案 → 等值判定自然不成立，重新换发（迁移面）", async () => {
    // 升级前持久化的记录没有 adminUrl 字段：usable 全等 undefined !== string
    secureMock.storage.set(
      ACCESS_KEY,
      JSON.stringify({
        akId: "ak-1",
        accessToken: "access-legacy",
        expiresAt: Date.now() + MAX_AGE_SEC * 1000,
        maxAgeSec: MAX_AGE_SEC,
      }),
    );
    fetchMock.mockResolvedValueOnce(okTokenResponse("access-migrated"));
    const s = useConnectionsStore.getState();
    s.save(akRelayCfg);
    s.activate("r1");
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1); // 不复用旧档（即便剩满寿）
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.onopen?.();
    expect((ws.frames()[0] as { token: string }).token).toBe("access-migrated");
  });

  it("顶替竞态：换新在途时切换激活，迟到成功不建连不踩新状态（T15 教训）", async () => {
    let release!: (v: unknown) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((res) => {
          release = res;
        }),
    );
    const s = useConnectionsStore.getState();
    s.save(akRelayCfg);
    s.save(directCfg);
    s.activate("r1");
    await settle(); // r1 卡在换新 fetch 上

    s.activate("d1"); // 顶替：切到 direct（同步建连）
    expect(directMock.createDirectTransport).toHaveBeenCalledTimes(1);

    release(okTokenResponse("access-late")); // 迟到成功
    await settle();
    expect(FakeWebSocket.instances).toHaveLength(0); // r1 未建 relay 连接
    expect(useConnectionsStore.getState().activeConnId).toBe("d1");
  });

  it("isValidConfig：AK 三要素齐备的 relay 配置有效；缺一无效", () => {
    expect(isValidConfig(akRelayCfg)).toBe(true);
    expect(isValidConfig({ ...akRelayCfg, akSecret: undefined })).toBe(false);
    expect(isValidConfig({ ...akRelayCfg, adminUrl: undefined })).toBe(false);
    expect(isValidConfig({ ...akRelayCfg, akId: undefined })).toBe(false);
  });

  it("AK 凭证持久化形态：akSecret 拆 SecureStore、AsyncStorage 剥离，load 回填完整", async () => {
    const s = useConnectionsStore.getState();
    s.save(akRelayCfg);
    await settle();
    const persisted = JSON.parse(
      storageMock.storage.get("tianshu-mobile.connections")!,
    ) as { connections: Array<Record<string, unknown>> };
    expect(persisted.connections[0]).not.toHaveProperty("relayToken");
    expect(persisted.connections[0]).not.toHaveProperty("akSecret");
    expect(persisted.connections[0]).toMatchObject({
      adminUrl: "http://127.0.0.1:8412",
      akId: "ak-1",
    });
    expect(secureMock.storage.get("tianshu-mobile.ak-secret.r1")).toBe("sk-1");
    // 清内存后 load：剥离档 + secure akSecret 回填出完整 AK 配置
    useConnectionsStore.setState({ configs: [], activeConnId: null });
    await useConnectionsStore.getState().load();
    expect(useConnectionsStore.getState().list()).toEqual([akRelayCfg]);
  });

  it("字段移除即清键：static token 移除切 AK 后陈旧 token 键被清（防回填反压 AK）", async () => {
    const s = useConnectionsStore.getState();
    s.save({ ...akRelayCfg, relayToken: "static-tok", akSecret: undefined });
    await settle();
    expect(secureMock.storage.get("tianshu-mobile.token.r1")).toBe("static-tok");
    expect(secureMock.storage.get("tianshu-mobile.ak-secret.r1")).toBeUndefined();
    // 切纯 AK（token 字段移除）：token 键清、akSecret 键写
    s.save(akRelayCfg);
    await settle();
    expect(secureMock.storage.get("tianshu-mobile.token.r1")).toBeUndefined();
    expect(secureMock.storage.get("tianshu-mobile.ak-secret.r1")).toBe("sk-1");
  });

  it("shouldRenew 与 @tianshu/core 单源交叉锁（双份移植防漂移）", () => {
    const now = 1_700_000_000_000;
    const matrix: Array<[number, number]> = [
      [now + MAX_AGE_SEC * 1000, MAX_AGE_SEC], // 满寿
      [now + MAX_AGE_SEC * 500, MAX_AGE_SEC], // 恰剩 50%（严格小于：不续）
      [now + MAX_AGE_SEC * 500 - 1, MAX_AGE_SEC], // 剩 50%-1ms
      [now + 1, MAX_AGE_SEC], // 濒临过期
      [now - 1, MAX_AGE_SEC], // 已过期
      [now + 100, 60], // 小 maxAge 边界
    ];
    for (const [exp, maxAge] of matrix) {
      expect(shouldRenew(exp, maxAge, now)).toBe(
        coreCredential.shouldRenew(exp, maxAge, now),
      );
    }
    // 边界语义独立钉死（不依赖 core 实现自比）
    expect(shouldRenew(now + MAX_AGE_SEC * 500, MAX_AGE_SEC, now)).toBe(false);
    expect(shouldRenew(now + MAX_AGE_SEC * 500 - 1, MAX_AGE_SEC, now)).toBe(true);
    expect(shouldRenew(now - 1, MAX_AGE_SEC, now)).toBe(true);
  });
});

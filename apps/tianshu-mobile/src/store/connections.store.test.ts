import { beforeEach, describe, expect, it, vi } from "vitest";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { classifyTestFailure, testConnection, type ConnectionConfig } from "../transport/connection";
import {
  activeTransport,
  subscribeTransportEvents,
  useConnectionsStore,
} from "./connections.store";

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

// —— expo-secure-store 内存替身（安全批 H：连接 token 迁出 AsyncStorage）——
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

// —— transport 工厂替身：假 Transport 全 vi.fn，可手动发射 state/event ——
const transportMocks = vi.hoisted(() => {
  const makeTransport = () => {
    const stateCbs = new Set<(s: string) => void>();
    const eventCbs = new Set<(e: unknown) => void>();
    return {
      request: vi.fn(),
      onEvent: vi.fn((cb: (e: unknown) => void) => {
        eventCbs.add(cb);
        return () => eventCbs.delete(cb);
      }),
      onState: vi.fn((cb: (s: string) => void) => {
        stateCbs.add(cb);
        return () => stateCbs.delete(cb);
      }),
      close: vi.fn(() => {
        for (const cb of stateCbs) cb("closed"); // 真实 Transport close 会发 closed 终态
      }),
      emitState: (s: string) => {
        for (const cb of stateCbs) cb(s);
      },
      emitEvent: (e: unknown) => {
        for (const cb of eventCbs) cb(e);
      },
    };
  };
  return {
    makeTransport,
    createDirectTransport: vi.fn(),
    createRelayTransport: vi.fn(),
  };
});

vi.mock("../transport/direct-transport", () => ({
  createDirectTransport: transportMocks.createDirectTransport,
}));
vi.mock("../transport/relay-transport", () => ({
  createRelayTransport: transportMocks.createRelayTransport,
}));

const directCfg: ConnectionConfig = {
  id: "d1",
  name: "桌面直连",
  mode: "direct",
  baseUrl: "http://192.168.1.10:8787",
  token: "tk",
};
const relayCfg: ConnectionConfig = {
  id: "r1",
  name: "中继",
  mode: "relay",
  relayUrl: "wss://relay.example/ws",
  relayToken: "rt",
  connectionId: "inst-1",
};

/** 持久化剥离形态（token/relayToken 不落 AsyncStorage——安全批 H） */
function sanitized(cfg: ConnectionConfig): ConnectionConfig {
  const { token: _t, relayToken: _r, ...rest } = cfg;
  return rest as ConnectionConfig;
}

/** store 是模块级单例：用例间拆残留实例并复位 state */
function resetStore(): void {
  const s = useConnectionsStore.getState();
  for (const c of s.list()) s.remove(c.id);
  useConnectionsStore.setState({ configs: [], activeConnId: null, states: {}, capabilitiesByConn: {} });
}

describe("classifyTestFailure", () => {
  it("401/4010 → invalid-token", () => {
    expect(classifyTestFailure({ status: 200, body: { code: "4010" } })).toBe("invalid-token");
    expect(classifyTestFailure({ status: 401, body: null })).toBe("invalid-token");
  });
  it("status 0 → timeout/unreachable 归 timeout", () => {
    expect(classifyTestFailure({ status: 0, body: null })).toBe("timeout");
  });
  it("其余 → unreachable", () => {
    expect(classifyTestFailure({ status: 200, body: { code: "2000", success: true, data: { capabilities: ["chat"] } } })).toBe("unreachable"); // 成功不该进此函数，防御口径
    expect(classifyTestFailure({ status: 500, body: null })).toBe("unreachable");
  });
});

describe("connections store", () => {
  beforeEach(() => {
    resetStore();
    transportMocks.createDirectTransport.mockReset();
    transportMocks.createRelayTransport.mockReset();
    storageMock.storage.clear();
    storageMock.getItem.mockClear();
    storageMock.setItem.mockClear();
    secureMock.storage.clear();
    secureMock.setItemAsync.mockClear();
    secureMock.getItemAsync.mockClear();
    secureMock.deleteItemAsync.mockClear();
  });

  it("save→list：AsyncStorage 写入剥离 token 的 configs；token 落 secure-store", () => {
    const s = useConnectionsStore.getState();
    s.save(directCfg);
    s.save(relayCfg);

    expect(s.list()).toEqual([directCfg, relayCfg]);
    expect(storageMock.setItem).toHaveBeenLastCalledWith(
      "tianshu-mobile.connections",
      JSON.stringify({
        connections: [sanitized(directCfg), sanitized(relayCfg)],
        activeConnId: null,
      }),
    );
    expect(secureMock.storage.get("tianshu-mobile.token.d1")).toBe("tk");
    expect(secureMock.storage.get("tianshu-mobile.token.r1")).toBe("rt");
  });

  it("save 同 id upsert 覆写", () => {
    const s = useConnectionsStore.getState();
    s.save(directCfg);
    s.save({ ...directCfg, name: "改名" });

    expect(s.list()).toHaveLength(1);
    expect(s.list()[0]?.name).toBe("改名");
  });

  it("load：AsyncStorage 剥离档 + secure-store token 回填出完整 configs", async () => {
    storageMock.storage.set(
      "tianshu-mobile.connections",
      JSON.stringify({
        connections: [sanitized(directCfg), sanitized(relayCfg)],
        activeConnId: "r1",
      }),
    );
    secureMock.storage.set("tianshu-mobile.token.d1", "tk");
    secureMock.storage.set("tianshu-mobile.token.r1", "rt");
    await useConnectionsStore.getState().load();

    const s = useConnectionsStore.getState();
    expect(s.list()).toEqual([directCfg, relayCfg]);
    expect(s.activeConnId).toBe("r1");
    expect(s.selectActive()).toBeNull();
  });

  it("load 旧档迁移：AsyncStorage 内嵌 token 的存量档拆到 secure-store 并覆写剥离版", async () => {
    storageMock.storage.set(
      "tianshu-mobile.connections",
      JSON.stringify({ connections: [directCfg], activeConnId: null }),
    );
    await useConnectionsStore.getState().load();

    // 内嵌 token 已迁 secure；AsyncStorage 被覆写为剥离形态
    expect(secureMock.storage.get("tianshu-mobile.token.d1")).toBe("tk");
    const rewritten = JSON.parse(
      storageMock.storage.get("tianshu-mobile.connections")!,
    );
    expect(rewritten.connections).toEqual([sanitized(directCfg)]);
    // 内存态完整（token 回填）
    expect(useConnectionsStore.getState().list()).toEqual([directCfg]);
  });

  it("load：坏档条目经 isValidConfig 过滤自愈，悬挂激活 id 一并清", async () => {
    const badCfg: ConnectionConfig = { id: "bad", name: "坏档", mode: "direct" }; // 缺 baseUrl/token
    storageMock.storage.set(
      "tianshu-mobile.connections",
      JSON.stringify({ connections: [badCfg, directCfg], activeConnId: "bad" }),
    );
    await useConnectionsStore.getState().load();

    const s = useConnectionsStore.getState();
    expect(s.list()).toEqual([directCfg]);
    expect(s.activeConnId).toBeNull();
  });

  it("activate：按 mode 调对应工厂、切换时 close 旧实例、onState 回写 states", () => {
    const direct = transportMocks.makeTransport();
    const relay = transportMocks.makeTransport();
    transportMocks.createDirectTransport.mockImplementation(() => direct);
    transportMocks.createRelayTransport.mockImplementation(() => relay);

    const s = useConnectionsStore.getState();
    s.save(directCfg);
    s.save(relayCfg);

    s.activate("d1");
    expect(transportMocks.createDirectTransport).toHaveBeenCalledWith({
      baseUrl: "http://192.168.1.10:8787",
      token: "tk",
    });
    expect(transportMocks.createRelayTransport).not.toHaveBeenCalled();
    expect(s.selectActive()).toBe(direct);

    direct.emitState("connected");
    expect(useConnectionsStore.getState().states["d1"]).toBe("connected");

    s.activate("r1");
    expect(transportMocks.createRelayTransport).toHaveBeenCalledWith({
      relayUrl: "wss://relay.example/ws",
      relayToken: "rt",
      connectionId: "inst-1",
      onFingerprintPinned: expect.any(Function),
    });
    expect(direct.close).toHaveBeenCalled();
    expect(useConnectionsStore.getState().states["d1"]).toBe("closed"); // 拆除序：close 先于退订
    expect(useConnectionsStore.getState().selectActive()).toBe(relay);
    expect(storageMock.setItem).toHaveBeenLastCalledWith(
      "tianshu-mobile.connections",
      JSON.stringify({
        connections: [sanitized(directCfg), sanitized(relayCfg)],
        activeConnId: "r1",
      }),
    );
  });

  it("activate relay：e2eMode/fingerprint 透传传输层（安全批 H）", () => {
    const relay = transportMocks.makeTransport();
    transportMocks.createRelayTransport.mockImplementation(() => relay);
    const s = useConnectionsStore.getState();
    s.save({ ...relayCfg, e2eMode: "required", fingerprint: "aabb001122334455" });
    s.activate("r1");
    expect(transportMocks.createRelayTransport).toHaveBeenCalledWith({
      relayUrl: "wss://relay.example/ws",
      relayToken: "rt",
      connectionId: "inst-1",
      e2eMode: "required",
      fingerprint: "aabb001122334455",
      onFingerprintPinned: expect.any(Function),
    });
  });

  it("TOFU 指纹回填：onFingerprintPinned 回调写回 config.fingerprint 并持久化", () => {
    const relay = transportMocks.makeTransport();
    transportMocks.createRelayTransport.mockImplementation(() => relay);
    const s = useConnectionsStore.getState();
    s.save(relayCfg); // 无指纹首连
    s.activate("r1");
    const callArgs = transportMocks.createRelayTransport.mock.calls[0][0] as {
      onFingerprintPinned: (fp: string) => void;
    };
    callArgs.onFingerprintPinned("ffeedd0011223344");
    expect(useConnectionsStore.getState().list()[0]?.fingerprint).toBe(
      "ffeedd0011223344",
    );
    // 持久化档含指纹（非敏感，随 configs 落 AsyncStorage）
    const persisted = JSON.parse(
      storageMock.storage.get("tianshu-mobile.connections")!,
    );
    expect(persisted.connections[0].fingerprint).toBe("ffeedd0011223344");
  });

  it("remove：删除配置并清 states 与 secure 凭证，激活项被删则 activeConnId 置空", () => {
    const direct = transportMocks.makeTransport();
    transportMocks.createDirectTransport.mockImplementation(() => direct);
    const s = useConnectionsStore.getState();
    s.save(directCfg);
    s.activate("d1");
    s.remove("d1");

    expect(useConnectionsStore.getState().list()).toEqual([]);
    expect(useConnectionsStore.getState().activeConnId).toBeNull();
    expect(useConnectionsStore.getState().states["d1"]).toBeUndefined();
    expect(direct.close).toHaveBeenCalled();
    expect(activeTransport()).toBeNull();
    // secure 凭证随配置删除（不留孤儿密钥）
    expect(secureMock.deleteItemAsync).toHaveBeenCalledWith(
      "tianshu-mobile.token.d1",
    );
  });

  it("testConnection：direct 网络级 reject（fetch 失败/非 JSON）归 unreachable 并关临时实例", async () => {
    const dead = transportMocks.makeTransport();
    dead.request.mockImplementation(() =>
      Promise.reject(new TypeError("Network request failed")),
    );
    transportMocks.createDirectTransport.mockImplementation(() => dead);

    await expect(testConnection(directCfg)).resolves.toEqual({ ok: false, reason: "unreachable" });
    expect(dead.close).toHaveBeenCalled();
  });

  it("server.connected：写 capabilitiesByConn 缓存（其他事件类型不写）", () => {
    const direct = transportMocks.makeTransport();
    transportMocks.createDirectTransport.mockImplementation(() => direct);
    const s = useConnectionsStore.getState();
    s.save(directCfg);
    s.activate("d1");

    direct.emitEvent({
      type: "session.updated",
      payload: { id: 1, title: null, updatedAt: "2026-10-17T00:00:00Z" },
    });
    expect(useConnectionsStore.getState().capabilitiesByConn["d1"]).toBeUndefined();

    direct.emitEvent({
      type: "server.connected",
      payload: { instanceId: "inst-1", capabilities: ["chat", "provider", "graph"] },
    });
    expect(useConnectionsStore.getState().capabilitiesByConn["d1"]).toEqual([
      "chat",
      "provider",
      "graph",
    ]);
    expect(useConnectionsStore.getState().capabilitiesByConn["r1"]).toBeUndefined();
  });

  it("teardown 清能力缓存（remove 与切换 activate 同经 teardown）", () => {
    const direct = transportMocks.makeTransport();
    const relay = transportMocks.makeTransport();
    transportMocks.createDirectTransport.mockImplementation(() => direct);
    transportMocks.createRelayTransport.mockImplementation(() => relay);
    const s = useConnectionsStore.getState();
    s.save(directCfg);
    s.save(relayCfg);
    s.activate("d1");
    direct.emitEvent({
      type: "server.connected",
      payload: { instanceId: "inst-1", capabilities: ["chat", "provider"] },
    });
    expect(useConnectionsStore.getState().capabilitiesByConn["d1"]).toEqual(["chat", "provider"]);

    // 切换激活：旧连接 teardown（close+退订）应清旧缓存，新连接待
    // server.connected 重写（未知门禁灰态）
    s.activate("r1");
    expect(useConnectionsStore.getState().capabilitiesByConn["d1"]).toBeUndefined();
    expect(useConnectionsStore.getState().capabilitiesByConn["r1"]).toBeUndefined();
    relay.emitEvent({
      type: "server.connected",
      payload: { instanceId: "inst-2", capabilities: ["chat"] },
    });
    expect(useConnectionsStore.getState().capabilitiesByConn["r1"]).toEqual(["chat"]);

    s.remove("r1");
    expect(useConnectionsStore.getState().capabilitiesByConn["r1"]).toBeUndefined();
  });

  it("subscribeTransportEvents：转发激活连接的 onEvent，退订即止", () => {
    const direct = transportMocks.makeTransport();
    transportMocks.createDirectTransport.mockImplementation(() => direct);
    const seen: unknown[] = [];
    const unsub = subscribeTransportEvents((e) => seen.push(e));

    const s = useConnectionsStore.getState();
    s.save(directCfg);
    s.activate("d1");
    const evt = { type: "server.connected", payload: { instanceId: "x", capabilities: [] } };
    direct.emitEvent(evt);
    expect(seen).toEqual([evt]);

    unsub();
    direct.emitEvent(evt);
    expect(seen).toHaveLength(1);
  });
});

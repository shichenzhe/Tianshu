import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";
import type { ServerEvent } from "@tianshu/protocol";
import { createTransport, isValidConfig, type ConnectionConfig } from "../transport/connection";
import { Emitter, type Transport, type TransportState } from "../transport/types";

/** 持久化 key（对齐桌面 option 表存档语义：整块 JSON 读写） */
const STORAGE_KEY = "tianshu-mobile.connections";

/** 连接凭证 secure-store key（安全批 H：token 迁出 AsyncStorage——
 *  AsyncStorage 明文落盘在越狱/备份提取面下不可信，凭证走钥匙串） */
const secureKeyFor = (connId: string): string => `tianshu-mobile.token.${connId}`;

/** 凭证字段取值（direct=token / relay=relayToken——剥离与回填对称） */
function secretOf(cfg: ConnectionConfig): string | undefined {
  return cfg.mode === "direct" ? cfg.token : cfg.relayToken;
}

/** 持久化剥离形态（凭证字段整体剔除，非置 undefined） */
function sanitizedForDisk(cfg: ConnectionConfig): ConnectionConfig {
  if (cfg.mode === "direct") {
    const { token: _token, ...rest } = cfg;
    return rest as ConnectionConfig;
  }
  const { relayToken: _relayToken, ...rest } = cfg;
  return rest as ConnectionConfig;
}

/** 凭证回填（内存态完整形态） */
function withSecret(cfg: ConnectionConfig, secret: string): ConnectionConfig {
  return cfg.mode === "direct"
    ? { ...cfg, token: secret }
    : { ...cfg, relayToken: secret };
}

interface PersistedConnections {
  connections: ConnectionConfig[];
  activeConnId: string | null;
}

interface TransportEntry {
  transport: Transport;
  dispose: () => void;
}

/** transport 实例表：不进 state（不可序列化运行时资源，store 只存配置/状态） */
const transports = new Map<string, TransportEntry>();

/** 激活连接事件外发总线（T13 会话层经 subscribeTransportEvents 消费） */
const eventSink = new Emitter<ServerEvent>();

export function subscribeTransportEvents(cb: (e: ServerEvent) => void): () => void {
  return eventSink.on(cb);
}

interface ConnectionsState {
  configs: ConnectionConfig[];
  activeConnId: string | null;
  states: Record<string, TransportState>;
  /** 连接能力面缓存（M2b）：activate 订阅内 server.connected 写入、
   * teardown 清除——ModelPicker/编排区等消费端经 useConnectionCapabilities
   * 读出，勿在页面层再自管 GET info 直查 */
  capabilitiesByConn: Record<string, string[]>;
  list(): ConnectionConfig[];
  load(): Promise<void>;
  save(cfg: ConnectionConfig): void;
  remove(id: string): void;
  activate(id: string): void;
  selectActive(): Transport | null;
}

/** 拆除某连接的 transport：先 close（closed 终态经订阅回写 states[id]）、
 * 再退订防迟到回调回写、出实例表；能力缓存一并清（旧值可能对应不同
 * 端点/配置，重连后由 server.connected 重写） */
function teardown(id: string | null | undefined): void {
  if (!id) return;
  const entry = transports.get(id);
  if (!entry) return;
  entry.transport.close();
  entry.dispose();
  transports.delete(id);
  useConnectionsStore.setState((s) => {
    const capabilitiesByConn = { ...s.capabilitiesByConn };
    delete capabilitiesByConn[id];
    return { capabilitiesByConn };
  });
}

/** fire-and-forget 持久化：写失败不阻塞交互，下次 save 覆盖重试。
 *  凭证拆 secure-store（按连接 key），AsyncStorage 只落剥离形态 */
function persist(): void {
  const { configs, activeConnId } = useConnectionsStore.getState();
  for (const cfg of configs) {
    const secret = secretOf(cfg);
    if (secret !== undefined) {
      void SecureStore.setItemAsync(secureKeyFor(cfg.id), secret).catch(() => {
        /* 静默：下次 persist 重试 */
      });
    }
  }
  void AsyncStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      connections: configs.map(sanitizedForDisk),
      activeConnId,
    } satisfies PersistedConnections),
  ).catch(() => {
    /* 静默：quota/IO 失败无需上抛 */
  });
}

export const useConnectionsStore = create<ConnectionsState>((set, get) => ({
  configs: [],
  activeConnId: null,
  states: {},
  capabilitiesByConn: {},

  list: () => get().configs,

  load: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<PersistedConnections>;
      if (!Array.isArray(parsed.connections)) return;
      // 凭证回填：旧档内嵌 token（安全批 H 前形态）就地迁 secure-store 并
      // 标记覆写；新档（剥离形态）按 key 从 secure-store 取回
      let migrated = false;
      const configs = await Promise.all(
        parsed.connections.map(async (c) => {
          const embedded = secretOf(c);
          if (embedded !== undefined) {
            migrated = true;
            await SecureStore.setItemAsync(secureKeyFor(c.id), embedded).catch(
              () => undefined,
            );
          }
          const secret =
            embedded ??
            (await SecureStore.getItemAsync(secureKeyFor(c.id)).catch(
              () => null,
            ));
          return secret !== null && secret !== undefined
            ? withSecret(c, secret)
            : c;
        }),
      );
      // 坏档自愈：缺必填字段的条目过滤掉；激活 id 指向被滤条目则一并清
      const valid = configs.filter(isValidConfig);
      const saved = parsed.activeConnId ?? null;
      set({
        configs: valid,
        activeConnId: saved && valid.some((c) => c.id === saved) ? saved : null,
      });
      if (migrated) persist(); // 覆写剥离版（secure 侧重复写无害）
    } catch {
      // 损坏存档按空注册表对待（下次 save 覆写自愈）
    }
  },

  /** upsert by id；只改配置不动实例——激活项改配置后重连由调用方再 activate */
  save: (cfg) => {
    set((s) => ({
      configs: s.configs.some((c) => c.id === cfg.id)
        ? s.configs.map((c) => (c.id === cfg.id ? cfg : c))
        : [...s.configs, cfg],
    }));
    persist();
  },

  remove: (id) => {
    teardown(id);
    // secure 凭证随配置删除（不留孤儿密钥；fire-and-forget 同 persist 口径）
    void SecureStore.deleteItemAsync(secureKeyFor(id)).catch(() => undefined);
    set((s) => {
      const states = { ...s.states };
      delete states[id];
      return {
        configs: s.configs.filter((c) => c.id !== id),
        states,
        ...(s.activeConnId === id ? { activeConnId: null } : {}),
      };
    });
    persist();
  },

  /** 激活/重激活：恒拆旧建新（含同 id——save 改配置后再 activate 即热重连）；
   *  relay 连接注入 TOFU 指纹回填钩子（encrypted 落定且 config 未带指纹时
   *  写回 config.fingerprint 并持久化——下次连接起强制校验） */
  activate: (id) => {
    const cfg = get().configs.find((c) => c.id === id);
    if (!cfg) return;
    teardown(get().activeConnId);
    const transport = createTransport(cfg, {
      onFingerprintPinned: (fp) => {
        const current = get().configs.find((c) => c.id === id);
        if (!current || current.fingerprint) return; // 已有指纹不覆写
        set((s) => ({
          configs: s.configs.map((c) =>
            c.id === id ? { ...c, fingerprint: fp } : c,
          ),
        }));
        persist();
      },
    });
    const unsubState = transport.onState((s) =>
      set((prev) => ({ states: { ...prev.states, [id]: s } })),
    );
    // server.connected 就地写能力缓存（先于 eventSink 下发）：连接级合成
    // 事件恒先于业务事件到达，消费端读缓存即免页面级 GET info 直查
    const unsubEvent = transport.onEvent((e) => {
      if (e.type === "server.connected") {
        set((prev) => ({
          capabilitiesByConn: {
            ...prev.capabilitiesByConn,
            [id]: e.payload.capabilities,
          },
        }));
      }
      eventSink.emit(e);
    });
    transports.set(id, {
      transport,
      dispose: () => {
        unsubState();
        unsubEvent();
      },
    });
    // 两工厂构造即同步进入 connecting（先于上方订阅发射）——初值对齐现实，
    // 后续发射（connected/reconnecting/...）覆写
    set((s) => ({ activeConnId: id, states: { ...s.states, [id]: "connecting" } }));
    persist();
  },

  selectActive: () => {
    const id = get().activeConnId;
    return id ? (transports.get(id)?.transport ?? null) : null;
  },
}));

/** 便捷取用：当前激活连接的 transport（未激活/重启后未 activate 为 null） */
export function activeTransport(): Transport | null {
  return useConnectionsStore.getState().selectActive();
}

/** 连接能力面 selector（M2b）：读 server.connected 写入的缓存。null =
 * 未知（未激活/尚未收到 server.connected/已拆除），消费端按无能力处理
 * （如 ModelPicker 灰胶囊——能力协商门禁语义：未知不视为具备） */
export function useConnectionCapabilities(connId: string | null): string[] | null {
  return useConnectionsStore((s) =>
    connId ? (s.capabilitiesByConn[connId] ?? null) : null,
  );
}

// store 创建即恢复存档（void：fire-and-forget，异常在 load 内消化）
void useConnectionsStore.getState().load();

export {
  testConnection,
  isValidConfig,
  validateRelayUrlScheme,
} from "../transport/connection";
export type { ConnectionConfig, TestResult } from "../transport/connection";

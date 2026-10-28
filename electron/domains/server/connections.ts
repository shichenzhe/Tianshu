// 控制端连接注册表（T16）：ConnectionConfig CRUD（option 表持久化——
// type="app" name="serverConnections" JSON {connections,activeConnId}）+
// 每连接 Transport 惰性建链（direct=fetch+SSE / relay=ws role=client，
// T13/T14 产物零改动复用）+ invalid-token 判别（T13/T14 契约注记：请求
// 401 / body.code==='4010' → 连接态 invalid-token，与 lost/断线区分——
// 配置纠正后 save 重建 transport 自愈）+ 本地无头端启停（Supervisor，
// spawn 解析 resolveLocalServerCommand——dev=<dir>/dist/src/main.js 真
// node；打包态不内嵌，startLocalServer 前置拒绝）。
// 活动连接（activeConnId）：注册表维护并持久化；session 类 IPC 既可显式
// 携带 connId（透传+切换活动连接，粘性），也可省略走当前活动连接。
import { app } from "electron";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import prisma from "../../commons/prisma-client";
import Log from "../../commons/Log";
import { DirectTransport } from "./direct-transport";
import { RelayTransport, type RelayE2eMode } from "./relay-transport";
import type { ServerEvent } from "./protocol";
import type {
  E2eStatusChange,
  Transport,
  TransportE2eState,
  TransportState,
} from "./transport";
import { ServerSupervisor, type HandshakeInfo } from "./supervisor";

const OPTION_TYPE = "app";
const OPTION_NAME = "serverConnections";
/** 本地无头端固定连接 id（localStart upsert 复用） */
export const LOCAL_CONNECTION_ID = "local";
/** testConnection 默认整体超时窗 */
const DEFAULT_TEST_TIMEOUT_MS = 8_000;
/** relay 建链等待窗（ws open 首请求兜底） */
const RELAY_READY_TIMEOUT_MS = 3_000;

export type ConnectionMode = "direct" | "relay";

export interface ConnectionConfig {
  id: string;
  name: string;
  mode: ConnectionMode;
  baseUrl?: string;
  token?: string;
  /** 备份专用 token：申领所得 clientToken；缺省回落 token=现状单用户语义 */
  backupToken?: string;
  relayUrl?: string;
  relayToken?: string;
  connectionId?: string;
  /** 被控端 E2E 指纹（hex16；空=TOFU 首连回填——E2E-T3。仅 relay 模式） */
  fingerprint?: string;
  /** 连接级 E2E 模式（仅 relay；缺省 auto。required=握手无 ack 拒降级直接
   * 断开——spec §2.4 控制端配置级开关，E2E-T4/T3 审查；无 off：不建 relay
   * 连接即得等价语义） */
  e2eMode?: RelayE2eMode;
  local?: boolean;
}

/** 连接运行态：transport 三态 + idle（未建链）+ invalid-token（401/4010
 * 粘滞——server.connected 或 save 重建才清除）+ closed（拆除后） */
export type ConnectionRuntimeState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "invalid-token"
  | "closed";

/** 注册表对外视图：配置 + 运行态 + 协商到的能力清单 + E2E 承载态（relay
 * 会话加密徽标数据；direct 恒 unsupported、idle 无值——UI 按 mode 门控） */
export interface ConnectionView extends ConnectionConfig {
  state: ConnectionRuntimeState;
  e2e?: TransportE2eState;
  capabilities: string[];
}

export interface PersistedShape {
  connections: ConnectionConfig[];
  activeConnId: string | null;
}

export type TestConnectionResult =
  | { ok: true; instanceId: string; capabilities: string[] }
  | {
      ok: false;
      reason: "invalid-config" | "invalid-token" | "unreachable" | "timeout";
      message: string;
    };

export interface ConnectionPersistence {
  load(): Promise<PersistedShape>;
  save(shape: PersistedShape): Promise<void>;
}

export type TransportFactory = (config: ConnectionConfig) => Transport;

export interface ConnectionRegistryOptions {
  persistence?: ConnectionPersistence;
  transportFactory?: TransportFactory;
  testTimeoutMs?: number;
}

interface TransportEntry {
  transport: Transport;
  state: ConnectionRuntimeState;
  e2e: TransportE2eState;
  capabilities: string[];
}

/** option 表持久化（server-face 配置同款 findFirst + update/create） */
export function createOptionPersistence(): ConnectionPersistence {
  return {
    async load(): Promise<PersistedShape> {
      const row = await prisma.option.findFirst({
        where: { type: OPTION_TYPE, name: OPTION_NAME },
      });
      return row
        ? parsePersisted(row.value)
        : { connections: [], activeConnId: null };
    },
    async save(shape: PersistedShape): Promise<void> {
      const value = JSON.stringify(shape);
      const row = await prisma.option.findFirst({
        where: { type: OPTION_TYPE, name: OPTION_NAME },
        select: { id: true },
      });
      if (row) {
        await prisma.option.update({ where: { id: row.id }, data: { value } });
      } else {
        await prisma.option.create({
          data: { type: OPTION_TYPE, name: OPTION_NAME, value },
        });
      }
    },
  };
}

/** 持久化 JSON 容错解析：坏 JSON/畸形行丢弃（server-face parseConfigValue 同口径） */
function parsePersisted(value: string): PersistedShape {
  try {
    const parsed = (JSON.parse(value) ?? {}) as {
      connections?: unknown;
      activeConnId?: unknown;
    };
    const connections = Array.isArray(parsed.connections)
      ? parsed.connections.filter(
          (c): c is ConnectionConfig =>
            typeof (c as ConnectionConfig)?.id === "string" &&
            (c as ConnectionConfig).id !== "",
        )
      : [];
    return {
      connections,
      activeConnId:
        typeof parsed.activeConnId === "string" ? parsed.activeConnId : null,
    };
  } catch {
    return { connections: [], activeConnId: null };
  }
}

/** 配置校验与归一（save/testConnection 共用）：id/必填按 mode 收口 */
function validateConfig(raw: unknown): ConnectionConfig {
  const candidate = (raw ?? {}) as Partial<ConnectionConfig>;
  if (typeof candidate.id !== "string" || !candidate.id.trim()) {
    throw new Error("连接配置缺少 id");
  }
  if (typeof candidate.name !== "string" || !candidate.name.trim()) {
    throw new Error("连接配置缺少名称");
  }
  const mode = candidate.mode;
  if (mode !== "direct" && mode !== "relay") {
    throw new Error("连接模式必须是 direct 或 relay");
  }
  const config: ConnectionConfig = {
    id: candidate.id,
    name: candidate.name,
    mode,
  };
  if (mode === "direct") {
    if (
      typeof candidate.baseUrl !== "string" ||
      !/^https?:\/\//.test(candidate.baseUrl)
    ) {
      throw new Error("直连模式需要合法的 baseUrl（http(s)://host:port）");
    }
    config.baseUrl = candidate.baseUrl.replace(/\/+$/, "");
  } else {
    for (const field of ["relayUrl", "relayToken", "connectionId"] as const) {
      if (typeof candidate[field] !== "string" || !candidate[field]) {
        throw new Error(`中继模式缺少 ${field}`);
      }
    }
    if (!/^wss?:\/\//.test(candidate.relayUrl!)) {
      throw new Error("中继模式 relayUrl 必须是 ws(s):// 地址");
    }
    config.relayUrl = candidate.relayUrl;
    config.relayToken = candidate.relayToken;
    config.connectionId = candidate.connectionId;
    // E2E 指纹（可选）：16 位十六进制，大小写归一（fingerprintOf 恒小写）
    if (
      typeof candidate.fingerprint === "string" &&
      candidate.fingerprint.trim()
    ) {
      const fingerprint = candidate.fingerprint.trim().toLowerCase();
      if (!/^[0-9a-f]{16}$/.test(fingerprint)) {
        throw new Error("E2E 指纹格式非法（应为 16 位十六进制）");
      }
      config.fingerprint = fingerprint;
    }
    // 连接级 E2E 模式（可选）：auto/required 二值（§2.4 控制端配置级开关）
    if (
      candidate.e2eMode !== undefined &&
      candidate.e2eMode !== "auto" &&
      candidate.e2eMode !== "required"
    ) {
      throw new Error("E2E 模式必须是 auto 或 required");
    }
    if (candidate.e2eMode) config.e2eMode = candidate.e2eMode;
  }
  if (typeof candidate.token === "string" && candidate.token) {
    config.token = candidate.token;
  }
  // 备份专用 token 透传（申领所得 clientToken；缺省回落 token=单用户）
  if (typeof candidate.backupToken === "string" && candidate.backupToken) {
    config.backupToken = candidate.backupToken;
  }
  if (candidate.local === true) config.local = true;
  return config;
}

/** 请求侧认证失败判别（T13/T14 契约注记：认证 401 例外——HTTP 401 或
 * starter 包装 code '4010'；业务错是 HTTP 200 + 4xxx 不在此列） */
function isAuthFailure(status: number, body: unknown): boolean {
  if (status === 401) return true;
  const code = (body as { code?: unknown } | null)?.code;
  return code === "4010";
}

const defaultTransportFactory: TransportFactory = (config) =>
  config.mode === "relay"
    ? new RelayTransport({
        relayUrl: config.relayUrl!,
        relayToken: config.relayToken!,
        connectionId: config.connectionId!,
        fingerprint: config.fingerprint,
        e2eMode: config.e2eMode,
      })
    : new DirectTransport({
        baseUrl: config.baseUrl!,
        token: config.token ?? "",
      });

export class ConnectionRegistry {
  private readonly persistence: ConnectionPersistence;
  private readonly transportFactory: TransportFactory;
  private readonly testTimeoutMs: number;
  private readonly entries = new Map<string, TransportEntry>();
  private eventSink: ((connId: string, event: ServerEvent) => void) | null =
    null;

  constructor(options: ConnectionRegistryOptions = {}) {
    this.persistence = options.persistence ?? createOptionPersistence();
    this.transportFactory = options.transportFactory ?? defaultTransportFactory;
    this.testTimeoutMs = options.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
  }

  /** 事件出口（IPC 层装配：message.chunk → server:chunk:*；session.* → server:event:*） */
  setEventSink(fn: (connId: string, event: ServerEvent) => void): void {
    this.eventSink = fn;
  }

  async list(): Promise<{
    activeConnId: string | null;
    connections: ConnectionView[];
  }> {
    const shape = await this.persistence.load();
    return {
      activeConnId: shape.activeConnId,
      connections: shape.connections.map((config) => {
        const entry = this.entries.get(config.id);
        return {
          ...config,
          state: entry?.state ?? "idle",
          e2e: entry?.e2e,
          capabilities: entry?.capabilities ?? [],
        };
      }),
    };
  }

  /** 保存（upsert by id）；配置已变 → 拆既有 transport（下次使用重建自愈） */
  async saveConnection(
    raw: unknown,
  ): Promise<{ activeConnId: string | null; connections: ConnectionView[] }> {
    const config = validateConfig(raw);
    const shape = await this.persistence.load();
    const rest = shape.connections.filter((c) => c.id !== config.id);
    await this.persistence.save({
      connections: [...rest, config],
      activeConnId: shape.activeConnId,
    });
    this.closeEntry(config.id);
    return this.list();
  }

  async deleteConnection(
    id: string,
  ): Promise<{ activeConnId: string | null; connections: ConnectionView[] }> {
    const shape = await this.persistence.load();
    const connections = shape.connections.filter((c) => c.id !== id);
    await this.persistence.save({
      connections,
      activeConnId: shape.activeConnId === id ? null : shape.activeConnId,
    });
    this.closeEntry(id);
    return this.list();
  }

  /** 设为活动连接并立即建链（保存持久化 + 惰性 transport 提前拉起） */
  async activate(id: string): Promise<void> {
    const shape = await this.persistence.load();
    if (!shape.connections.some((c) => c.id === id)) {
      throw new Error(`连接不存在：${id}`);
    }
    await this.persistence.save({
      connections: shape.connections,
      activeConnId: id,
    });
    void this.transportFor(id, shape.connections).catch(() => {
      /* 建链失败由 transport 自身重连兜底；错误在请求路径暴露 */
    });
  }

  /** 连接连通性测试：临时 transport → GET info（direct 立即请求；relay
   * 先等 ws open）；401/4010 → invalid-token（T13 F1 裁定落点） */
  async test(raw: unknown): Promise<TestConnectionResult> {
    let config: ConnectionConfig;
    try {
      config = validateConfig(raw);
    } catch (e) {
      return {
        ok: false,
        reason: "invalid-config",
        message: e instanceof Error ? e.message : String(e),
      };
    }
    const transport = this.transportFactory(config);
    try {
      const info = await this.withTimeout(
        this.requestInfo(transport, config),
        this.testTimeoutMs,
      );
      if (isAuthFailure(info.status, info.body)) {
        return {
          ok: false,
          reason: "invalid-token",
          message: "token 无效（401/4010）",
        };
      }
      const body = info.body as {
        code?: unknown;
        data?: { instanceId?: unknown; capabilities?: unknown };
      } | null;
      const instanceId = body?.data?.instanceId;
      if (body?.code === "2000" && typeof instanceId === "string") {
        return {
          ok: true,
          instanceId,
          capabilities: Array.isArray(body.data?.capabilities)
            ? (body.data.capabilities as string[])
            : [],
        };
      }
      return {
        ok: false,
        reason: "unreachable",
        message: `被控端响应不符合协议（status=${info.status}）`,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        reason: /超时|timeout/i.test(message) ? "timeout" : "unreachable",
        message,
      };
    } finally {
      transport.close();
    }
  }

  /** 请求透传：显式 connId（存在即切为活动连接，粘性）或缺省走活动连接。
   * 粘性切换必须晚于存在性校验：ghost connId 只报错不持久化，否则首个
   * ghost 请求会把 activeConnId 粘死到不存在的连接，缺省路径一并卡死
   * （T15/T16 minor F1 修复） */
  async request(
    connId: string | null,
    method: "GET" | "POST",
    wirePath: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const shape = await this.persistence.load();
    const targetId = connId ?? shape.activeConnId;
    if (!targetId)
      throw new Error("未选择活动连接（server:session* 需 connId 或活动连接）");
    const config = shape.connections.find((c) => c.id === targetId);
    if (!config) throw new Error(`连接不存在：${targetId}`);
    if (connId && connId !== shape.activeConnId) {
      await this.persistence.save({
        connections: shape.connections,
        activeConnId: connId,
      });
    }
    const transport = await this.transportFor(targetId, shape.connections);
    const result = await transport.request(method, wirePath, body);
    if (isAuthFailure(result.status, result.body)) {
      const entry = this.entries.get(targetId);
      if (entry) {
        entry.state = "invalid-token";
        entry.capabilities = [];
      }
      Log.warn("连接 token 失效（invalid-token）", targetId);
    }
    return result;
  }

  /** 供 Supervisor 意外退出等外部事件标记运行态 */
  markConnectionState(id: string, state: ConnectionRuntimeState): void {
    const entry = this.entries.get(id);
    if (entry) entry.state = state;
  }

  /** 拆除全部 transport（应用退出/测试收尾） */
  closeAll(): void {
    for (const id of [...this.entries.keys()]) this.closeEntry(id);
  }

  /** E2E TOFU 指纹回填（spec §2.2）：首连协商确认的指纹写入连接配置持久
   * 化——下次连接即作为 expectedFingerprint 强制校验；已存指纹（匹配
   * 路径同值）不覆盖。失败仅告警（回填非连接功能面，下次协商重试） */
  private async pinFingerprint(id: string, fingerprint: string): Promise<void> {
    try {
      const shape = await this.persistence.load();
      const config = shape.connections.find((c) => c.id === id);
      if (!config || config.fingerprint) return;
      config.fingerprint = fingerprint;
      await this.persistence.save(shape);
      Log.info("relay e2e TOFU 指纹已回填连接配置", id, fingerprint);
    } catch (e) {
      Log.warn("relay e2e 指纹回填失败", e);
    }
  }

  private closeEntry(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    try {
      entry.transport.close();
    } catch (e) {
      Log.warn("transport 关闭异常（已忽略）", e);
    }
  }

  /** 惰性建链（幂等）：wire onState（invalid-token 粘滞仅 connected 可清）
   * + onEvent（server.connected 就地消化为状态/能力，同时下发 eventSink——
   * spec §13 项 2 重连全量刷新：渲染层经 server:event:<connId> 订阅后
   * refetch 会话列表，消断流期间漏事件导致的无限卡流式态） */
  private async transportFor(
    id: string,
    connections: ConnectionConfig[],
  ): Promise<Transport> {
    const existing = this.entries.get(id);
    if (existing) return existing.transport;
    const config = connections.find((c) => c.id === id);
    if (!config) throw new Error(`连接不存在：${id}`);
    const transport = this.transportFactory(config);
    const entry: TransportEntry = {
      transport,
      state: mapTransportState(transport.state),
      e2e: transport.e2eState,
      capabilities: [],
    };
    this.entries.set(id, entry);
    transport.onState((state) => {
      if (entry.state === "invalid-token" && state !== "connected") return;
      entry.state = mapTransportState(state);
    });
    // E2E 状态上报渲染层（徽标数据）；TOFU 首连指纹回填持久化（下次强制）
    transport.onE2eState((change: E2eStatusChange) => {
      entry.e2e = change.state;
      if (change.state === "encrypted" && change.fingerprint) {
        void this.pinFingerprint(id, change.fingerprint);
      }
    });
    transport.onEvent((event) => {
      if (event.type === "server.connected") {
        entry.state = "connected";
        entry.capabilities = event.payload.capabilities;
        // 不 return：连接态就地更新后继续下发 sink（§13 项 2）
      }
      this.eventSink?.(id, event);
    });
    if (config.mode === "relay" && transport.state !== "connected") {
      await this.waitForConnected(transport);
    }
    return transport;
  }

  /** relay 首请求兜底：等 ws open（connected）或超窗放行（由 request 自身
   * 10s 超时兜错——direct 无需等待，fetch 与 SSE 独立） */
  private waitForConnected(transport: Transport): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve();
      }, RELAY_READY_TIMEOUT_MS);
      const off = transport.onState((state) => {
        if (state === "connected" || state === "closed") {
          clearTimeout(timer);
          off();
          resolve();
        }
      });
    });
  }

  private async requestInfo(
    transport: Transport,
    config: ConnectionConfig,
  ): Promise<{ status: number; body: unknown }> {
    if (config.mode === "relay") await this.waitForConnected(transport);
    return transport.request("GET", "info");
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`连接测试超时（${timeoutMs}ms）`)),
        timeoutMs,
      );
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }
}

function mapTransportState(state: TransportState): ConnectionRuntimeState {
  // transport 的 closed 仅经本注册表 close() 触发；映射保留语义
  return state === "closed" ? "closed" : state;
}

// —— 本地无头端（Supervisor）装配 ——

let supervisor: ServerSupervisor | null = null;
let lastHandshake: HandshakeInfo | null = null;
let offSupervisorExit: (() => void) | null = null;

/** 本地无头端产物入口（T1/T8 实测裁定：dist/src/main.js，非 dist/main.js） */
export function localServerEntry(projectDir: string): string {
  return path.join(projectDir, "dist", "src", "main.js");
}

/** 本地无头端 spawn 命令（仅 dev 态：node 跑兄弟仓产物） */
export interface LocalServerCommand {
  command: string;
  args: string[];
  cwd: string;
}

/** 解析本地无头端 spawn 命令：node 跑兄弟仓产物（projectDir 用户指位）。
 * 产物缺失给可读指引（引导 server 仓 build）。打包态安装包不内嵌无头端
 * （2026-10-27 拆除内嵌裁定），由 startLocalServer 前置守卫拦截 */
export function resolveLocalServerCommand(
  projectDir: string,
): LocalServerCommand {
  const entry = localServerEntry(projectDir);
  if (!fs.existsSync(entry)) {
    throw new Error(
      `无头端产物不存在：${entry}（请先在 tianshu-server 仓执行 npm run build）`,
    );
  }
  return { command: "node", args: [entry], cwd: projectDir };
}

export interface LocalServerStatus {
  running: boolean;
  state: "stopped" | "starting" | "running" | "error";
  port: number | null;
  instanceId: string | null;
}

/** 启动本地无头端并落一条 local 连接（upsert + 激活）。仅 dev 态可用：
 * node 跑兄弟仓产物；打包态安装包不内嵌无头端（2026-10-27 拆除内嵌
 * 裁定）——前置守卫拒绝并指引独立部署 */
export async function startLocalServer(
  registry: ConnectionRegistry,
  projectDir: string,
): Promise<{ port: number; token: string; instanceId: string }> {
  if (app.isPackaged) {
    throw new Error(
      "打包版不内置本地无头端——请独立部署 tianshu-server 后添加远程连接，或在开发模式下使用",
    );
  }
  if (!projectDir || typeof projectDir !== "string") {
    throw new Error("localStart 需要 tianshu-server 项目目录");
  }
  const resolved = resolveLocalServerCommand(projectDir);
  if (supervisor?.state === "running" || supervisor?.state === "starting") {
    await supervisor.stop();
  }
  supervisor = new ServerSupervisor();
  const token = randomBytes(24).toString("hex");
  const env: Record<string, string> = { TIANSHU_TOKEN: token };
  const info = await supervisor.start({
    command: resolved.command,
    args: resolved.args,
    cwd: resolved.cwd,
    env,
  });
  lastHandshake = info;
  offSupervisorExit?.();
  offSupervisorExit = supervisor.onExit((exit) => {
    if (!exit.expected) {
      registry.markConnectionState(LOCAL_CONNECTION_ID, "closed");
      lastHandshake = null;
    }
  });
  await registry.saveConnection({
    id: LOCAL_CONNECTION_ID,
    name: "本地无头端",
    mode: "direct",
    baseUrl: `http://127.0.0.1:${info.port}`,
    token: info.token,
    local: true,
  });
  await registry.activate(LOCAL_CONNECTION_ID);
  Log.info(
    "本地无头端已启动",
    `port=${info.port} instanceId=${info.instanceId}`,
  );
  return { port: info.port, token: info.token, instanceId: info.instanceId };
}

export async function stopLocalServer(
  registry: ConnectionRegistry,
): Promise<void> {
  offSupervisorExit?.();
  offSupervisorExit = null;
  if (supervisor) {
    await supervisor.stop();
    supervisor = null;
  }
  lastHandshake = null;
  registry.markConnectionState(LOCAL_CONNECTION_ID, "closed");
}

export function localServerStatus(): LocalServerStatus {
  return {
    running: supervisor?.state === "running",
    state: supervisor?.state ?? "stopped",
    port: lastHandshake?.port ?? null,
    instanceId: lastHandshake?.instanceId ?? null,
  };
}

/** 全局注册表单例（Application 装配与 IPC 层共用；测试用独立实例注入） */
export const serverConnections = new ConnectionRegistry();

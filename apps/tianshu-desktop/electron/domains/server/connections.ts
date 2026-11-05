// 控制端连接注册表（T16）：ConnectionConfig CRUD（option 表持久化——
// type="app" name="serverConnections" JSON {connections,activeConnId}）+
// 每连接 Transport 惰性建链（direct=fetch+SSE / relay=ws role=client，
// T13/T14 产物零改动复用）+ invalid-token 判别（T13/T14 契约注记：请求
// 401 / body.code==='4010' → 连接态 invalid-token，与 lost/断线区分——
// 配置纠正后 save 重建 transport 自愈）+ 本地无头端启停（Supervisor，
// spawn 解析 resolveLocalServerCommand——dev=<dir>/dist/src/main.js 真
// node；打包态不内嵌，startLocalServer 前置拒绝）。
// relay AK 凭证（T17 多租户）：连接配置增 adminUrl/akId/akSecret（与
// relayToken 并存 static 优先）；建连前 relay-ak.resolveRelayAccessToken
// 短连接换发（首帧 auth token=换发 access）；401/无存量+换新失败 →
// invalid-token 粘滞（复用既有凭证失效呈现面）。建链收口自此 async——
// 换发 await 窗口内配置被 save/delete 顶替（epoch 前移）即放弃迟到结果
// （T15 fix-round 顶替竞态教训）。
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
import {
  akTriplePresent,
  clearRelayAccess,
  resolveRelayAccessToken,
} from "./relay-ak";
import { openSecretFields, sealSecretFields } from "../security/option-secrets";
import type { ServerEvent } from "./protocol";
import {
  TransportBase,
  type TransportRequestResult,
  type E2eStatusChange,
  type Transport,
  type TransportE2eState,
  type TransportState,
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
  /** 被控端 E2E 指纹（hex16；TOFU 首连经用户确认卡钉扎——P0-1 仪式。
   * 仅 relay 模式） */
  fingerprint?: string;
  /** 指纹确认时间（ISO；P0-1 TOFU 仪式）：用户确认卡或手工录入指纹时
   * 写入；缺省 = 未确认。存量已钉扎连接经 load 迁移视为已确认 */
  confirmedAt?: string;
  /** 连接级 E2E 模式（仅 relay；缺省 auto。required=握手无 ack 拒降级直接
   * 断开——spec §2.4 控制端配置级开关，E2E-T4/T3 审查；无 off：不建 relay
   * 连接即得等价语义） */
  e2eMode?: RelayE2eMode;
  /** relay AK 凭证三要素（多租户 T17）：与 relayToken 并存时 static 优先
   *  （在场零 AK 请求）；建连前经 relay-ak 换发短效 access 作首帧 auth */
  adminUrl?: string;
  akId?: string;
  akSecret?: string;
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
 * 会话加密徽标数据；direct 恒 unsupported、idle 无值——UI 按 mode 门控）
 * + 协议版本（批3B：server.connected 上报，控制端低于 PROTOCOL_VERSION
 * 给「建议升级」）
 * + 协商指纹（P0-1：当前连接实际核对到的被控端指纹——pending-confirm
 *   确认卡与 mitm-suspect 期望 vs 实际对照的数据源；idle 无值） */
export interface ConnectionView extends ConnectionConfig {
  state: ConnectionRuntimeState;
  e2e?: TransportE2eState;
  capabilities: string[];
  protocolVersion?: number;
  e2eFingerprint?: string;
}

export interface PersistedShape {
  connections: ConnectionConfig[];
  activeConnId: string | null;
}

export type TestConnectionResult =
  | {
      ok: true;
      instanceId: string;
      capabilities: string[];
      /** 协议版本（批3B）：/info 透传；缺省 = 老被控端未上报（不告警） */
      protocolVersion?: number;
    }
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
  /** 协议版本（批3B）：server.connected 上报；undefined=老被控端 */
  protocolVersion?: number;
  /** 当前协商指纹（P0-1）：transport onE2eState 上报值（自算）——
   * pending-confirm 待确认 / mitm-suspect 实际值的显示数据源 */
  e2eFingerprint?: string;
  /** AK 凭证失效占位标记（T17）：invalid-ak=粘滞（重配经 save 自愈）；
   * unavailable=瞬态（下次请求/激活重建自愈） */
  akFailure?: "invalid-ak" | "unavailable";
}

/**
 * 存量已钉扎指纹连接的确认迁移（P0-1 TOFU 仪式）：旧版 TOFU 自动回填的
 * 指纹行无 confirmedAt——升级后按「已确认」对待（避免全员弹待确认卡）。
 * option 表 JSON 无行级 createdAt 可取，以迁移首见时刻代替（仅显示口径：
 * 功能面以「指纹在场即强制校验」判定，不依赖该时间戳）。幂等：仅在
 * fingerprint 在场而 confirmedAt 缺席时补写。
 */
function backfillConfirmedAt(
  connections: ConnectionConfig[],
): ConnectionConfig[] {
  const confirmedAt = new Date().toISOString();
  return connections.map((config) =>
    config.mode === "relay" && config.fingerprint && !config.confirmedAt
      ? { ...config, confirmedAt }
      : config,
  );
}

/** option 表持久化（server-face 配置同款 findFirst + update/create） */
export function createOptionPersistence(): ConnectionPersistence {
  return {
    async load(): Promise<PersistedShape> {
      const row = await prisma.option.findFirst({
        where: { type: OPTION_TYPE, name: OPTION_NAME },
      });
      if (!row) return { connections: [], activeConnId: null };
      // 安全批 D1：token 字段透明解封（旧明文原样）
      const shape = parsePersisted(row.value);
      return {
        // P0-1 迁移：存量已回填指纹连接视为已确认（补 confirmedAt）
        connections: backfillConfirmedAt(
          await Promise.all(
            shape.connections.map((c) => openSecretFields("connections", c)),
          ),
        ),
        activeConnId: shape.activeConnId,
      };
    },
    async save(shape: PersistedShape): Promise<void> {
      // 安全批 D1：token 字段密封落表（单表 dump 不再得全权凭证）
      const sealed = {
        ...shape,
        connections: await Promise.all(
          shape.connections.map((c) => sealSecretFields("connections", c)),
        ),
      };
      const value = JSON.stringify(sealed);
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
    if (typeof candidate.relayUrl !== "string" || !candidate.relayUrl) {
      throw new Error("中继模式缺少 relayUrl");
    }
    if (!/^wss?:\/\//.test(candidate.relayUrl)) {
      throw new Error("中继模式 relayUrl 必须是 ws(s):// 地址");
    }
    // 安全批 B7：公网明文 ws:// 拒绝——relay 全凭证（relayToken/
    // connectionId）走 upgrade URL query，公网明文链路被动嗅探即得
    // 全权凭证（被控端对 req 自动注入 TIANSHU_TOKEN Bearer）。仅放行
    // loopback/localhost 与私网字面 IP 的 ws://（家庭内网 relay）；域名
    // 与公网形态要求 wss://（错误信息指明改法）
    if (candidate.relayUrl.startsWith("ws://")) {
      let host = "";
      try {
        host = new URL(candidate.relayUrl).hostname.toLowerCase();
      } catch {
        /* 下方判定兜底 */
      }
      const isPrivateLiteral =
        host === "localhost" ||
        host.endsWith(".localhost") ||
        /^127\./.test(host) ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host);
      if (!isPrivateLiteral) {
        throw new Error(
          "公网/域名地址必须使用 wss://（明文 ws:// 的凭证可被链路嗅探）；内网 relay 请用 IP 直连或部署 TLS",
        );
      }
    }
    config.relayUrl = candidate.relayUrl;
    // 凭证面（T17 多租户）：static relayToken 或 AK 三要素二选一——
    // static 在场即短路（零 AK 请求，AK 字段仅透传不校验完整性）
    const hasStaticToken =
      typeof candidate.relayToken === "string" && candidate.relayToken !== "";
    const akFields = ["adminUrl", "akId", "akSecret"] as const;
    const akPresentCount = akFields.filter(
      (field) =>
        typeof candidate[field] === "string" && candidate[field] !== "",
    ).length;
    if (!hasStaticToken) {
      if (akPresentCount === 0) {
        throw new Error(
          "中继模式缺少 relayToken 或 AK 凭证（adminUrl/akId/akSecret 三要素）",
        );
      }
      if (akPresentCount < 3) {
        throw new Error("AK 凭证需 adminUrl/akId/akSecret 三要素齐备");
      }
      if (!/^https?:\/\//.test(candidate.adminUrl!)) {
        throw new Error("AK 管理端地址必须是 http(s):// 地址");
      }
    }
    if (hasStaticToken) config.relayToken = candidate.relayToken;
    for (const field of akFields) {
      const value = candidate[field];
      if (typeof value === "string" && value.trim()) {
        config[field] = value.trim();
      }
    }
    if (typeof candidate.connectionId !== "string" || !candidate.connectionId) {
      throw new Error("中继模式缺少 connectionId");
    }
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

/** AK 凭证失效占位 transport（T17）：无凭证不裸连 relay（鉴权语义），
 * request 一律抛失效错误；注册表以 invalid-token 粘滞态呈现（复用既有
 * 凭证失效呈现面），save 重建自愈；unavailable（瞬态）由下次请求重建
 * 自愈、invalid-ak 仅显式激活/保存重试 */
class StaleRelayCredentialTransport extends TransportBase {
  constructor(private readonly failureMessage: string) {
    super();
    this.setState("closed");
  }

  async request(
    _method: "GET" | "POST",
    _path: string,
    _body?: unknown,
  ): Promise<TransportRequestResult> {
    throw new Error(this.failureMessage);
  }

  close(): void {
    /* 占位无资源 */
  }
}

export class ConnectionRegistry {
  private readonly persistence: ConnectionPersistence;
  private readonly transportFactory: TransportFactory;
  private readonly testTimeoutMs: number;
  private readonly entries = new Map<string, TransportEntry>();
  /** 建连在途任务（T17：AK 换发使建链 async——同 id 并发请求单飞合流） */
  private readonly creating = new Map<string, Promise<Transport>>();
  /** 连接配置世代（T17：save/delete/closeAll 顶替在望建连——迟到结果不落地） */
  private readonly entryEpochs = new Map<string, number>();
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
          protocolVersion: entry?.protocolVersion,
          e2eFingerprint: entry?.e2eFingerprint,
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
    // 安全批 S2：新建 relay 连接（此前无同 id 行）e2e 缺省 required——auto
    // 的 2s 握手超时静默降级可被恶意 relay 单方面触发（扣发握手帧）；
    // 存量连接保持原值不动（旧无 e2e 被控端兼容由用户显式改 auto）；
    // direct 连接无 e2e 面，不注入
    if (
      config.mode === "relay" &&
      config.e2eMode === undefined &&
      !shape.connections.some((c) => c.id === config.id)
    ) {
      config.e2eMode = "required";
    }
    // 指纹确认时间（P0-1 TOFU 仪式）：服务端计算不信任上行——指纹未动
    // 保留存量确认时刻；手工录入/更换指纹 = 用户带外核对行为（记 now）；
    // 清空指纹（TOFU 重来）连带清除（validateConfig 全量重建已天然丢弃）
    if (config.mode === "relay" && config.fingerprint) {
      const existing = shape.connections.find((c) => c.id === config.id);
      config.confirmedAt =
        existing?.fingerprint === config.fingerprint && existing?.confirmedAt
          ? existing.confirmedAt
          : new Date().toISOString();
    }
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
    // AK 存量 access 随连接清除（不留孤儿凭证——重建后重新换发）
    clearRelayAccess(id);
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
    // AK 失效占位（T17）：显式激活即重试换发（用户动作，一次 admin 请求
    // 可接受——区别于请求路径 invalid-ak 粘滞不自动重试）
    const existing = this.entries.get(id);
    if (existing?.akFailure) this.closeEntry(id);
    void this.transportFor(id, shape.connections).catch(() => {
      /* 建链失败由 transport 自身重连兜底；错误在请求路径暴露 */
    });
  }

  /** 连接连通性测试：临时 transport → GET info（direct 立即请求；relay
   * 先等 ws open）；401/4010 → invalid-token（T13 F1 裁定落点）；AK 模式
   * 同换新（401 → invalid-token；无可用凭证 → unreachable，T16 同口径） */
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
    const credential = await this.resolveRelayCredential(config);
    if (!credential.ok) {
      return {
        ok: false,
        reason: credential.reason === "invalid-ak" ? "invalid-token" : "unreachable",
        message: credential.message,
      };
    }
    const transport = this.transportFactory(
      credential.relayToken
        ? { ...config, relayToken: credential.relayToken }
        : config,
    );
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
        data?: {
          instanceId?: unknown;
          capabilities?: unknown;
          protocolVersion?: unknown;
        };
      } | null;
      const instanceId = body?.data?.instanceId;
      if (body?.code === "2000" && typeof instanceId === "string") {
        return {
          ok: true,
          instanceId,
          capabilities: Array.isArray(body.data?.capabilities)
            ? (body.data.capabilities as string[])
            : [],
          // 协议版本（批3B）：/info 透传（老被控端缺省不告警）
          ...(typeof body.data?.protocolVersion === "number"
            ? { protocolVersion: body.data.protocolVersion }
            : {}),
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

  /** TOFU 指纹用户确认仪式（P0-1，spec §2.2 + design/security §6 P0-1）：
   * 把当前协商指纹（transport onE2eState 上报的自算值）钉扎进连接配置
   * + confirmedAt 落档持久化；随即重建 transport——新握手携
   * expectedFingerprint 强制校验（其后不匹配即 mitm-suspect，不再重连）。
   * 守卫：非 relay 拒绝；未协商出指纹（从未建链）拒绝；已钉扎幂等返回 */
  async confirmFingerprint(
    id: string,
  ): Promise<{ activeConnId: string | null; connections: ConnectionView[] }> {
    const shape = await this.persistence.load();
    const config = shape.connections.find((c) => c.id === id);
    if (!config) throw new Error(`连接不存在：${id}`);
    if (config.mode !== "relay") {
      throw new Error("仅中继连接需要指纹确认（direct 无 E2E 面）");
    }
    if (config.fingerprint) return this.list(); // 已钉扎：幂等（含迁移行）
    const negotiated = this.entries.get(id)?.e2eFingerprint;
    if (!negotiated) {
      throw new Error("连接尚未协商出指纹（请先建立连接）");
    }
    const connections = shape.connections.map((c) =>
      c.id === id
        ? { ...c, fingerprint: negotiated, confirmedAt: new Date().toISOString() }
        : c,
    );
    await this.persistence.save({
      connections,
      activeConnId: shape.activeConnId,
    });
    Log.info("relay e2e TOFU 指纹经用户确认，已钉扎连接配置", id, negotiated);
    // 重建 transport：换携 expectedFingerprint 的新握手（落 encrypted）；
    // 未激活/闲置连接只拆不拉起（下次使用自然走强制校验路径）
    this.closeEntry(id);
    void this.transportFor(id, connections).catch(() => {
      /* 建链失败由 transport 自身重连兜底；错误在请求路径暴露 */
    });
    return this.list();
  }

  private closeEntry(id: string): void {
    // 世代前移：顶替在期建连（T15 fix-round 教训——AK 换发 await 窗口内
    // save/delete 后，迟到的旧配置建连结果不落地）
    this.entryEpochs.set(id, (this.entryEpochs.get(id) ?? 0) + 1);
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
    if (existing) {
      // AK 失效占位重试语义（T17）：unavailable（瞬态）由下一次请求重建
      // 自愈（admin 恢复后无需人工干预）；invalid-ak 粘滞（请求路径不自动
      // 重试——每请求打 admin 刷 401 无意义，重配经 save/激活自愈）
      if (existing.akFailure !== "unavailable") return existing.transport;
      this.closeEntry(id);
    }
    const inflight = this.creating.get(id);
    if (inflight) return inflight;
    const task = this.buildTransportEntry(id, connections);
    this.creating.set(id, task);
    try {
      return await task;
    } finally {
      this.creating.delete(id);
    }
  }

  /** 建连收口（T17 起异步：AK 凭证换发先行——static relayToken 在场即
   * 短路零 AK 请求；换发失败不裸连，落 invalid-token 占位态）。同 id 并
   * 发经 creating 单飞合流；换发 await 窗口内配置被顶替（epoch 前移）即
   * 放弃迟到结果 */
  private async buildTransportEntry(
    id: string,
    connections: ConnectionConfig[],
  ): Promise<Transport> {
    const config = connections.find((c) => c.id === id);
    if (!config) throw new Error(`连接不存在：${id}`);
    const epochAtStart = this.entryEpochs.get(id) ?? 0;
    const credential = await this.resolveRelayCredential(config);
    // 顶替守卫（T15 fix-round 教训）：换发挂起窗口（≤30s）内 save/delete
    // 顶掉本轮——迟到结果不落地（不装 stale transport、不踩新配置）
    if (epochAtStart !== (this.entryEpochs.get(id) ?? 0)) {
      throw new Error("连接配置已变更，请重试");
    }
    const transport = credential.ok
      ? this.transportFactory(
          credential.relayToken
            ? { ...config, relayToken: credential.relayToken }
            : config,
        )
      : new StaleRelayCredentialTransport(credential.message);
    const entry: TransportEntry = {
      transport,
      state: mapTransportState(transport.state),
      e2e: transport.e2eState,
      capabilities: [],
    };
    if (!credential.ok) {
      entry.state = "invalid-token";
      entry.akFailure = credential.reason;
      Log.warn(
        "relay AK 凭证不可用，连接置 invalid-token（保存/激活重建自愈）",
        id,
        credential.message,
      );
    }
    this.entries.set(id, entry);
    transport.onState((state) => {
      if (entry.state === "invalid-token" && state !== "connected") return;
      entry.state = mapTransportState(state);
    });
    // E2E 状态上报渲染层（徽标数据）+ 协商指纹留档（P0-1 确认卡数据源：
    // pending-confirm 待确认值 / mitm-suspect 实际值）。TOFU **不自动回填**
    // ——用户经确认卡显式 confirmFingerprint 钉扎（安全仪式批拆除自动信任）
    transport.onE2eState((change: E2eStatusChange) => {
      entry.e2e = change.state;
      if (change.fingerprint) entry.e2eFingerprint = change.fingerprint;
    });
    transport.onEvent((event) => {
      if (event.type === "server.connected") {
        entry.state = "connected";
        entry.capabilities = event.payload.capabilities;
        // 协议版本（批3B）：直接覆盖（含 undefined——重连老被控端自愈为
        // 未上报口径，不留陈旧值）
        entry.protocolVersion =
          typeof event.payload.protocolVersion === "number"
            ? event.payload.protocolVersion
            : undefined;
        // 不 return：连接态就地更新后继续下发 sink（§13 项 2）
      }
      this.eventSink?.(id, event);
    });
    if (
      credential.ok &&
      config.mode === "relay" &&
      transport.state !== "connected"
    ) {
      await this.waitForConnected(transport);
    }
    return transport;
  }

  /** relay 凭证收口（T17）：static relayToken 优先（在场即短路——零 AK
   * 请求）；AK 三要素走 relay-ak 建连前换发（401 / 无存量+换新失败 →
   * 失败面，调用方呈 invalid-token 态）；direct 无凭证面直通 */
  private async resolveRelayCredential(
    config: ConnectionConfig,
  ): Promise<
    | { ok: true; relayToken: string }
    | { ok: false; reason: "invalid-ak" | "unavailable"; message: string }
  > {
    if (config.mode !== "relay") return { ok: true, relayToken: "" };
    if (config.relayToken) {
      return { ok: true, relayToken: config.relayToken };
    }
    if (!akTriplePresent(config)) {
      // validateConfig 已收口凭证面；此处防御兜底（不裸连）
      return {
        ok: false,
        reason: "unavailable",
        message: "relay 连接缺少凭证（relayToken 或 AK 三要素）",
      };
    }
    const outcome = await resolveRelayAccessToken(config.id, {
      adminUrl: config.adminUrl!,
      akId: config.akId!,
      akSecret: config.akSecret!,
    });
    return outcome.ok
      ? { ok: true, relayToken: outcome.accessToken }
      : { ok: false, reason: outcome.reason, message: outcome.message };
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
  // 安全批 B3：标记握手行可下发 token（server 侧仅此场景含凭证）
  const env: Record<string, string> = {
    TIANSHU_TOKEN: token,
    TIANSHU_HANDSHAKE_TOKEN: "1",
  };
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

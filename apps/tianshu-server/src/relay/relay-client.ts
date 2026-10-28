import { WebSocket } from 'ws';
import { EventBusService } from 'src/commons/event-bus/event-bus.service';
import { instanceId } from 'src/modules/info/info.controller';
import { CAPABILITIES, type ServerEvent } from '@tianshu/protocol';
import { createWsLiveness, type WsLiveness } from './ws-liveness';
import { PrismaService } from 'src/commons/database/prisma.service';
import {
  E2E_HANDSHAKE_HELLO,
  E2E_SECURE_KIND,
  createE2ESession,
  deriveSessionKeys,
  fingerprintOf,
  generateStaticPair,
  parseStaticPair,
  serializeStaticPair,
  type E2EKeyPair,
  type E2ESecureEnvelope,
  type E2ESession,
} from '@tianshu/core';

/**
 * 无头端 relay 客户端（计划缺口补件，T15/T16 批）：本进程作为被控端
 * （role=server）出站连 relay，register 后经 fastify.inject 把 req 帧
 * 派发到全部既有 Nest 端点（零新路由——直连 HTTP 与 relay 隧道同构，
 * envelope 契约见 mirror relay-protocol.ts：res={id,status,body}，body
 * 含 starter 包装 {code,success,data,message}），EventBus 事件以 event
 * 帧外推（payload JSON 序列化——updatedAt 已在 publish 边界归一为 ISO
 * 字符串（协议包口径），此处原样透传，与 SSE wire 同口径）。
 *
 * - 活性：应用层 ping/pong（mirror ws-liveness 同款语义——控制端 25s
 *   ping 依赖本端回 pong；本端对称发 ping、60s 无入站帧判死重连）
 * - 断线重连：指数退避 1s×2ⁿ 封顶 30s（mirror relay-transport 同曲线）；
 *   重连成功重新 register（同 instanceId 顶掉 relay 侧旧连接）
 * - 鉴权：inject 统一注入 `Authorization: Bearer <TIANSHU_TOKEN>`（未设
 *   则不带——StaticTokenGuard 本地放行）；relay 层接入由 relayToken 把关
 * - 启动入口：main.ts 检测 TIANSHU_RELAY_URL/TIANSHU_RELAY_TOKEN 或 CLI
 *   --relay-url/--relay-token（resolveRelayLaunch）
 * - E2E（spec 2026-10-18-relay-e2e §2.2/§3.2，E2E-T2；mirror server-face
 *   relay-client 同构对偶）：收 e2e-hello（明文）→ 派生会话密钥（静态
 *   私钥+对向临时公钥，connectionId=instanceId 绑定）→ 回 e2e-ack（静态
 *   公钥+指纹）；其后业务帧（req/res/event）一律 e2e-secure 信封承载。
 *   恒明文帧面：register（relay 消费）/ ping/pong（活性不依赖加密态，
 *   pong 按来帧通道回）/ open-close（relay 配对生命周期）。模式三值：
 *   auto 缺省（未握手明文兼容）/ required（拒明文业务帧，断开）/ off
 *   （忽略 hello 完全旧版）；静态身份对持久化 option 表 tianshu.relay/e2eKey
 *   （惰性生成；损坏自愈重生成——指纹随更属轮换语义）。
 */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/** inject 派发 + EventBus 取用所需最小 app 面（NestFastifyApplication 结构
 * 满足；testing module 出来的 INestApplication（FastifyAdapter 实例）运行
 * 时同构——结构化收窄，避免与容器类型的名义摩擦） */
export interface HeadlessRelayApp {
  inject(options: {
    method: 'GET' | 'POST';
    url: string;
    payload?: string;
    headers?: Record<string, string>;
  }): Promise<{ statusCode: number; json(): unknown; body: unknown }>;

  get(token: any): any;
}

/** relay E2E 模式（mirror server-face FaceE2eMode 同构三值） */
export type RelayE2eMode = 'auto' | 'required' | 'off';

/** 静态密钥 option 行（starter option 表；webhook option 持久化先例） */
const E2E_OPTION_TYPE = 'tianshu.relay';
const E2E_OPTION_NAME = 'e2eKey';

/** option 表访问所需最小 prisma 面（PrismaService 结构满足） */
interface OptionStore {
  option: {
    findFirst(args: {
      where: { type: string; name: string };
    }): Promise<{ value: string } | null>;
    upsert(args: {
      where: { type_name: { type: string; name: string } };
      create: { type: string; name: string; value: string };
      update: { value: string };
    }): Promise<unknown>;
  };
}

export interface HeadlessRelayOptions {
  app: HeadlessRelayApp;
  relayUrl: string;
  relayToken: string;
  /** inject 派发注入的 Bearer（缺省 env TIANSHU_TOKEN；未设不带） */
  bearerToken?: string;
  /** E2E 模式（缺省 auto；main.ts 读 config tianshu.relay.e2e） */
  e2eMode?: RelayE2eMode;
  pingIntervalMs?: number;
  deadAfterMs?: number;
}

/** req 帧最少合法形状判别（畸形帧静默丢弃，防打断其他帧处理） */
interface ReqFrame {
  kind: 'req';
  id: number;
  method: string;
  path: string;
  body?: unknown;
}

function isReqFrame(frame: unknown): frame is ReqFrame {
  const candidate = frame as ReqFrame | null;
  return (
    candidate !== null &&
    candidate.kind === 'req' &&
    typeof candidate.id === 'number' &&
    typeof candidate.method === 'string' &&
    typeof candidate.path === 'string'
  );
}

let app: HeadlessRelayApp | null = null;
let bearerToken: string | undefined;
let relayUrl = '';
let relayToken = '';
let pingIntervalMs: number | undefined;
let deadAfterMs: number | undefined;
let socket: WebSocket | null = null;
let liveness: WsLiveness | null = null;
let offBus: (() => void) | null = null;
let stopped = true;
let attempts = 0;
let wsEpoch = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
// E2E 会话态：属当前连接（重连/判死即弃——新连接新协商）；模式启动装载
// （headless 无运行时设置面，config 即终态）
let e2eSession: E2ESession | null = null;
let e2eMode: RelayE2eMode = 'auto';
// 重放 hello 防护（EE 终审 F1）：本连接 epoch 内最近一次受理 hello 的临时
// 公钥。重放字节相同的 hello 会以相同临时钥重派生同密钥+新会话对象（重放
// 窗/前缀钉归零）→ 既往密文 req 可重执行——故相同临时公钥的 hello 直接
// 忽略；合法重协商/新控制端恒新临时钥不受影响。与 e2eSession 同点清
// （重连/判死/停启即弃，属当前连接的协商记忆）。
let lastHelloEphemeral: Buffer | null = null;

/** option 表访问（app 容器解析 PrismaService；缺容器原语时 null 降级） */
function optionStore(): OptionStore | null {
  if (!app) return null;
  try {
    return app.get(PrismaService) as OptionStore;
  } catch {
    return null;
  }
}

/** E2E 静态身份对：缺失/损坏（parseStaticPair 抛错面）即生成并 upsert
 * 持久化（惰性——首个握手方触发）；option 表不可用时每次现生成（无持久
 * 化，指纹逐次变——降级语义，正常装配不会走到） */
async function ensureE2eStaticPair(): Promise<E2EKeyPair> {
  const store = optionStore();
  if (!store) return generateStaticPair();
  const row = await store.option.findFirst({
    where: { type: E2E_OPTION_TYPE, name: E2E_OPTION_NAME },
  });
  if (row) {
    try {
      return parseStaticPair(row.value);
    } catch (error) {
      console.warn(
        '[relay-client] e2eKey 存储损坏，重生成（指纹随更）:',
        error,
      );
    }
  }
  const pair = generateStaticPair();
  await store.option.upsert({
    where: {
      type_name: { type: E2E_OPTION_TYPE, name: E2E_OPTION_NAME },
    },
    create: {
      type: E2E_OPTION_TYPE,
      name: E2E_OPTION_NAME,
      value: serializeStaticPair(pair),
    },
    update: { value: serializeStaticPair(pair) },
  });
  console.log('[relay-client] e2e 静态密钥已生成并持久化');
  return pair;
}

export function isHeadlessRelayConnected(): boolean {
  return socket !== null && socket.readyState === WebSocket.OPEN;
}

/** role=server 握手 URL（connectionId=instanceId，relay 注册键） */
function buildHandshakeUrl(): string {
  const joiner = relayUrl.includes('?') ? '&' : '?';
  return `${relayUrl}${joiner}role=server&token=${encodeURIComponent(relayToken)}&connectionId=${encodeURIComponent(instanceId)}`;
}

function send(target: WebSocket, frame: Record<string, unknown>): void {
  try {
    target.send(JSON.stringify(frame));
  } catch (error) {
    // 对端已死等发送态异常：交给 close 事件走重连
    console.warn('[relay-client] 发送帧失败:', error);
  }
}

/**
 * 业务帧出口（req 应答 res / EventBus event）：会话已建立即密文信封承载；
 * 未建立时 required 模式丢弃（出站同款不降级——密钥未协商，明文发出即
 * 违反 required 语义；事件本有断线窗口丢弃+重连全量刷新兜底），其余模式
 * 明文（auto 降级兼容面）。密封失败（理论态）按协议错断开换新协商；
 * stale 连接（应答跨过重连）直接丢弃。
 */
function sendBusiness(target: WebSocket, frame: Record<string, unknown>): void {
  if (!e2eSession) {
    if (e2eMode === 'required') {
      console.warn(
        '[relay-client] e2e=required 且未握手，丢弃出站业务帧（不降级）',
      );
      return;
    }
    send(target, frame);
    return;
  }
  if (target !== socket) return; // stale epoch 应答：新会话密钥解不了旧连接帧
  try {
    send(target, e2eSession.seal(JSON.stringify(frame)));
  } catch (error) {
    console.error('[relay-client] e2e 密封失败，断开重连:', error);
    forceReconnect('e2e-seal-failed');
  }
}

/** req 帧 → inject 内部派发 → res 帧（既有端点全量复用，零新路由） */
async function answerReq(target: WebSocket, frame: ReqFrame): Promise<void> {
  if (!app) return;
  const method = frame.method === 'GET' ? 'GET' : 'POST';
  try {
    const response = await app.inject({
      method,
      url: `/${frame.path.replace(/^\//, '')}`,
      payload:
        method === 'POST' ? JSON.stringify(frame.body ?? null) : undefined,
      headers: {
        'content-type': 'application/json',
        ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
      },
    });
    sendBusiness(target, {
      kind: 'res',
      id: frame.id,
      status: response.statusCode,
      body: parseResponseBody(response),
    });
  } catch (error) {
    console.error('[relay-client] req 派发异常:', error);
    sendBusiness(target, {
      kind: 'res',
      id: frame.id,
      status: 500,
      body: { code: '5000', success: false, data: null, message: '内部错误' },
    });
  }
}

/** inject 响应体 JSON 化（统一包装拦截器保证 JSON；异常回落原文透传） */
function parseResponseBody(
  response: Awaited<ReturnType<HeadlessRelayApp['inject']>>,
): unknown {
  try {
    return response.json();
  } catch {
    return response.body;
  }
}

/**
 * e2e-hello 处理（spec §2.2 被控端半区）：off 忽略（旧版语义）；否则确保
 * 静态对（惰性生成持久化）→ 派生会话密钥 → 建会话回 ack。新临时公钥的
 * hello（新控制端连接/重协商）直接顶掉旧会话；相同临时公钥的 hello（重放
 * 字节相同——合法重协商恒新临时钥）忽略以保住既有会话重放窗（EE 终审 F1）。
 * 形状非法/派生失败（core 对无效对端公钥抛错）只记日志不拆连接——不污染
 * 既有会话与注册态。
 */
async function handleE2eHello(target: WebSocket, raw: unknown): Promise<void> {
  if (e2eMode === 'off') {
    console.log('[relay-client] e2e 已关闭，忽略 e2e-hello（旧版语义）');
    return;
  }
  const hello = raw as { ephemeralKey?: unknown };
  if (typeof hello.ephemeralKey !== 'string') {
    console.warn('[relay-client] e2e-hello 形状非法（缺 ephemeralKey），忽略');
    return;
  }
  const ephemeralPublicKey = Buffer.from(hello.ephemeralKey, 'base64');
  if (ephemeralPublicKey.length !== 32) {
    console.warn('[relay-client] e2e-hello 临时公钥长度非法，忽略');
    return;
  }
  // 重放 hello 拒绝（EE 终审 F1）：相同临时公钥=重放字节相同的 hello（合法
  // 重协商恒新临时钥）——忽略以保住既有会话的重放窗/前缀钉，既往密文 req
  // 在原会话内必被重放拒
  if (lastHelloEphemeral?.equals(ephemeralPublicKey)) {
    console.warn(
      '[relay-client] e2e-hello 临时公钥与本连接既有会话重复（疑似重放），忽略',
    );
    return;
  }
  let staticPair: E2EKeyPair;
  try {
    staticPair = await ensureE2eStaticPair();
  } catch (error) {
    console.error('[relay-client] e2e 静态密钥装载失败，本次握手放弃:', error);
    return;
  }
  try {
    e2eSession = createE2ESession(
      deriveSessionKeys({
        ephemeralPublicKey,
        staticPrivateKey: staticPair.privateKey,
        connectionId: instanceId,
      }),
      'server',
    );
  } catch (error) {
    console.warn(
      '[relay-client] e2e 会话派生失败（无效对端公钥），忽略:',
      error,
    );
    return;
  }
  lastHelloEphemeral = ephemeralPublicKey;
  const fingerprint = fingerprintOf(staticPair.publicKey);
  send(target, {
    kind: 'e2e-ack',
    staticKey: staticPair.publicKey.toString('base64'),
    fingerprint,
  });
  console.log(`[relay-client] e2e 会话已建立 ${fingerprint}`);
}

/** 解封后内层业务帧分发（sealed=true 时 ping 以密文回密文 pong） */
function dispatchInnerFrame(inner: unknown, sealed: boolean): void {
  const frame = inner as { kind?: unknown };
  if (frame.kind === 'req' && isReqFrame(inner)) {
    if (!socket) return;
    void answerReq(socket, inner);
    return;
  }
  if (frame.kind === 'ping') {
    if (!socket) return;
    if (sealed) sendBusiness(socket, { kind: 'pong' });
    else send(socket, { kind: 'pong' });
    return;
  }
  // open/close=控制端配对生命周期（relay 已处理）；pong=对自身 ping 的应答
}

/** e2e-secure 信封入站：未握手即收/解封失败（认证失败/重放拒/nonce 异常）
 * 均为协议错——断开重连换新协商（T1 报告消费提示口径） */
function handleSecureEnvelope(envelope: E2ESecureEnvelope): void {
  if (!e2eSession) {
    console.warn('[relay-client] 未握手即收 e2e-secure 帧，断开重连');
    forceReconnect('e2e-secure-without-session');
    return;
  }
  let inner: unknown;
  try {
    inner = JSON.parse(e2eSession.open(envelope).toString('utf8'));
  } catch (error) {
    console.warn('[relay-client] e2e 信封解封失败，断开重连:', error);
    forceReconnect('e2e-open-failed');
    return;
  }
  dispatchInnerFrame(inner, true);
}

function onFrame(target: WebSocket, raw: unknown): void {
  liveness?.noteInbound();
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeRaw(raw));
  } catch {
    return; // 坏帧静默丢弃（relay parseFrame 同口径）
  }
  const frame = parsed as { kind?: unknown };
  if (frame.kind === E2E_HANDSHAKE_HELLO) {
    void handleE2eHello(target, parsed).catch((error) => {
      // 异步兜底：hello 路径任何漏网异常不得变成未处理 rejection
      // （防御性对齐 mirror 92be12b——当前内部全 try 实际不可达）
      console.error('[relay-client] e2e hello 处理异常:', error);
    });
    return;
  }
  if (frame.kind === E2E_SECURE_KIND) {
    handleSecureEnvelope(parsed as E2ESecureEnvelope);
    return;
  }
  if (frame.kind === 'req' && isReqFrame(parsed)) {
    // 明文业务帧门禁：会话已建立（混合通道注入）或 required 模式（拒降级）
    // 一律断开；auto 未握手放行（旧控制端兼容面，spec §2.4）
    if (e2eSession) {
      console.warn(
        '[relay-client] e2e 会话已建立仍收明文 req 帧（疑似注入/降级），断开重连',
      );
      forceReconnect('e2e-plaintext-after-session');
      return;
    }
    if (e2eMode === 'required') {
      console.warn(
        '[relay-client] e2e=required，拒明文业务帧（不降级），断开重连',
      );
      forceReconnect('e2e-required');
      return;
    }
    dispatchInnerFrame(parsed, false);
    return;
  }
  dispatchInnerFrame(parsed, false);
}

/** RawData 三形态归一 utf8 文本（relay-main decodeRaw 同口径） */
function decodeRaw(raw: unknown): string {
  if (Array.isArray(raw))
    return Buffer.concat(raw as Buffer[]).toString('utf8');
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return String(raw);
}

function scheduleReconnect(): void {
  if (stopped || reconnectTimer) return;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempts, RECONNECT_MAX_MS);
  attempts = Math.min(attempts + 1, 6);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectOnce().catch(() => {
      /* 失败路径由 close 事件再排下一轮重连 */
    });
  }, delay);
  console.log(`[relay-client] 将在 ${delay}ms 后重连`);
}

/** 单次连接：resolve=已 open（含 register 已发）；reject=本次失败
 * （重连由 close 事件统一调度，避免双重排程） */
function connectOnce(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const epoch = ++wsEpoch;
    let settled = false;
    let opened = false;
    const ws = new WebSocket(buildHandshakeUrl());
    ws.on('open', () => {
      if (stopped) {
        ws.close(1000, 'client-stop');
        if (!settled) {
          settled = true;
          resolve();
        }
        return;
      }
      opened = true;
      socket = ws;
      attempts = 0;
      e2eSession = null; // 新连接新协商（旧会话密钥不跨连接）
      lastHelloEphemeral = null;
      send(ws, {
        kind: 'register',
        instanceId,
        capabilities: [...CAPABILITIES],
        name: 'tianshu-server',
      });
      startLiveness(ws);
      console.log(`[relay-client] 已连接并注册 ${relayUrl}`);
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    ws.on('message', (raw) => onFrame(ws, raw));
    ws.on('close', () => {
      // 旧 epoch 的 close（判死已处置/被新连接顶掉）：不再排程
      if (epoch !== wsEpoch) return;
      if (socket === ws) socket = null;
      e2eSession = null; // 连接终结即弃会话（重连后重新握手）
      lastHelloEphemeral = null;
      liveness?.stop();
      liveness = null;
      if (opened) {
        console.warn('[relay-client] 连接断开，进入重连退避');
        scheduleReconnect();
      } else if (!settled) {
        settled = true;
        // 首连失败也进重连循环（relay 未起/网络未通，后续恢复自愈）
        scheduleReconnect();
        reject(new Error('relay 首连失败'));
      }
    });
    ws.on('error', () => {
      /* ws 语义：error 后必发 close，收口在 close 分支 */
    });
  });
}

function startLiveness(target: WebSocket): void {
  liveness?.stop();
  liveness = createWsLiveness({
    sendPing: () => {
      if (socket === target && socket.readyState === WebSocket.OPEN) {
        send(target, { kind: 'ping' });
      }
    },
    onDead: () => forceReconnect('无入站帧超窗'),
    pingIntervalMs,
    deadAfterMs,
  });
  liveness.start();
}

/** 活性判死处置：拆当前连接立即进重连退避（epoch 前移使旧 socket 的
 * close 事件失效——close 在死链上可能迟到数秒） */
function forceReconnect(reason: string): void {
  if (stopped) return;
  console.warn('[relay-client] 判死重连:', reason);
  const dead = socket;
  wsEpoch += 1;
  socket = null;
  e2eSession = null;
  lastHelloEphemeral = null;
  liveness?.stop();
  liveness = null;
  try {
    dead?.close();
  } catch {
    /* 已在关闭流程 */
  }
  scheduleReconnect();
}

/** 启动 relay 客户端（幂等：重启先拆旧连接与订阅） */
export async function startHeadlessRelay(
  options: HeadlessRelayOptions,
): Promise<void> {
  stopHeadlessRelay();
  if (!options.relayUrl || !options.relayToken) {
    throw new Error('relay 客户端启动需 relayUrl 与 relayToken');
  }
  app = options.app;
  relayUrl = options.relayUrl;
  relayToken = options.relayToken;
  bearerToken = options.bearerToken ?? process.env.TIANSHU_TOKEN ?? undefined;
  e2eMode = options.e2eMode ?? 'auto';
  pingIntervalMs = options.pingIntervalMs;
  deadAfterMs = options.deadAfterMs;
  stopped = false;
  attempts = 0;
  e2eSession = null;
  lastHelloEphemeral = null;
  // 事件外推：仅当前已连接时发（断线窗口丢弃，控制端重连后全量刷新兜底）
  const bus = options.app.get(EventBusService) as EventBusService;
  offBus = bus.subscribe((event: ServerEvent) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      sendBusiness(socket, {
        kind: 'event',
        type: event.type,
        payload: event.payload,
      });
    }
  });
  await connectOnce();
}

export function stopHeadlessRelay(): void {
  stopped = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  e2eSession = null;
  lastHelloEphemeral = null;
  liveness?.stop();
  liveness = null;
  offBus?.();
  offBus = null;
  if (socket) {
    const current = socket;
    socket = null;
    try {
      current.close(1000, 'client-stop');
    } catch {
      /* 已在关闭流程 */
    }
  }
}

/** relay 模式信号收口所需最小 app 面（NestFastifyApplication 结构满足） */
export interface RelayShutdownApp {
  close(): Promise<void>;
}

/** relay 模式信号收口（main.ts SIGINT/SIGTERM）：停 relay 客户端 → 关闭
 * HTTP 应用 → 退出进程。只调 stopHeadlessRelay 不够——fastify 监听与
 * Nest 生命周期未动，首个 Ctrl-C 后进程仍存活（T15/T16 minor F2） */
export async function stopRelayAndExit(app: RelayShutdownApp): Promise<void> {
  stopHeadlessRelay();
  try {
    await app.close();
  } catch (error) {
    console.error('[relay-client] 应用关闭异常:', error);
  }
  process.exit(0);
}

/** CLI/环境驱动解析（main.ts 调用）：CLI 优先于环境变量；两者齐备才启动
 * （缺任一返回 null——relay 接入必须鉴权，不半启动） */
export function resolveRelayLaunch(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): { relayUrl: string; relayToken: string } | null {
  const cli = parseRelayCliArgs(argv);
  const relayUrl = cli.relayUrl ?? env.TIANSHU_RELAY_URL ?? '';
  const relayToken = cli.relayToken ?? env.TIANSHU_RELAY_TOKEN ?? '';
  if (!relayUrl || !relayToken) return null;
  return { relayUrl, relayToken };
}

/** `--k v` 与 `--k=v` 双形式（relay-main parseCliArgs 同口径） */
function parseRelayCliArgs(argv: string[]): {
  relayUrl?: string;
  relayToken?: string;
} {
  const parsed: { relayUrl?: string; relayToken?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const equalIndex = arg.indexOf('=');
    const name = equalIndex === -1 ? arg : arg.slice(0, equalIndex);
    const next = i + 1 < argv.length ? argv[i + 1] : undefined;
    const value = equalIndex === -1 ? next : arg.slice(equalIndex + 1);
    if (value === undefined) continue;
    if (equalIndex === -1) i += 1;
    if (name === '--relay-url') parsed.relayUrl = value;
    else if (name === '--relay-token') parsed.relayToken = value;
  }
  return parsed;
}

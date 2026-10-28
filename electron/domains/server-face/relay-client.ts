// 被控面 relay 客户端（server-face spec §6.2 / T12）：出站 WS role=server
// 连 relay（NAT 友好——被控端无公网监听）。连上即发 register 元数据帧；
// req 帧经 handleRoute 回 res 帧（envelope 契约见 relay-protocol.ts——与
// 直连 HTTP 同构）；face 事件总线驱动 event 帧（仅当前已连接时发送，
// 断线窗口事件丢弃，控制端重连后全量刷新当前会话兜底）。
// 重连：断线指数退避 1s 起上限 30s；重连成功重新 register（同 instanceId
// 顶掉 relay 侧旧连接——F1 修复承诺成立，重注册不丢配对）。
// 活性（T14 补 T11/T12 遗留 F1）：undici 全局 WebSocket 无协议层 ping →
// 应用层 {kind:'ping'} 定时发（25s）、收 ping 回 pong；60s 无任何入站帧
// 判死强制重连（ws-liveness.ts，判死口径见其头注释）。
// E2E（spec 2026-10-18-relay-e2e §2.2/§3.2，E2E-T2）：role=server 收
// e2e-hello（明文，relay 照转发）→ 派生会话密钥（静态私钥+对向临时公钥，
// connectionId=instanceId 绑定）→ 回 e2e-ack（静态公钥+指纹，控制端
// expectedFingerprint 校验在此生效）；其后业务帧（req/res/event）一律
// e2e-secure 信封承载（seal/open 见 @tianshu/core e2e-crypto）。
// **恒明文帧面**：register（relay 消费注册）、ping/pong（活性不依赖加密
// 态——pong 按来帧通道回）、open/close（relay 配对生命周期，relay 侧消费
// 生成）。降级语义（§2.4）：auto 缺省（未握手明文兼容旧控制端）；required
// 拒明文业务帧（断开）；off 忽略 hello（完全旧版）。
// WS 实现用 Node 22+/Electron 44 主进程全局 WebSocket（undici 客户端，
// 零新增运行时依赖）；测试侧模拟 relay 用 ws 库（devDependencies）。
import Log from "../../commons/Log";
import { handleRoute } from "./routes";
import { ensureTapBridge, onFaceEvent } from "./face-events";
import { FACE_CAPABILITIES, FACE_INSTANCE_ID, FACE_NAME } from "./face-info";
import { isReqFrame, type RelayFrame, type WireFrame } from "./relay-protocol";
import { createWsLiveness, type WsLiveness } from "./ws-liveness";
import { readServerFaceConfig, type FaceE2eMode } from "./server-face";
import { ensureE2eStaticPair } from "./e2e-keys";
import {
  E2E_HANDSHAKE_HELLO,
  E2E_SECURE_KIND,
  createE2ESession,
  deriveSessionKeys,
  fingerprintOf,
  type E2ESecureEnvelope,
  type E2ESession,
} from "@tianshu/core";

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

let socket: WebSocket | null = null;
let relayUrl = "";
let relayToken = "";
let stopped = true;
let attempts = 0;
let wsEpoch = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let liveness: WsLiveness | null = null;
let offFaceEvents: (() => void) | null = null;
// E2E 会话态：属当前连接（重连/判死即弃——新连接新协商）；模式缓存随
// startRelayClient 装载 + 每次握手实时读（设置面改模式无需重启即生效）
let e2eSession: E2ESession | null = null;
let e2eMode: FaceE2eMode = "auto";
// 重放 hello 防护（EE 终审 F1）：本连接 epoch 内最近一次受理 hello 的临时
// 公钥。重放字节相同的 hello 会以相同临时钥重派生同密钥+新会话对象（重放
// 窗/前缀钉归零）→ 既往密文 req 可重执行——故相同临时公钥的 hello 直接
// 忽略；合法重协商/新控制端恒新临时钥不受影响。与 e2eSession 同点清（重连
// /判死/停启即弃，属当前连接的协商记忆）。
let lastHelloEphemeral: Buffer | null = null;

export function isRelayConnected(): boolean {
  return socket !== null && socket.readyState === WebSocket.OPEN;
}

/** 当前连接是否已建立 E2E 会话（设置面状态点；明文承载时 false） */
export function isE2eActive(): boolean {
  return e2eSession !== null && isRelayConnected();
}

/** role=server 握手 URL（connectionId=instanceId，relay 注册键） */
function buildHandshakeUrl(url: string, token: string): string {
  const joiner = url.includes("?") ? "&" : "?";
  return `${url}${joiner}role=server&token=${encodeURIComponent(token)}&connectionId=${encodeURIComponent(FACE_INSTANCE_ID)}`;
}

function sendFrame(target: WebSocket, frame: WireFrame): void {
  try {
    target.send(JSON.stringify(frame));
  } catch (e) {
    // 对端已死等发送态异常：交给 close 事件走重连，这里只记日志
    Log.warn("relay 客户端发送帧失败", e);
  }
}

/**
 * 业务帧出口（req 应答 res / face 事件 event）：会话已建立即密文信封
 * 承载；未建立时 required 模式丢弃（出站同款不降级——密钥未协商，明文
 * 发出即违反 required 语义；事件本有断线窗口丢弃+重连全量刷新兜底），
 * 其余模式明文（auto 降级兼容面）。密封失败（计数器耗尽等理论态）按
 * 协议错断开重连换新协商；stale 连接（应答跨过重连）直接丢弃。
 */
function sendBusinessFrame(target: WebSocket, frame: RelayFrame): void {
  if (!e2eSession) {
    if (e2eMode === "required") {
      Log.warn("relay e2e=required 且未握手，丢弃出站业务帧（不降级）");
      return;
    }
    sendFrame(target, frame);
    return;
  }
  if (target !== socket) return; // stale epoch 应答：新会话密钥解不了旧连接帧
  try {
    sendFrame(target, e2eSession.seal(JSON.stringify(frame)));
  } catch (e) {
    Log.error("relay 客户端 e2e 密封失败，断开重连", e);
    forceReconnect("e2e-seal-failed");
  }
}

/** req 帧 → 路由表 → res 帧（handleRoute 自兜底业务错；此处兜意外异常） */
async function answerReq(
  target: WebSocket,
  id: number,
  method: string,
  path: string,
  body: unknown,
): Promise<void> {
  try {
    const result = await handleRoute(
      method === "GET" ? "GET" : "POST",
      path,
      body,
    );
    sendBusinessFrame(target, {
      kind: "res",
      id,
      status: result.status,
      body: result.body,
    });
  } catch (e) {
    Log.error("relay 客户端处理 req 帧异常", e);
    sendBusinessFrame(target, {
      kind: "res",
      id,
      status: 500,
      body: {
        code: "5000",
        success: false,
        data: null,
        message: "内部错误",
      },
    });
  }
}

/**
 * e2e-hello 处理（§2.2 被控端半区）：off 忽略（旧版语义）；否则确保静态
 * 对（惰性生成持久化）→ 派生会话密钥（connectionId=instanceId 绑定）→
 * 建会话回 ack。新临时公钥的 hello（新控制端连接/重协商）直接顶掉旧会话；
 * 相同临时公钥的 hello（重放字节相同——合法重协商恒新临时钥）忽略以保住
 * 既有会话重放窗（EE 终审 F1）。形状非法/模式读取失败/派生失败（core 对
 * 无效对端公钥抛错）只记日志不拆连接——「hello 处理永不拆连接」不变量，
 * 且不污染既有会话与注册态，合法 hello 仍可随后建立。
 */
async function handleE2eHello(raw: unknown): Promise<void> {
  const target = socket;
  if (!target) return;
  // 模式实时读：设置面切换 required/off 无需重启 relay 客户端即生效。
  // 读取失败只放弃本次 hello（记日志）——「hello 处理永不拆连接」不变量
  try {
    e2eMode = (await readServerFaceConfig()).e2e ?? "auto";
  } catch (e) {
    Log.error("relay e2e 模式读取失败，忽略本次 hello", e);
    return;
  }
  if (e2eMode === "off") {
    Log.info("relay e2e 已关闭，忽略 e2e-hello（旧版语义）");
    return;
  }
  const hello = raw as { ephemeralKey?: unknown };
  if (typeof hello.ephemeralKey !== "string") {
    Log.warn("e2e-hello 形状非法（缺 ephemeralKey），忽略");
    return;
  }
  const ephemeralPublicKey = Buffer.from(hello.ephemeralKey, "base64");
  if (ephemeralPublicKey.length !== 32) {
    Log.warn("e2e-hello 临时公钥长度非法，忽略");
    return;
  }
  // 重放 hello 拒绝（EE 终审 F1）：相同临时公钥=重放字节相同的 hello（合法
  // 重协商恒新临时钥）——忽略以保住既有会话的重放窗/前缀钉，既往密文 req
  // 在原会话内必被重放拒
  if (lastHelloEphemeral?.equals(ephemeralPublicKey)) {
    Log.warn("e2e-hello 临时公钥与本连接既有会话重复（疑似重放），忽略");
    return;
  }
  let staticPair;
  try {
    staticPair = await ensureE2eStaticPair();
  } catch (e) {
    Log.error("relay e2e 静态密钥装载失败，本次握手放弃", e);
    return;
  }
  let session: E2ESession;
  try {
    session = createE2ESession(
      deriveSessionKeys({
        ephemeralPublicKey,
        staticPrivateKey: staticPair.privateKey,
        connectionId: FACE_INSTANCE_ID,
      }),
      "server",
    );
  } catch (e) {
    Log.warn("relay e2e 会话派生失败（无效对端公钥），忽略", e);
    return;
  }
  e2eSession = session;
  lastHelloEphemeral = ephemeralPublicKey;
  const fingerprint = fingerprintOf(staticPair.publicKey);
  sendFrame(target, {
    kind: "e2e-ack",
    staticKey: staticPair.publicKey.toString("base64"),
    fingerprint,
  });
  Log.info("relay e2e 会话已建立", fingerprint);
}

/** 解封后内层业务帧分发（sealed=true 时 ping 以密文回密文 pong） */
function dispatchInnerFrame(inner: unknown, sealed: boolean): void {
  const frame = inner as { kind?: unknown };
  if (frame.kind === "req" && isReqFrame(inner)) {
    if (!socket) return;
    void answerReq(socket, inner.id, inner.method, inner.path, inner.body);
    return;
  }
  if (frame.kind === "ping") {
    if (!socket) return;
    if (sealed) {
      sendBusinessFrame(socket, { kind: "pong" });
    } else {
      sendFrame(socket, { kind: "pong" });
    }
    return;
  }
  // open/close 为控制端配对生命周期通知（relay 已处理转发配对，本端无需
  // 动作）；pong 为控制端对自身 ping 的应答（活性已记，无需处理）
}

/** e2e-secure 信封入站：未握手即收/解封失败（认证失败/重放拒/nonce 异常）
 * 均为协议错——断开重连换新协商（T1 报告消费提示口径） */
function handleSecureEnvelope(envelope: E2ESecureEnvelope): void {
  if (!e2eSession) {
    Log.warn("未握手即收 e2e-secure 帧，断开重连");
    forceReconnect("e2e-secure-without-session");
    return;
  }
  let inner: unknown;
  try {
    inner = JSON.parse(e2eSession.open(envelope).toString("utf8"));
  } catch (e) {
    Log.warn("relay e2e 信封解封失败，断开重连", e);
    forceReconnect("e2e-open-failed");
    return;
  }
  dispatchInnerFrame(inner, true);
}

function onFrame(raw: unknown): void {
  if (typeof raw !== "string" || !socket) return;
  liveness?.noteInbound();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return; // 坏帧静默丢弃（relay 侧 parseFrame 同口径）
  }
  const frame = parsed as { kind?: unknown };
  if (frame.kind === E2E_HANDSHAKE_HELLO) {
    handleE2eHello(parsed).catch((e) =>
      // 异步兜底：hello 路径任何漏网异常不得变成未处理 rejection
      Log.error("relay e2e hello 处理异常", e),
    );
    return;
  }
  if (frame.kind === E2E_SECURE_KIND) {
    handleSecureEnvelope(parsed as E2ESecureEnvelope);
    return;
  }
  if (frame.kind === "req" && isReqFrame(parsed)) {
    // 明文业务帧门禁：会话已建立（混合通道注入）或 required 模式（拒降级）
    // 一律断开；auto 未握手放行（旧控制端兼容面，§2.4）
    if (e2eSession) {
      Log.warn("e2e 会话已建立仍收明文 req 帧（疑似注入/降级），断开重连");
      forceReconnect("e2e-plaintext-after-session");
      return;
    }
    if (e2eMode === "required") {
      Log.warn("relay e2e=required，拒明文业务帧（不降级），断开重连");
      forceReconnect("e2e-required");
      return;
    }
    dispatchInnerFrame(parsed, false);
    return;
  }
  dispatchInnerFrame(parsed, false);
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
  Log.info("relay 客户端将在", `${delay}ms 后重连`);
}

/** 单次连接：resolve=已 open（含 register 已发）；reject=本次失败（重连
 * 由 close 事件统一调度，避免双重排程） */
function connectOnce(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const epoch = ++wsEpoch;
    let settled = false;
    let opened = false;
    const ws = new WebSocket(buildHandshakeUrl(relayUrl, relayToken));
    ws.addEventListener("open", () => {
      if (stopped) {
        ws.close(1000, "client-stop");
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
      sendFrame(ws, {
        kind: "register",
        instanceId: FACE_INSTANCE_ID,
        capabilities: [...FACE_CAPABILITIES],
        name: FACE_NAME,
      });
      startLiveness(ws);
      Log.info("relay 客户端已连接并注册", relayUrl);
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    ws.addEventListener("message", (event) => onFrame(event.data));
    ws.addEventListener("close", () => {
      // 旧 epoch 的 close（活性判死已处置/已被新连接顶掉）：不再排程
      if (epoch !== wsEpoch) return;
      if (socket === ws) socket = null;
      e2eSession = null; // 连接终结即弃会话（重连后重新握手）
      lastHelloEphemeral = null;
      liveness?.stop();
      liveness = null;
      if (opened) {
        // 已连上后断开：事件订阅保留（重连即恢复推送），排重连
        Log.warn("relay 连接断开，进入重连退避");
        scheduleReconnect();
      } else if (!settled) {
        settled = true;
        // 首连失败也要进重连循环（relay 尚未起/网络未通，后续恢复可自愈）
        scheduleReconnect();
        reject(new Error("relay 首连失败"));
      }
    });
    ws.addEventListener("error", () => {
      /* undici 语义：error 后必发 close，收口在 close 分支 */
    });
  });
}

/** 起本连接的活性计时（先清旧的——重连换连接即换 ping 通道） */
function startLiveness(target: WebSocket): void {
  liveness?.stop();
  liveness = createWsLiveness({
    sendPing: () => {
      if (socket === target && socket.readyState === WebSocket.OPEN) {
        sendFrame(target, { kind: "ping" });
      }
    },
    onDead: () => forceReconnect("无入站帧超窗"),
  });
  liveness.start();
}

/** 活性判死处置：拆当前连接立即进重连退避。epoch 前移使旧 socket 的
 * close 事件失效（close 在死链上可能迟到数秒，不能等它驱动重连） */
function forceReconnect(reason: string): void {
  if (stopped) return;
  Log.warn("relay 客户端判死重连", reason);
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

/** 启动 relay 客户端（幂等：重启换目标先拆旧连接与订阅） */
export async function startRelayClient(
  url: string,
  token: string,
): Promise<void> {
  stopRelayClient();
  if (!url || !token) {
    throw new Error("relay 客户端启动需 url 与 token");
  }
  relayUrl = url;
  relayToken = token;
  stopped = false;
  attempts = 0;
  e2eSession = null;
  lastHelloEphemeral = null;
  // 模式随启动装载（握手时再实时读刷新——设置面改模式即生效）
  e2eMode = (await readServerFaceConfig()).e2e ?? "auto";
  ensureTapBridge();
  offFaceEvents = onFaceEvent((event) => {
    // 仅当前已连接时发事件帧：断线窗口丢弃（控制端重连后全量刷新兜底）
    if (socket && socket.readyState === WebSocket.OPEN) {
      sendBusinessFrame(socket, {
        kind: "event",
        type: event.type,
        payload: event.payload,
      });
    }
  });
  await connectOnce();
}

export function stopRelayClient(): void {
  stopped = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  e2eSession = null;
  lastHelloEphemeral = null;
  liveness?.stop();
  liveness = null;
  offFaceEvents?.();
  offFaceEvents = null;
  if (socket) {
    const current = socket;
    socket = null;
    try {
      current.close(1000, "client-stop");
    } catch {
      /* 已在关闭流程中 */
    }
  }
}

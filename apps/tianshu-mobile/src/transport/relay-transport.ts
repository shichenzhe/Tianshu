// relay WS 隧道控制端传输层（T8）：语义蓝本 mirror
// electron/domains/server/relay-transport.ts——open 配对/req-res id 配对/
// 应用层 ping/退避重连；RN 内置全局 WebSocket，零新增运行时依赖。
// 与 brief（task-8-brief.md 代码主体）的差异共 6 处，均经 relay 服务端
// 实现核验（tianshu-server/src/relay/relay-main.ts）后修正，逐条备案于
// task-8-report.md：
// 1. open 配对移到 onopen——relay 对成功 open 不回发任何帧（attachClient
//    后静默；被控端忽略 open 帧），按「首个入站帧」配对对健康空闲目标
//    永久死锁（永远到不了 connected/不发 info/不启活性）；
// 2. event 帧重组——wire 形态 {kind:'event',type,payload}（两被控端
//    mirror server-face / tianshu-server relay-client 同构），帧级 type
//    才是 ServerEvent.type，直接 emit frame.payload 会丢 type；
// 3. 重连单飞 reconnectTimer——relay 发 close 帧后必关 ws（not-found
//    4004 / server-gone 4003），close 帧分支与 onclose 双触发
//    scheduleReconnect 会双定时器双连接（mirror 蓝本同款守卫）；
// 4. invalid-token（4001）分支补 failPending + liveness 清理（T7 教训：
//    定时器清理完备性；interval 残留会对死 socket 持续 send 抛错）；
// 5. close() 补 reconnectTimer 清理（T7 教训；虽 connect 有 closed 守卫
//    不致状态倒退，残跑 timer 不干净）；
// 6. send try/catch——RN/browsers 语义 send 于 CONNECTING 态抛
//    InvalidStateError，且会在 request 的 Promise executor 内同步抛出；
//    挂起 req 由 10s 超时兜底（status 0 不可达语义），连接由 onclose 兜底。
// 7. socket epoch 守卫（T8 审查裁定）：connect 重建 ws 后，旧 socket 的
//    迟到 onmessage/onclose 直接忽略（ws !== socket），防旧连接回调在新
//    连接上重排状态机/重连；顺带删除恒真的 paired 旗标残迹。
import {
  ENDPOINTS,
  E2E_HANDSHAKE_ACK,
  E2E_SECURE_KIND,
  type AuthFrame,
  type E2eAckFrame,
  type E2eHelloFrame,
  type E2ESecureEnvelope,
  type RelayFrame,
  type ServerEvent,
} from "@tianshu/protocol";
import { nextBackoffMs } from "./backoff";
import {
  b64ToBytes,
  bytesToB64,
  createE2ESession,
  deriveSessionKeys,
  fingerprintOf,
  generateEphemeralPair,
  type E2ESession,
} from "./e2e-crypto";
import { Emitter, type Transport, type TransportRequestResult, type TransportState } from "./types";

export interface RelayConfig {
  relayUrl: string;
  relayToken: string;
  /** 目标被控端 instanceId（带外获取：桌面端关于页/无头端 handshake 日志） */
  connectionId: string;
  /** 连接级 E2E 模式（安全批 H）：auto（缺省）=握手无 ack 降级明文；
   *  required=拒降级直接断开（required-failed 终局，不再重连） */
  e2eMode?: "auto" | "required";
  /** 已存被控端指纹（TOFU 首连空缺省；ack 不匹配即断——mitm-suspect） */
  fingerprint?: string;
  /** e2e 握手等 ack 超时窗（超时降级明文；测试注入缩短） */
  e2eHandshakeTimeoutMs?: number;
  /** TOFU 指纹上报（encrypted 落定且 config 未带指纹时调用——注册表回填） */
  onFingerprintPinned?: (fingerprint: string) => void;
}

const REQ_TIMEOUT_MS = 10_000;
/** e2e 握手等 ack 超时窗（与桌面蓝本一致：2s） */
const DEFAULT_E2E_HANDSHAKE_TIMEOUT_MS = 2_000;

export function createRelayTransport(config: RelayConfig): Transport {
  const events = new Emitter<ServerEvent>();
  const states = new Emitter<TransportState>();
  let state: TransportState = "idle";
  let closed = false;
  /** 终局旗标（mitm-suspect/required-failed）：粘滞不重连（重连只会复现同一终局） */
  let terminal = false;
  let attempt = 0;
  let ws: WebSocket | null = null;
  let nextId = 1;
  let lastInboundAt = 0;
  let livenessTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // —— e2e 会话态（安全批 H；蓝本桌面 relay-transport）——
  /** 当前连接的加密会话（重连/判死/mitm 即弃——新连接新协商） */
  let e2eSession: E2ESession | null = null;
  /** 在途握手的临时私钥（ack 到达派生用；会话建立/连接终结即弃） */
  let ephemeralPrivate: Uint8Array | null = null;
  let e2eHandshakeTimer: ReturnType<typeof setTimeout> | null = null;
  /** 握手落定门闩：request 先等落定再发——明文 req 不得撞进对端已建会话 */
  let e2eSettled: Promise<void> = Promise.resolve();
  let settleE2e: (() => void) | null = null;
  const pending = new Map<
    number,
    { resolve: (r: TransportRequestResult) => void; timer: ReturnType<typeof setTimeout> }
  >();

  const setState = (s: TransportState) => {
    state = s;
    states.emit(s);
  };
  const send = (
    frame: RelayFrame | AuthFrame | E2eHelloFrame | E2ESecureEnvelope,
  ) => {
    try {
      ws?.send(JSON.stringify(frame));
    } catch {
      /* 半死/未开 socket：挂起 req 由 10s 超时兜底，连接由 onclose 兜底重连 */
    }
  };
  /** 业务帧出站：会话已建立即封信封（req 走此路；res/event 为入站向） */
  const sendBusinessFrame = (frame: RelayFrame) => {
    if (e2eSession) {
      send(e2eSession.seal(JSON.stringify(frame)));
      return;
    }
    send(frame);
  };
  const failPending = () => {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.resolve({ status: 0, body: null });
    }
    pending.clear();
  };

  /** 握手收口：清计时器+放行等待者（等待者由 ws 态/终局兜错） */
  function settleE2eHandshake(): void {
    if (e2eHandshakeTimer) {
      clearTimeout(e2eHandshakeTimer);
      e2eHandshakeTimer = null;
    }
    ephemeralPrivate = null;
    settleE2e?.();
    settleE2e = null;
  }

  /**
   * E2E 握手发起（安全批 H；蓝本桌面 §2.2 控制端半区）：open 配对后即发
   * hello（临时公钥+已存指纹），e2eHandshakeTimeoutMs 内无 ack：
   * auto → 降级（重发一次 open 帧明文承载——旧版被控端兼容；对端
   * required 拒明文则隧道即断，按连接失败如实呈现）；required → 不降级
   * 直接断开（堵中继攻击者恒强制降级的缺口）。晚到 ack 丢弃（超时回调
   * 已清 ephemeralPrivate）。
   */
  function beginE2eHandshake(socket: WebSocket): void {
    e2eSettled = new Promise<void>((resolve) => {
      settleE2e = resolve;
    });
    const ephemeral = generateEphemeralPair();
    ephemeralPrivate = ephemeral.privateKey;
    const hello: E2eHelloFrame = {
      kind: "e2e-hello",
      ephemeralKey: bytesToB64(ephemeral.publicKey),
    };
    if (config.fingerprint) {
      hello.expectedFingerprint = config.fingerprint;
    }
    send(hello);
    e2eHandshakeTimer = setTimeout(() => {
      e2eHandshakeTimer = null;
      if (closed || terminal || ws !== socket) return;
      if ((config.e2eMode ?? "auto") === "required") {
        settleE2eHandshake();
        setState("required-failed");
        terminalAbort();
        return;
      }
      // 降级明文：重发 open（对端若已建会话会拒明文断链，重连换新协商自愈）
      send({ kind: "open", connectionId: config.connectionId });
      settleE2eHandshake();
    }, config.e2eHandshakeTimeoutMs ?? DEFAULT_E2E_HANDSHAKE_TIMEOUT_MS);
  }

  /** 终局拆链（mitm-suspect/required-failed 共用）：断开且不再重连 */
  function terminalAbort(): void {
    terminal = true;
    failPending();
    if (livenessTimer) clearInterval(livenessTimer);
    livenessTimer = null;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const dead = ws;
    ws = null;
    try {
      dead?.close();
    } catch {
      /* 已在关闭流程 */
    }
  }

  /**
   * e2e-ack 处理：指纹自算 fingerprintOf(staticKey)——不信任 wire 回显；
   * 形状/公钥非法忽略（等超时降级，与被控端对称）。指纹不匹配 →
   * mitm-suspect 终局；匹配 → 派生会话 encrypted（TOFU：config 未带
   * 指纹时上报回填）。
   */
  function handleE2eAck(raw: unknown): void {
    const ack = raw as Partial<E2eAckFrame>;
    if (typeof ack.staticKey !== "string" || typeof ack.fingerprint !== "string") {
      return; // 形状非法忽略（等握手超时降级）
    }
    let fingerprint: string;
    try {
      fingerprint = fingerprintOf(ack.staticKey);
    } catch {
      return; // 公钥非法忽略
    }
    if (config.fingerprint && config.fingerprint !== fingerprint) {
      settleE2eHandshake();
      setState("mitm-suspect");
      terminalAbort();
      return;
    }
    if (!ephemeralPrivate) {
      return; // 无在途握手（重复 ack），忽略
    }
    let session: E2ESession;
    try {
      session = createE2ESession(
        deriveSessionKeys({
          ephemeralPrivateKey: ephemeralPrivate,
          staticPublicKey: b64ToBytes(ack.staticKey),
          connectionId: config.connectionId,
        }),
        "client",
      );
    } catch {
      return; // 派生失败（低阶公钥等）忽略——等握手超时降级
    }
    e2eSession = session;
    settleE2eHandshake();
    setState("encrypted");
    if (!config.fingerprint) {
      config.onFingerprintPinned?.(fingerprint); // TOFU 回填
    }
  }

  /** e2e-secure 信封入站：解封后按内层帧分发；失败/未握手即收 → 断链重连 */
  function handleSecureEnvelope(envelope: E2ESecureEnvelope): void {
    if (!e2eSession) {
      forceReconnect(); // 未握手即收密文帧——协议错
      return;
    }
    let inner: RelayFrame | E2ESecureEnvelope;
    try {
      inner = JSON.parse(
        new TextDecoder().decode(e2eSession.open(envelope)),
      ) as RelayFrame;
    } catch {
      forceReconnect(); // 解封失败（GCM/重放/nonce 异常）——换新协商
      return;
    }
    if (inner.kind === "res") {
      const p = pending.get(inner.id);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(inner.id);
        p.resolve({ status: inner.status, body: inner.body });
      }
    } else if (inner.kind === "event") {
      events.emit({ type: inner.type, payload: inner.payload } as ServerEvent);
    }
    // 内层 close/ping/pong 理论不达（活性帧恒明文）；其余静默忽略
  }

  /** 主动拆链触发重连（注入/协议错收口：新连接新协商） */
  function forceReconnect(): void {
    failPending();
    ws?.close(); // onclose 兜底走 scheduleReconnect
  }

  /** open 帧已发出即配对（relay 对成功 open 静默、无从等回执——mirror
   * 蓝本同款：connected = ws 开 + open 已发；目标不在线由 relay close 帧
   * not-found + ws close 4004 拆回退避重连）后的一次性初始化 */
  function onPaired(socket: WebSocket): void {
    setState("connected");
    attempt = 0;
    beginE2eHandshake(socket);
    void synthConnected();
    if (livenessTimer) clearInterval(livenessTimer);
    livenessTimer = setInterval(() => {
      if (Date.now() - lastInboundAt > 60_000) {
        ws?.close(); // 无入站判死，onclose 兜底走重连
        return;
      }
      send({ kind: "ping" }); // 恒明文（活性不依赖加密态）
    }, 25_000);
  }

  /** relay 无 SSE：连上后自动 GET info 合成 server.connected（协议注记语义） */
  async function synthConnected(): Promise<void> {
    const res = await request("GET", ENDPOINTS.info);
    const body = res.body as {
      data?: { instanceId?: string; capabilities?: string[] };
    } | null;
    if (body?.data?.instanceId) {
      events.emit({
        type: "server.connected",
        payload: {
          instanceId: body.data.instanceId,
          capabilities: body.data.capabilities ?? [],
        },
      });
    }
  }

  function connect(): void {
    if (closed || terminal) return;
    setState(state === "idle" ? "connecting" : "reconnecting");
    lastInboundAt = Date.now();
    e2eSession = null; // 新连接新协商
    // 安全批 I：凭证出 query——鉴权走首帧 auth，URL 只承载路径
    const socket = new WebSocket(config.relayUrl);
    ws = socket;
    socket.onopen = () => {
      // 首帧 auth（凭证承载）→ open（配对）——顺序即协议
      send({ kind: "auth", token: config.relayToken, role: "client" });
      send({ kind: "open", connectionId: config.connectionId });
      onPaired(socket);
    };
    socket.onmessage = (ev) => {
      if (ws !== socket) return; // epoch 守卫：旧 socket 迟到帧不碰新连接
      lastInboundAt = Date.now();
      let frame: RelayFrame | E2eAckFrame | E2ESecureEnvelope;
      try {
        frame = JSON.parse(ev.data as string) as typeof frame;
      } catch {
        return;
      }
      if (frame.kind === "pong") return;
      if (frame.kind === E2E_SECURE_KIND) {
        handleSecureEnvelope(frame as E2ESecureEnvelope);
        return;
      }
      if (frame.kind === E2E_HANDSHAKE_ACK) {
        handleE2eAck(frame);
        return;
      }
      if (frame.kind === "event" || frame.kind === "res") {
        // 对称明文门禁：会话已建立仍收明文业务帧（注入/篡改信道）→ 断开
        // 重连换新协商；ping/pong 不在此列（恒明文放行）
        if (e2eSession) {
          forceReconnect();
          return;
        }
        if (frame.kind === "event") {
          // wire 形态 {kind:'event',type,payload}：帧级 type/payload 重组回
          // ServerEvent（mirror dispatchEventFrame 同款）
          events.emit({ type: frame.type, payload: frame.payload } as ServerEvent);
        } else {
          const p = pending.get(frame.id);
          if (p) {
            clearTimeout(p.timer);
            pending.delete(frame.id);
            p.resolve({ status: frame.status, body: frame.body });
          }
        }
        return;
      }
      if (frame.kind === "ping") {
        send({ kind: "pong" }); // 恒明文（对向按来帧通道回）
        return;
      }
      if (frame.kind === "close") {
        // server-gone/not-found：目标不在线，按断线退避重连
        scheduleReconnect();
      }
    };
    socket.onclose = (ev) => {
      if (ws !== socket) return; // epoch 守卫：旧 socket 迟到 close 不触发重连
      if (closed) return;
      settleE2eHandshake(); // 握手在途：放行等待者（重连后重新协商）
      e2eSession = null;
      if (terminal) return; // mitm/required-failed 终局粘滞：不重连
      if (ev.code === 4001) {
        failPending();
        if (livenessTimer) clearInterval(livenessTimer);
        setState("invalid-token"); // 粘滞：invalid-token 唯一来源 = close code 4001，停止重连
        return;
      }
      scheduleReconnect();
    };
    socket.onerror = () => {
      /* onclose 兜底重连 */
    };
  }

  function scheduleReconnect(): void {
    failPending();
    if (livenessTimer) clearInterval(livenessTimer);
    livenessTimer = null;
    if (closed) return;
    if (reconnectTimer) return; // 单飞：close 帧+onclose 双触发防双定时器双连接
    const delay = nextBackoffMs(attempt++);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  async function request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    options?: { timeoutMs?: number },
  ): Promise<TransportRequestResult> {
    // 握手在途：等落定（加密或降级）再发——明文 req 不得撞进对端已建
    // 会话（信封边界单向成立即拒，蓝本桌面 §2.2 同款门闩）
    await e2eSettled;
    return new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ status: 0, body: null }); // 超时=不可达语义
      }, options?.timeoutMs ?? REQ_TIMEOUT_MS);
      pending.set(id, { resolve, timer });
      sendBusinessFrame({
        kind: "req",
        id,
        method,
        path: path.replace(/^\//, ""),
        ...(body !== undefined ? { body } : {}),
      });
    });
  }

  connect();

  return {
    request,
    onEvent: (cb) => events.on(cb),
    onState: (cb) => states.on(cb),
    close() {
      closed = true;
      settleE2eHandshake(); // 在途握手计时器一并清
      failPending();
      if (livenessTimer) clearInterval(livenessTimer);
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      ws?.close();
      setState("closed");
    },
  };
}

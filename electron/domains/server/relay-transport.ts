// 中继承载（T14）：出站 ws 连 relay（role=client——控制端侧，与被控端
// relay-client.ts 的 role=server 相对），open 帧绑定目标 connectionId 配对。
// - request：封 {kind:'req',id,method,path,body}（envelope 契约——共用常量
//   自 server-face/relay-protocol.ts 导入，与直连 HTTP 同构），res 帧按 id
//   配对，requestTimeoutMs（默认 10s）超时拒绝
// - server.connected 合成：relay register 帧不透传，被控端身份只能经
//   GET info 取——连上后自动请求并合成 {type:'server.connected'}，与
//   DirectTransport 的 SSE 首帧同构（两承载 onEvent 契约一致，T18 上层无感）
// - 断线重连：close 帧（server-gone/not-found）或 ws close → 指数退避
//   1s×2ⁿ 封顶 30s → 重连后重发 open 帧重新配对
// - 活性（T11/T12 遗留 F1 同款问题在此一并解）：undici 全局 WebSocket 无
//   协议层 ping → 应用层 ping/pong（ws-liveness.ts）：25s 发 ping、收 ping
//   回 pong、60s 无任何入站帧判死主动重连（epoch 前移不等死链 close）
// - E2E（spec 2026-10-18-relay-e2e §2.2/§2.4/§3.3，E2E-T3）：ws open 后
//   发 e2e-hello（每连接临时对+已存指纹 expectedFingerprint）→ 等 e2e-ack：
//   指纹匹配（自算 fingerprintOf，不信任 wire 回显）→ deriveSessionKeys
//   （临时私钥+ack 静态公钥，connectionId 绑定）+ createE2ESession(role=
//   client)，其后 req 封信封/res/event 解信封，状态 encrypted；TOFU（无已
//   存指纹）→ 加密 + ack 指纹经 onE2eState 上报（注册表回填连接配置持久化，
//   下次强制）；不匹配 → 断开+mitm-suspect（不再重连——重连只会再次不
//   匹配，用户须核对指纹重配）。握手超时（默认 2s）无 ack → 降级：重试
//   一次原 open 帧+明文承载+状态 plaintext（旧版被控端兼容；对端 required
//   拒明文则隧道即断，按连接失败如实呈现）；连接级 e2eMode=required（默认
//   auto——spec §2.4 控制端配置级开关；无 off：不建 relay 连接即得）时
//   超时**不降级直接断开**（状态 required-failed，不再重连——堵中继攻击
//   者恒强制降级的缺口）。恒明文帧面（与被控端对称）：open/close（relay
//   配对生命周期）、ping/pong（活性不依赖加密态）；会话建立后明文 res/
//   event（混合通道注入）/解封失败 → 断开重连换新协商。
// - WS 实现用 Electron 44 主进程全局 WebSocket（实测可用，零新增运行时依赖）
import Log from "../../commons/Log";
import type {
  E2eHelloFrame,
  RelayFrame,
  WireFrame,
} from "../server-face/relay-protocol";
import { createWsLiveness, type WsLiveness } from "../server-face/ws-liveness";
import type { ServerEvent } from "./protocol";
import { TransportBase, type TransportRequestResult } from "./transport";
import {
  E2E_HANDSHAKE_ACK,
  E2E_SECURE_KIND,
  createE2ESession,
  deriveSessionKeys,
  fingerprintOf,
  generateEphemeralPair,
  type E2ESecureEnvelope,
  type E2ESession,
} from "@tianshu/core";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
/** e2e 握手等 ack 超时窗（超时降级明文，§2.4 兼容期） */
const DEFAULT_E2E_HANDSHAKE_TIMEOUT_MS = 2_000;

/**
 * 连接级 E2E 模式（spec §2.4 控制端配置级开关，E2E-T4/T3 审查）：
 * - auto（默认）：握手无 ack 降级明文（旧版被控端兼容）
 * - required：握手无 ack **不降级直接断开**（required-failed，不再重连）
 *   ——无 off：不建 relay 连接即得等价语义
 */
export type RelayE2eMode = "auto" | "required";

export interface RelayTransportOptions {
  /** relay ws 地址（ws(s)://host:port[/ws]，query 已带则自动续接） */
  relayUrl: string;
  relayToken: string;
  /** 目标被控端 connectionId（relay 注册键 = 被控端 instanceId） */
  connectionId: string;
  /** 已存被控端指纹（TOFU 首连空缺省；ack 不匹配即断——mitm-suspect） */
  fingerprint?: string;
  /** e2e 握手等 ack 超时窗（超时降级明文；测试注入缩短） */
  e2eHandshakeTimeoutMs?: number;
  /** 连接级 E2E 模式（缺省 auto；required=握手无 ack 不降级直接断开） */
  e2eMode?: RelayE2eMode;
  pingIntervalMs?: number;
  deadAfterMs?: number;
  requestTimeoutMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

interface PendingRequest {
  resolve: (result: TransportRequestResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RelayTransport extends TransportBase {
  private readonly wsUrl: string;
  private readonly connectionId: string;
  private readonly expectedFingerprint: string | undefined;
  private readonly e2eHandshakeTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly pingIntervalMs: number | undefined;
  private readonly deadAfterMs: number | undefined;
  private ws: WebSocket | null = null;
  private wsEpoch = 0;
  private attempts = 0;
  private nextRequestId = 1;
  private closedByUser = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private liveness: WsLiveness | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  // E2E 会话态：属当前连接（重连/判死/mitm 即弃——新连接新协商）
  private e2eSession: E2ESession | null = null;
  /** 在途握手的临时私钥（ack 到达派生用；会话建立/连接终结即弃） */
  private ephemeralPrivate: Buffer | null = null;
  private e2eHandshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly e2eMode: RelayE2eMode;
  /** 握手落定门闩：request 先等落定再发——明文 req 不得撞进对端已建会话 */
  private e2eSettled: Promise<void> = Promise.resolve();
  private settleE2e: (() => void) | null = null;

  constructor(options: RelayTransportOptions) {
    super();
    this.wsUrl = buildClientUrl(options.relayUrl, options.relayToken);
    this.connectionId = options.connectionId;
    this.expectedFingerprint = options.fingerprint || undefined;
    this.e2eHandshakeTimeoutMs =
      options.e2eHandshakeTimeoutMs ?? DEFAULT_E2E_HANDSHAKE_TIMEOUT_MS;
    this.e2eMode = options.e2eMode ?? "auto";
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.reconnectBaseMs = options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    this.reconnectMaxMs = options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.pingIntervalMs = options.pingIntervalMs;
    this.deadAfterMs = options.deadAfterMs;
    this.setE2eState("plaintext"); // 建链即未加密（ack 后迁 encrypted；unsupported 留给 direct）
    void this.connect();
  }

  async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<TransportRequestResult> {
    if (this.e2eState === "mitm-suspect") {
      throw new Error(
        "relay e2e 指纹不匹配（疑似中间人），连接已断开——请核对被控端指纹后重配",
      );
    }
    if (this.e2eState === "required-failed") {
      throw new Error(
        "relay e2e=required：被控端未回应端到端握手，已拒绝明文降级并断开",
      );
    }
    if (this.closedByUser) throw new Error("transport 已关闭，拒绝请求");
    // 握手在途：等落定（加密或降级）再发——降级前发明文会撞进对端已建
    // 会话被拒（§2.2 信封边界单向成立即拒明文）
    await this.e2eSettled;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("relay 连接未就绪，拒绝请求");
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise<TransportRequestResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`请求超时（${this.requestTimeoutMs}ms 无 res）`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.sendBusinessFrame(ws, { kind: "req", id, method, path, body });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  close(): void {
    this.closedByUser = true;
    this.wsEpoch += 1;
    this.teardownLiveness();
    this.settleE2eHandshake();
    this.e2eSession = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectAllPending(new Error("transport 已关闭"));
    const dead = this.ws;
    this.ws = null;
    try {
      dead?.close(1000, "client-stop");
    } catch {
      /* 已在关闭流程 */
    }
    this.setState("closed");
  }

  private connect(): void {
    if (this.closedByUser) return;
    const epoch = ++this.wsEpoch;
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    ws.addEventListener("open", () => this.onWsOpen(epoch, ws));
    ws.addEventListener("message", (event) =>
      this.onWsMessage(epoch, ws, event.data),
    );
    ws.addEventListener("close", () => this.onWsClose(epoch));
    ws.addEventListener("error", () => {
      /* undici 语义：error 后必发 close，收口在 close 分支 */
    });
  }

  private onWsOpen(epoch: number, ws: WebSocket): void {
    if (epoch !== this.wsEpoch || this.closedByUser) return;
    this.attempts = 0;
    this.e2eSession = null;
    this.setE2eState("plaintext"); // 握手在途先按未加密（ack 后迁 encrypted）
    this.sendFrame(ws, { kind: "open", connectionId: this.connectionId });
    this.setState("connected");
    this.startLiveness(ws);
    this.beginE2eHandshake(epoch, ws);
    void this.announceConnected();
  }

  /**
   * E2E 握手发起（§2.2 控制端半区）：open 配对后即发 hello（临时公钥+
   * 已存指纹），e2eHandshakeTimeoutMs 内无 ack：auto → 降级（§2.4）重试
   * 一次原 open 帧明文承载；required → 不降级直接断开（required-failed，
   * 不再重连）。晚到 ack 丢弃（超时回调 settleE2eHandshake 已清
   * ephemeralPrivate）——其后降级路径的明文 req 撞进对端已建会话即被拒
   * 断连，重连换新协商自愈。
   */
  private beginE2eHandshake(epoch: number, ws: WebSocket): void {
    this.e2eSettled = new Promise<void>((resolve) => {
      this.settleE2e = resolve;
    });
    const ephemeral = generateEphemeralPair();
    this.ephemeralPrivate = ephemeral.privateKey;
    const hello: E2eHelloFrame = {
      kind: "e2e-hello",
      ephemeralKey: ephemeral.publicKey.toString("base64"),
    };
    if (this.expectedFingerprint) {
      hello.expectedFingerprint = this.expectedFingerprint;
    }
    this.sendFrame(ws, hello);
    this.e2eHandshakeTimer = setTimeout(() => {
      this.e2eHandshakeTimer = null;
      if (epoch !== this.wsEpoch || this.closedByUser) return;
      if (this.e2eMode === "required") {
        Log.error(
          "relay e2e=required 握手无 ack，拒绝明文降级直接断开（§2.4）",
        );
        this.settleE2eHandshake();
        this.setE2eState("required-failed");
        this.terminalAbort(
          "e2e-required",
          new Error(
            "relay e2e=required：被控端未回应端到端握手，已拒绝明文降级并断开",
          ),
        );
        return;
      }
      Log.warn("relay e2e 握手无 ack，降级明文承载（旧版被控端兼容，§2.4）");
      this.sendFrame(ws, { kind: "open", connectionId: this.connectionId });
      this.settleE2eHandshake();
    }, this.e2eHandshakeTimeoutMs);
  }

  /** 握手收口：清计时器+放行等待者（等待者由 readyState/mitm 态兜错） */
  private settleE2eHandshake(): void {
    if (this.e2eHandshakeTimer) {
      clearTimeout(this.e2eHandshakeTimer);
      this.e2eHandshakeTimer = null;
    }
    this.ephemeralPrivate = null;
    this.settleE2e?.();
    this.settleE2e = null;
  }

  /**
   * e2e-ack 处理：指纹三态（§2.2）。指纹自算 fingerprintOf(staticKey)——
   * 不信任 wire 回显；形状非法/公钥非法只告警忽略（等超时降级，与被控端
   * 对 hello 形状非法的处理对称）。派生失败（低阶公钥等）同理忽略。
   */
  private handleE2eAck(epoch: number, raw: unknown): void {
    if (epoch !== this.wsEpoch) return;
    const ack = raw as { staticKey?: unknown; fingerprint?: unknown };
    if (
      typeof ack.staticKey !== "string" ||
      typeof ack.fingerprint !== "string"
    ) {
      Log.warn("e2e-ack 形状非法，忽略（等握手超时降级）");
      return;
    }
    let fingerprint: string;
    try {
      fingerprint = fingerprintOf(ack.staticKey);
    } catch (e) {
      Log.warn("e2e-ack 静态公钥非法，忽略", e);
      return;
    }
    if (this.expectedFingerprint && this.expectedFingerprint !== fingerprint) {
      Log.error(
        "relay e2e 指纹不匹配（疑似中间人），断开",
        `expected=${this.expectedFingerprint} actual=${fingerprint}`,
      );
      this.setE2eState("mitm-suspect", fingerprint);
      this.settleE2eHandshake();
      this.terminalAbort(
        "mitm-suspect",
        new Error("relay e2e 指纹不匹配（疑似中间人），已断开"),
      );
      return;
    }
    if (!this.ephemeralPrivate) {
      Log.warn("e2e-ack 无在途握手（重复 ack），忽略");
      return;
    }
    let session: E2ESession;
    try {
      session = createE2ESession(
        deriveSessionKeys({
          ephemeralPrivateKey: this.ephemeralPrivate,
          staticPublicKey: Buffer.from(ack.staticKey, "base64"),
          connectionId: this.connectionId,
        }),
        "client",
      );
    } catch (e) {
      Log.warn("relay e2e 会话派生失败，忽略（等握手超时降级）", e);
      return;
    }
    this.e2eSession = session;
    this.settleE2eHandshake();
    this.setE2eState("encrypted", fingerprint); // TOFU 回填经 onE2eState 上报
    Log.info("relay e2e 加密会话已建立", fingerprint);
  }

  /** 终局拆链（mitm-suspect / e2e-required 共用）：断开且不再重连（重连
   * 只会复现同一终局——指纹仍不匹配 / 仍无 ack），pending 全部拒绝 */
  private terminalAbort(closeReason: string, pendingError: Error): void {
    this.closedByUser = true;
    this.wsEpoch += 1;
    this.teardownLiveness();
    this.e2eSession = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectAllPending(pendingError);
    const dead = this.ws;
    this.ws = null;
    try {
      dead?.close(1000, closeReason);
    } catch {
      /* 已在关闭流程 */
    }
    this.setState("closed");
  }

  private onWsMessage(epoch: number, ws: WebSocket, raw: unknown): void {
    if (epoch !== this.wsEpoch) return;
    this.liveness?.noteInbound();
    if (typeof raw !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // 坏帧静默丢弃（relay/被控端同口径）
    }
    const frame = parsed as { kind?: unknown };
    if (frame.kind === E2E_SECURE_KIND) {
      this.handleSecureEnvelope(parsed as E2ESecureEnvelope);
      return;
    }
    if (frame.kind === E2E_HANDSHAKE_ACK) {
      this.handleE2eAck(epoch, parsed);
      return;
    }
    if (frame.kind === "res" || frame.kind === "event") {
      // 对称明文门禁（T2 契约）：会话已建立仍收明文业务帧（注入/篡改
      // 信道）→ 断开重连换新协商；ping/pong 不在此列（恒明文放行）
      if (this.e2eSession) {
        Log.warn("e2e 会话已建立仍收明文业务帧（疑似注入），断开重连");
        this.forceReconnect();
        return;
      }
      if (frame.kind === "res") {
        this.settleRequest(
          parsed as { id?: unknown; status?: unknown; body?: unknown },
        );
        return;
      }
      this.dispatchEventFrame(parsed as { type?: unknown; payload?: unknown });
      return;
    }
    if (frame.kind === "ping") {
      this.sendFrame(ws, { kind: "pong" }); // 恒明文（对向按来帧通道回）
      return;
    }
    if (frame.kind === "close") {
      // server-gone/not-found：relay 随即拆本 ws，重连由 close 事件统一调度
      Log.warn(
        "relay 通道关闭通知",
        (parsed as { reason?: unknown }).reason ?? "unknown",
      );
    }
    // open/register/pong：配对元数据与活性应答，无需处理
  }

  /** e2e-secure 信封入站：未握手即收/解封失败（GCM 认证失败/重放拒/
   * nonce 异常）均为协议错——断开重连换新协商（与被控端对称收口） */
  private handleSecureEnvelope(envelope: E2ESecureEnvelope): void {
    if (!this.e2eSession) {
      Log.warn("未握手即收 e2e-secure 帧，断开重连");
      this.forceReconnect();
      return;
    }
    let inner: unknown;
    try {
      inner = JSON.parse(this.e2eSession.open(envelope).toString("utf8"));
    } catch (e) {
      Log.warn("relay e2e 信封解封失败，断开重连", e);
      this.forceReconnect();
      return;
    }
    const frame = inner as { kind?: unknown };
    if (frame.kind === "res") {
      this.settleRequest(
        inner as { id?: unknown; status?: unknown; body?: unknown },
      );
      return;
    }
    if (frame.kind === "event") {
      this.dispatchEventFrame(inner as { type?: unknown; payload?: unknown });
      return;
    }
    // 密文 pong/ping 理论不达（本端 ping 恒明文）；其余内层帧静默忽略
  }

  private onWsClose(epoch: number): void {
    if (epoch !== this.wsEpoch) return; // 判死处置过/被顶掉的旧连接
    this.ws = null;
    this.teardownLiveness();
    this.settleE2eHandshake(); // 握手在途：放行等待者（readyState 兜错）
    this.e2eSession = null;
    this.setE2eState("plaintext"); // 会话随连接终结（重连后重新协商）
    this.rejectAllPending(new Error("relay 连接已断开"));
    this.scheduleReconnect();
  }

  /** 连接级合成事件：连上即 GET info（判 body.code==='2000' 取身份——
   * starter 包装契约，见 transport.ts 头注释）；失败仅告警不致命 */
  private async announceConnected(): Promise<void> {
    try {
      const info = await this.request("GET", "info");
      const body = info.body as {
        code?: unknown;
        data?: { instanceId?: unknown; capabilities?: unknown };
      } | null;
      const instanceId = body?.data?.instanceId;
      if (body?.code === "2000" && typeof instanceId === "string") {
        this.emitEvent({
          type: "server.connected",
          payload: {
            instanceId,
            capabilities: Array.isArray(body.data?.capabilities)
              ? (body.data.capabilities as string[])
              : [],
          },
        });
      }
    } catch (e) {
      Log.warn("relay transport 合成 server.connected 失败", e);
    }
  }

  private settleRequest(frame: {
    id?: unknown;
    status?: unknown;
    body?: unknown;
  }): void {
    if (typeof frame.id !== "number" || typeof frame.status !== "number")
      return;
    const request = this.pending.get(frame.id);
    if (!request) return; // 迟到/未知 id：已超时或非本端请求，静默丢弃
    clearTimeout(request.timer);
    this.pending.delete(frame.id);
    request.resolve({ status: frame.status, body: frame.body });
  }

  private dispatchEventFrame(frame: {
    type?: unknown;
    payload?: unknown;
  }): void {
    if (typeof frame.type !== "string") return;
    this.emitEvent({
      type: frame.type,
      payload: frame.payload,
    } as ServerEvent);
  }

  private startLiveness(ws: WebSocket): void {
    this.teardownLiveness();
    this.liveness = createWsLiveness({
      sendPing: () => this.sendFrame(ws, { kind: "ping" }),
      onDead: () => this.forceReconnect(),
      pingIntervalMs: this.pingIntervalMs,
      deadAfterMs: this.deadAfterMs,
    });
    this.liveness.start();
  }

  private teardownLiveness(): void {
    this.liveness?.stop();
    this.liveness = null;
  }

  /** 活性判死处置：epoch 前移使旧 socket 事件（含迟到的 close）全部失效，
   * 立即进重连退避——不等死链上的 close 握手（可能数秒不达） */
  private forceReconnect(): void {
    if (this.closedByUser) return;
    Log.warn("relay transport 活性/协议错，判死重连");
    const dead = this.ws;
    this.wsEpoch += 1;
    this.ws = null;
    this.teardownLiveness();
    this.settleE2eHandshake();
    this.e2eSession = null;
    this.setE2eState("plaintext");
    this.rejectAllPending(new Error("relay 连接已断开"));
    try {
      dead?.close();
    } catch {
      /* 已在关闭流程 */
    }
    this.scheduleReconnect();
  }

  private rejectAllPending(error: Error): void {
    for (const request of [...this.pending.values()]) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    this.setState("reconnecting");
    if (this.reconnectTimer) return;
    const delay = Math.min(
      this.reconnectBaseMs * 2 ** this.attempts,
      this.reconnectMaxMs,
    );
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    Log.info("relay transport 将在", `${delay}ms 后重连`);
  }

  /** 业务帧出口（req）：会话已建立即密文信封承载，否则明文（降级兼容面）。
   * 密封失败（计数器耗尽等理论态）按协议错断开重连换新协商 */
  private sendBusinessFrame(ws: WebSocket, frame: RelayFrame): void {
    if (!this.e2eSession) {
      this.sendFrame(ws, frame);
      return;
    }
    try {
      this.sendFrame(ws, this.e2eSession.seal(JSON.stringify(frame)));
    } catch (e) {
      Log.error("relay transport e2e 密封失败，断开重连", e);
      this.forceReconnect();
    }
  }

  private sendFrame(target: WebSocket, frame: WireFrame): void {
    try {
      target.send(JSON.stringify(frame));
    } catch (e) {
      Log.warn("relay transport 发送帧失败", e);
    }
  }
}

/** role=client 握手 URL（connectionId 不在 query——经 open 帧绑定目标） */
function buildClientUrl(relayUrl: string, token: string): string {
  const joiner = relayUrl.includes("?") ? "&" : "?";
  return `${relayUrl}${joiner}role=client&token=${encodeURIComponent(token)}`;
}

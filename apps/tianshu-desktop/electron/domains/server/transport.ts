// Transport 抽象（T13，控制端两承载共用）：直连（DirectTransport——fetch+
// SSE）与中继（RelayTransport——ws role=client）实现同一接口，上层（连接
// 注册表/控制台 UI，T16/T18）对承载无感。
// 协议契约（跨仓钉死，T3/T4/T8 契约注记）：
// - request 返回 {status,body}——body 含 starter 包装 {code,success,data,
//   message}；业务错是 HTTP 200 + {code:'4xxx'}，判错查 body.success/code
//   勿只看 status（认证 401 例外：HTTP 401 + code '4010'）
// - path 逻辑路径（"session/query" 或 "/session/query" 前导斜杠归一等价）
// - onState 为推送式状态通知（T13 裁定：优于轮询——变化即回调）
import Log from "../../commons/Log";
import type { ServerEvent } from "./protocol";

export type TransportState =
  "connecting" | "connected" | "reconnecting" | "closed";

/**
 * E2E 承载状态（E2E-T3，spec 2026-10-18-relay-e2e §3.3——仅 relay 承载）：
 * - unsupported：不适用（direct——信任模型内：localhost/上游 TLS 已覆盖）
 * - plaintext：明文中继（握手在途/降级兼容——UI 警示徽标）
 * - encrypted：加密会话已建立（指纹核对通过/TOFU 首连）
 * - mitm-suspect：指纹不匹配断开（UI 红色警示，不再重连）
 * - required-failed：连接级 e2e=required 握手无 ack 拒降级断开（不再重连，
 *   E2E-T4/T3 审查——堵中继攻击者恒强制降级缺口）
 */
export type TransportE2eState =
  | "unsupported"
  | "plaintext"
  | "encrypted"
  | "mitm-suspect"
  | "required-failed";

/** E2E 状态变化通知（fingerprint = 本次协商确认的被控端指纹——TOFU 回填
 * 持久化的数据源，自算不信任 wire 回显） */
export interface E2eStatusChange {
  state: TransportE2eState;
  fingerprint?: string;
}

export interface TransportRequestResult {
  status: number;
  body: unknown;
}

export interface Transport {
  readonly state: TransportState;
  /** E2E 承载状态（direct 恒 unsupported；relay 随握手/降级/断开迁移） */
  readonly e2eState: TransportE2eState;
  request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<TransportRequestResult>;
  /** 订阅协议事件（server.connected/session.updated/message.chunk/session.error）；返回退订函数 */
  onEvent(fn: (event: ServerEvent) => void): () => void;
  /** 订阅状态变化（connecting/connected/reconnecting/closed）；返回退订函数 */
  onState(fn: (state: TransportState) => void): () => void;
  /** 订阅 E2E 状态变化；返回退订函数 */
  onE2eState(fn: (change: E2eStatusChange) => void): () => void;
  close(): void;
}

/** 两承载共用的状态机与订阅扇出（订阅者异常隔离——T2 F1/T10 同款理由） */
export abstract class TransportBase implements Transport {
  private currentState: TransportState = "connecting";
  private currentE2eState: TransportE2eState = "unsupported";
  private readonly eventListeners = new Set<(event: ServerEvent) => void>();
  private readonly stateListeners = new Set<(state: TransportState) => void>();
  private readonly e2eListeners = new Set<(change: E2eStatusChange) => void>();

  get state(): TransportState {
    return this.currentState;
  }

  get e2eState(): TransportE2eState {
    return this.currentE2eState;
  }

  protected setState(next: TransportState): void {
    if (this.currentState === next) return;
    this.currentState = next;
    for (const fn of [...this.stateListeners]) {
      try {
        fn(next);
      } catch (e) {
        Log.warn("transport 状态订阅者抛错（已隔离）", e);
      }
    }
  }

  /** E2E 状态通知（不做去重：fingerprint 载荷随每次协商上报——TOFU 消费方依赖） */
  protected setE2eState(next: TransportE2eState, fingerprint?: string): void {
    this.currentE2eState = next;
    for (const fn of [...this.e2eListeners]) {
      try {
        fn({ state: next, fingerprint });
      } catch (e) {
        Log.warn("transport e2e 状态订阅者抛错（已隔离）", e);
      }
    }
  }

  protected emitEvent(event: ServerEvent): void {
    for (const fn of [...this.eventListeners]) {
      try {
        fn(event);
      } catch (e) {
        Log.warn("transport 事件订阅者抛错（已隔离）", e);
      }
    }
  }

  onEvent(fn: (event: ServerEvent) => void): () => void {
    this.eventListeners.add(fn);
    return () => {
      this.eventListeners.delete(fn);
    };
  }

  onState(fn: (state: TransportState) => void): () => void {
    this.stateListeners.add(fn);
    return () => {
      this.stateListeners.delete(fn);
    };
  }

  onE2eState(fn: (change: E2eStatusChange) => void): () => void {
    this.e2eListeners.add(fn);
    return () => {
      this.e2eListeners.delete(fn);
    };
  }

  abstract request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<TransportRequestResult>;
  abstract close(): void;
}

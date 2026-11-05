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
import type { ConnectionE2eState } from "@tianshu/protocol";

export type TransportState =
  "connecting" | "connected" | "reconnecting" | "closed";

/**
 * E2E 承载状态（E2E-T3，spec 2026-10-18-relay-e2e §3.3——仅 relay 承载）：
 * 值域单源自 @tianshu/protocol ConnectionE2eState（TOFU 确认仪式批收编，
 * 与渲染层同源——pending-confirm = TOFU 首连加密可用但待用户核对）。
 */
export type TransportE2eState = ConnectionE2eState;
export type { ConnectionE2eState };

/** E2E 状态变化通知（fingerprint = 本次协商确认的被控端指纹——TOFU 待
 * 确认指纹与已确认指纹的数据源，自算不信任 wire 回显） */
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

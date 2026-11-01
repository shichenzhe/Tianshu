import type { ServerEvent } from "@tianshu/protocol";

export type TransportState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "invalid-token"
  | "closed";

export interface TransportRequestResult {
  status: number;
  body: unknown;
}

export interface Transport {
  request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    /** 按调用覆写请求超时（缺省 10s relay / 15s direct）——同步 LLM
     *  长操作（如 polish 的 30s 被控端窗口）须放宽，否则提前 abort
     *  假失败 */
    options?: { timeoutMs?: number },
  ): Promise<TransportRequestResult>;
  onEvent(cb: (e: ServerEvent) => void): () => void;
  onState(cb: (s: TransportState) => void): () => void;
  close(): void;
}

/** 事件/状态订阅扇出基座（TransportBase 同构） */
export class Emitter<T> {
  private cbs = new Set<(v: T) => void>();
  on(cb: (v: T) => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
  emit(v: T): void {
    for (const cb of this.cbs) cb(v);
  }
}

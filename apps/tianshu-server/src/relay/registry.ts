import type { WebSocket } from 'ws';

/** 有界缓冲默认值：积压超过该帧数即拆连接（慢消费者防内存膨胀） */
export const DEFAULT_MAX_BUFFER_FRAMES = 200;

/**
 * 中继帧：kind 判别，其余字段透传（relay 不解释业务负载）。
 * req: client→server；res/event: server→client；open/close: 配对生命周期；
 * register: server 首帧元数据（instanceId/capabilities/name），不入转发。
 */
export type RelayFrameKind =
  'open' | 'close' | 'req' | 'res' | 'event' | 'register';

export interface RelayFrame {
  kind: RelayFrameKind;
  connectionId?: string;
  id?: number;
  reason?: string;
  [key: string]: unknown;
}

/** registry 依赖的最小 socket 面（ws.WebSocket 结构满足；单测可注入假 socket） */
export interface PeerSocket {
  send(data: string, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
}

const SEND_FAIL_CODE = 1011;

/** 配对注册表：connectionId → server ws + 已配对 client ws 集合 */
export class RelayRegistry {
  private servers = new Map<string, PeerSocket>();
  private clients = new Map<string, Set<PeerSocket>>();
  private buffered = new Map<PeerSocket, number>();

  constructor(
    private readonly maxBufferFrames: number = DEFAULT_MAX_BUFFER_FRAMES,
  ) {}

  hasServer(connectionId: string): boolean {
    return this.servers.has(connectionId);
  }

  /** 注册被控端；同 id 重复注册视为重连，顶掉旧连接（先占位再关旧，杜绝 close 事件抢跑） */
  registerServer(connectionId: string, ws: PeerSocket): void {
    const previous = this.servers.get(connectionId);
    this.servers.set(connectionId, ws);
    if (previous && previous !== ws) previous.close(4000, 'replaced');
  }

  /** client open 帧触发配对；server 未注册返回 false */
  attachClient(connectionId: string, ws: PeerSocket): boolean {
    if (!this.hasServer(connectionId)) return false;
    const set = this.clients.get(connectionId) ?? new Set<PeerSocket>();
    set.add(ws);
    this.clients.set(connectionId, set);
    return true;
  }

  /** 通知 server：client 已接入（转发其 open 帧） */
  notifyOpen(connectionId: string, frame: RelayFrame): void {
    this.sendTo(this.servers.get(connectionId), frame);
  }

  /** client 断开：摘除配对并通知 server close 帧 */
  notifyClose(connectionId: string, ws: PeerSocket, frame: RelayFrame): void {
    const set = this.clients.get(connectionId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) this.clients.delete(connectionId);
    }
    this.sendTo(this.servers.get(connectionId), frame);
  }

  /** server 断开：仅当该 id 仍持有此连接（未被重注册顶掉）才通知 client 并清理——
   * F1 身份守卫：旧连接被顶掉后其 close 事件不得误拆新注册下的配对 */
  dropServer(connectionId: string, ws: PeerSocket, reason: string): void {
    if (this.servers.get(connectionId) !== ws) return;
    const frame: RelayFrame = { kind: 'close', connectionId, reason };
    for (const client of this.clients.get(connectionId) ?? []) {
      this.sendTo(client, frame);
      client.close(4003, reason);
    }
    this.dropServerOnly(connectionId);
  }

  /** 连接关闭后的簿记清理（缓冲计数等） */
  forget(ws: PeerSocket): void {
    this.buffered.delete(ws);
  }

  forwardToServer(connectionId: string, frame: RelayFrame): void {
    this.sendTo(this.servers.get(connectionId), frame);
  }

  /** res/event 广播至该 server 的全部已配对 client（当前用法单 client） */
  forwardToClients(connectionId: string, frame: RelayFrame): void {
    for (const client of this.clients.get(connectionId) ?? []) {
      this.sendTo(client, frame);
    }
  }

  /** 有界缓冲：发出后挂账、回调确认落盘后递减；积压超限即拆连接。
   * T2 F1：send 同步抛错（对端已死等）拆连接，不让异常扩散成转发死循环 */
  private sendTo(ws: PeerSocket | undefined, frame: RelayFrame): void {
    if (!ws) return;
    const pending = (this.buffered.get(ws) ?? 0) + 1;
    this.buffered.set(ws, pending);
    if (pending > this.maxBufferFrames) {
      ws.close(4002, 'buffer-overflow');
      return;
    }
    try {
      ws.send(JSON.stringify(frame), (err) => {
        if (err) return;
        this.buffered.set(ws, Math.max(0, (this.buffered.get(ws) ?? 1) - 1));
      });
    } catch {
      this.buffered.delete(ws);
      ws.close(SEND_FAIL_CODE, 'send-failed');
    }
  }

  private dropServerOnly(connectionId: string): void {
    this.servers.delete(connectionId);
    this.clients.delete(connectionId);
  }
}

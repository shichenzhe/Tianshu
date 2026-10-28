/**
 * ws 应用层活性（mirror electron/domains/server-face/ws-liveness.ts 同款
 * 移植，协议常量双仓各持副本、改动必须双改）：
 *
 * ws 库虽有协议层 ping/pong，但 relay 隧道透传的是应用层帧——控制端
 * （mirror ws-liveness）以 {kind:'ping'}/{kind:'pong'} 帧做活性，本模块
 * 与之对称：定时发 ping、收任意入站帧刷新活性时钟（比只认 pong 更稳：
 * 事件流繁忙的活链不误杀，静默死链必超窗）；超窗判死回调由调用方执行
 * 重连。pong 应答不在本模块（onFrame 内处理）。
 */
export const DEFAULT_PING_INTERVAL_MS = 25_000;
export const DEFAULT_DEAD_AFTER_MS = 60_000;

export interface WsLivenessOptions {
  /** 发一帧 {kind:'ping'}（发送通道由调用方注入） */
  sendPing: () => void;
  /** 判死回调（本模块已自清计时器；重连由调用方执行） */
  onDead: () => void;
  pingIntervalMs?: number;
  deadAfterMs?: number;
}

export interface WsLiveness {
  /** 任意入站帧到达时调用（刷新活性时钟） */
  noteInbound(): void;
  start(): void;
  stop(): void;
}

export function createWsLiveness(options: WsLivenessOptions): WsLiveness {
  const pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const deadAfterMs = options.deadAfterMs ?? DEFAULT_DEAD_AFTER_MS;
  const checkEveryMs = Math.max(20, Math.floor(deadAfterMs / 5));
  let pingTimer: NodeJS.Timeout | null = null;
  let checkTimer: NodeJS.Timeout | null = null;
  let lastInboundAt = 0;
  const liveness: WsLiveness = {
    noteInbound(): void {
      lastInboundAt = Date.now();
    },
    start(): void {
      if (pingTimer) return;
      lastInboundAt = Date.now();
      pingTimer = setInterval(() => options.sendPing(), pingIntervalMs);
      checkTimer = setInterval(() => {
        if (Date.now() - lastInboundAt > deadAfterMs) {
          liveness.stop();
          options.onDead();
        }
      }, checkEveryMs);
    },
    stop(): void {
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      if (checkTimer) {
        clearInterval(checkTimer);
        checkTimer = null;
      }
    },
  };
  return liveness;
}

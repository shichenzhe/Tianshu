// ws 应用层活性（T14；T11/T12 遗留 F1「relay 客户端无活性检测——静默死链
// 不重连」在此一并解）：undici 全局 WebSocket 无协议层 ping/pong（浏览器
// API 不暴露；Electron 44 主进程实测 ws.ping === undefined）→
// {kind:'ping'}/{kind:'pong'} 应用层帧经 relay 透传（relay 侧 parseFrame
// 仅要求 kind 为 string，未知 kind 原样转发）。双消费者对称使用：
// - 被控端 server-face/relay-client.ts
// - 控制端 server/relay-transport.ts
// 两端各自定时发 ping、对收到的 ping 回 pong（pong 应答在各自 onFrame 内
// 处理，不在本模块）。判死口径：deadAfterMs 内无任何入站帧——任意帧皆
// 活性证据，比只认 pong 更稳（事件流繁忙的活链不误杀，静默死链必超窗）。
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
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let checkTimer: ReturnType<typeof setInterval> | null = null;
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

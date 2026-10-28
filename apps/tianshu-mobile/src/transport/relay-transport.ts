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
import { ENDPOINTS, type RelayFrame, type ServerEvent } from "@tianshu/protocol";
import { nextBackoffMs } from "./backoff";
import { Emitter, type Transport, type TransportRequestResult, type TransportState } from "./types";

export interface RelayConfig {
  relayUrl: string;
  relayToken: string;
  /** 目标被控端 instanceId（带外获取：桌面端关于页/无头端 handshake 日志） */
  connectionId: string;
}

const REQ_TIMEOUT_MS = 10_000;

export function createRelayTransport(config: RelayConfig): Transport {
  const events = new Emitter<ServerEvent>();
  const states = new Emitter<TransportState>();
  let state: TransportState = "idle";
  let closed = false;
  let attempt = 0;
  let ws: WebSocket | null = null;
  let nextId = 1;
  let lastInboundAt = 0;
  let livenessTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Map<
    number,
    { resolve: (r: TransportRequestResult) => void; timer: ReturnType<typeof setTimeout> }
  >();

  const setState = (s: TransportState) => {
    state = s;
    states.emit(s);
  };
  const send = (frame: RelayFrame) => {
    try {
      ws?.send(JSON.stringify(frame));
    } catch {
      /* 半死/未开 socket：挂起 req 由 10s 超时兜底，连接由 onclose 兜底重连 */
    }
  };
  const failPending = () => {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.resolve({ status: 0, body: null });
    }
    pending.clear();
  };

  /** open 帧已发出即配对（relay 对成功 open 静默、无从等回执——mirror
   * 蓝本同款：connected = ws 开 + open 已发；目标不在线由 relay close 帧
   * not-found + ws close 4004 拆回退避重连）后的一次性初始化 */
  function onPaired(): void {
    setState("connected");
    attempt = 0;
    void synthConnected();
    if (livenessTimer) clearInterval(livenessTimer);
    livenessTimer = setInterval(() => {
      if (Date.now() - lastInboundAt > 60_000) {
        ws?.close(); // 无入站判死，onclose 兜底走重连
        return;
      }
      send({ kind: "ping" });
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
    if (closed) return;
    setState(state === "idle" ? "connecting" : "reconnecting");
    lastInboundAt = Date.now();
    const url = `${config.relayUrl}?role=client&token=${encodeURIComponent(config.relayToken)}`;
    const socket = new WebSocket(url);
    ws = socket;
    socket.onopen = () => {
      send({ kind: "open", connectionId: config.connectionId });
      onPaired();
    };
    socket.onmessage = (ev) => {
      if (ws !== socket) return; // epoch 守卫：旧 socket 迟到帧不碰新连接
      lastInboundAt = Date.now();
      let frame: RelayFrame;
      try {
        frame = JSON.parse(ev.data as string) as RelayFrame;
      } catch {
        return;
      }
      if (frame.kind === "pong") return;
      if (frame.kind === "event") {
        // wire 形态 {kind:'event',type,payload}：帧级 type/payload 重组回
        // ServerEvent（mirror dispatchEventFrame 同款）
        events.emit({ type: frame.type, payload: frame.payload } as ServerEvent);
      } else if (frame.kind === "res") {
        const p = pending.get(frame.id);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(frame.id);
          p.resolve({ status: frame.status, body: frame.body });
        }
      } else if (frame.kind === "close") {
        // server-gone/not-found：目标不在线，按断线退避重连
        scheduleReconnect();
      }
    };
    socket.onclose = (ev) => {
      if (ws !== socket) return; // epoch 守卫：旧 socket 迟到 close 不触发重连
      if (closed) return;
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

  function request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<TransportRequestResult> {
    return new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ status: 0, body: null }); // 超时=不可达语义
      }, REQ_TIMEOUT_MS);
      pending.set(id, { resolve, timer });
      send({
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

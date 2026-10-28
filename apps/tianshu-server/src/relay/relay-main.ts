import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  DEFAULT_MAX_BUFFER_FRAMES,
  RelayRegistry,
  type RelayFrame,
} from './registry';

export { DEFAULT_MAX_BUFFER_FRAMES };

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 60_000;
export const DEFAULT_RELAY_PORT = 8411;

export interface RelayOptions {
  /** 监听端口；0 = 随机端口（实际端口经返回值与启动日志暴露） */
  port: number;
  /** 接入令牌；缺省拒绝启动（公网中继必须鉴权） */
  token: string;
  /** 每 socket 出向积压帧上限，超限拆连接（慢消费者防内存膨胀） */
  maxBufferFrames?: number;
}

export interface RelayHandle {
  port: number;
  close(): Promise<void>;
}

/** 中继服务：被控端（role=server）与控制端（role=client）经 /ws 配对后帧级直转。纯 node:http + ws，不依赖 Nest。 */
export async function startRelay(options: RelayOptions): Promise<RelayHandle> {
  if (!options.token) throw new Error('relay 拒绝启动：缺少 token');
  const registry = new RelayRegistry(options.maxBufferFrames);
  const httpServer = createServer((req, res) => {
    if (req.url?.split('?')[0] === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    res.writeHead(404).end();
  });
  // F4：单帧上限 4MiB，超限 ws 层直接 close(1009)，防巨包打爆内存
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 4 * 1024 * 1024,
  });
  const lastPong = new Map<WebSocket, number>();

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://relay');
    if (url.pathname !== '/ws') return void socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (url.searchParams.get('token') !== options.token)
        return void ws.close(4001, 'invalid-token');
      const role = url.searchParams.get('role');
      if (role !== 'server' && role !== 'client')
        return void ws.close(4000, 'invalid-role');
      handleConnection(ws, role, url.searchParams.get('connectionId') ?? '');
    });
  });

  function handleConnection(ws: WebSocket, role: string, connId: string): void {
    // F4：maxPayload 超限/协议错误——ws 已自行 close(1009) 并随后 emit('error')，
    // 此处仅兜住事件防进程级未处理错误，不得 terminate（会抢跑 1009 close 帧）
    ws.on('error', () => {});
    lastPong.set(ws, Date.now());
    ws.on('pong', () => lastPong.set(ws, Date.now()));
    ws.on('close', () => {
      lastPong.delete(ws);
      registry.forget(ws);
    });
    if (role === 'server') handleServerSocket(ws, connId);
    else handleClientSocket(ws);
  }

  function handleServerSocket(ws: WebSocket, connectionId: string): void {
    if (!connectionId) return void ws.close(4000, 'missing-connection-id');
    registry.registerServer(connectionId, ws);
    ws.on('message', (raw) => {
      const frame = parseFrame(decodeRaw(raw));
      if (!frame || frame.kind === 'register') return; // register=首帧元数据
      registry.forwardToClients(connectionId, frame);
    });
    // F1：close 事件带身份交 registry 核验（被重注册顶掉的旧连接不拆配对）
    ws.on('close', () => registry.dropServer(connectionId, ws, 'server-gone'));
  }

  function handleClientSocket(ws: WebSocket): void {
    let attached: string | null = null;
    ws.on('message', (raw) => {
      const frame = parseFrame(decodeRaw(raw));
      if (!frame) return;
      if (frame.kind === 'open') {
        const target =
          typeof frame.connectionId === 'string' ? frame.connectionId : '';
        // F3：换目标 open 前先清旧配对并通知旧 server
        if (attached && attached !== target)
          registry.notifyClose(
            attached,
            ws,
            closeFrame(attached, 'client-gone'),
          );
        if (!registry.attachClient(target, ws)) {
          // 4004 拆连接前收敛 attached：F3 已对旧目标发过 client-gone，
          // 置空防 ws close 事件对旧目标再发一次（重复帧，server 侧幂等
          // 消费契约此前靠被控端自兜——T11/T12 契约注记收敛于此）
          attached = null;
          sendDirect(ws, closeFrame(target, 'not-found'));
          return void ws.close(4004, 'not-found');
        }
        registry.notifyOpen(target, frame);
        attached = target;
        return;
      }
      if (frame.kind === 'close' && attached) {
        // F2:close 控制帧拆配对，双向通知
        const closedId = attached;
        attached = null;
        registry.notifyClose(closedId, ws, closeFrame(closedId, 'client-gone'));
        sendDirect(ws, closeFrame(closedId, 'closed'));
        return;
      }
      if (attached && frame.kind !== 'register')
        registry.forwardToServer(attached, frame);
    });
    ws.on('close', () => {
      if (!attached) return;
      registry.notifyClose(attached, ws, closeFrame(attached, 'client-gone'));
    });
  }

  function closeFrame(connectionId: string, reason: string): RelayFrame {
    return { kind: 'close', connectionId, reason };
  }
  /** 坏帧静默丢弃（防恶意/半截输入打断其他连接的转发） */
  function parseFrame(raw: string): RelayFrame | null {
    try {
      const frame = JSON.parse(raw) as RelayFrame;
      return typeof frame?.kind === 'string' ? frame : null;
    } catch {
      return null;
    }
  }

  /** RawData 三形态显式归一 utf8 文本（ArrayBuffer 不能走默认 toString） */
  function decodeRaw(raw: Buffer | ArrayBuffer | Buffer[]): string {
    if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
    if (Buffer.isBuffer(raw)) return raw.toString('utf8');
    return Buffer.from(raw).toString('utf8');
  }

  /** 不经 registry 计数的直发（not-found 等即时回执） */
  function sendDirect(ws: WebSocket, frame: RelayFrame): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      ws.close(1011, 'send-failed');
    }
  }

  // 心跳：30s 轮询 ping，60s 无 pong 剔除；unref 保证不阻进程退出
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const ws of wss.clients) {
      if (now - (lastPong.get(ws) ?? now) > HEARTBEAT_TIMEOUT_MS)
        ws.terminate();
      else ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  sweep.unref();

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port, '0.0.0.0', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  return {
    port: (httpServer.address() as { port: number }).port,
    close: async () => {
      clearInterval(sweep);
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

/** CLI 参数解析：支持 `--k v` 与 `--k=v` 两种形式；缺 token 留空由入口拒绝 */
export function parseCliArgs(argv: string[]): RelayOptions {
  const options: RelayOptions = {
    port: DEFAULT_RELAY_PORT,
    token: '',
    maxBufferFrames: DEFAULT_MAX_BUFFER_FRAMES,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const equalIndex = arg.indexOf('=');
    const name = equalIndex === -1 ? arg : arg.slice(0, equalIndex);
    const next = i + 1 < argv.length ? argv[i + 1] : undefined;
    const value = equalIndex === -1 ? next : arg.slice(equalIndex + 1);
    if (value === undefined) continue;
    if (equalIndex === -1) i += 1;
    if (name === '--port') options.port = toInt(value);
    else if (name === '--token') options.token = value;
    else if (name === '--max-buffer-frames')
      options.maxBufferFrames = toInt(value);
  }
  return options;
}
const toInt = (value: string): number => Number.parseInt(value, 10) || 0;
// CLI 入口：node dist/src/relay/relay-main.js --port 8411 --token <t> --max-buffer-frames 200
if (require.main === module) {
  const options = parseCliArgs(process.argv.slice(2));
  if (!options.token) {
    console.error('[relay] 缺少 --token，拒绝启动（公网中继必须鉴权）');
    process.exit(1);
  }
  startRelay(options)
    .then(({ port }) => console.log(`[relay] listening on port ${port}`))
    .catch((error: unknown) => {
      console.error('[relay] 启动失败:', error);
      process.exit(1);
    });
}

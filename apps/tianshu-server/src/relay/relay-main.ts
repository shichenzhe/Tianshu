import { createServer, type RequestListener } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';
import { RELAY_CLOSE_CODES, type AuthFrame } from '@tianshu/protocol';
import {
  DEFAULT_MAX_BUFFER_FRAMES,
  RelayRegistry,
  type RelayFrame,
} from './registry';
import type { AccessQuota } from './jwt-eddsa';
import {
  createJwtAuthenticator,
  createStaticAuthenticator,
  type Authenticator,
} from './auth';

export { DEFAULT_MAX_BUFFER_FRAMES };

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 60_000;
/** 首帧鉴权等待窗：窗口内无凭证（无 auth 首帧且 query 无 token）即拒 */
const DEFAULT_AUTH_WINDOW_MS = 5_000;
export const DEFAULT_RELAY_PORT = 8411;

/** jwt 防御闸形状核验（Task 4）：verifyAccessJwt 不对 tid/quota 作 wire
 *  保证——签名合法但载荷畸形的 token 不得带无配额租户进闸门（后续
 *  quota.maxServers 解引用会炸）。quota 缺失或字段非正数即畸形 */
function isUsableQuota(quota: AccessQuota | undefined): boolean {
  return (
    quota !== undefined &&
    Number.isFinite(quota.maxServers) &&
    quota.maxServers > 0 &&
    Number.isFinite(quota.maxClients) &&
    quota.maxClients > 0
  );
}

export interface RelayOptions {
  /** 监听端口；0 = 随机端口（实际端口经返回值与启动日志暴露） */
  port: number;
  /** 接入令牌；缺省拒绝启动（公网中继必须鉴权） */
  token: string;
  /** 每 socket 出向积压帧上限，超限拆连接（慢消费者防内存膨胀） */
  maxBufferFrames?: number;
  /** 首帧鉴权等待窗（缺省 5s；测试注入缩短） */
  authWindowMs?: number;
  /** TLS 证书 PEM（安全批 I：与 keyFile 成对传入即 https/wss 监听；
   *  缺省 http——既定部署架构为反代终止 TLS，此为原生可选通道） */
  certFile?: string;
  /** TLS 私钥 PEM（与 certFile 成对） */
  keyFile?: string;
  /** 鉴权模式（多租户批 Task 3）：static（共享 token，现状）/ jwt
   *  （access JWT 验签）；缺省按凭证面推断——authPubkeyFile 在场即
   *  jwt，否则 static（此时 token 必填，缺省拒绝启动） */
  authMode?: 'static' | 'jwt';
  /** jwt 模式公钥 PEM 文件（relay-admin 签发私钥的对侧） */
  authPubkeyFile?: string;
  /** 内部端点（/internal/kick、/internal/stats）Bearer 凭证；
   *  Task 5 消费，本任务仅入参收口 */
  internalSecret?: string;
}

export interface RelayHandle {
  port: number;
  close(): Promise<void>;
}

/** 鉴权器构造（多租户批 Task 3）：模式推断——显式 authMode 优先，
 *  缺省 authPubkeyFile 在场即 jwt，否则 static。static 缺 token /
 *  jwt 缺公钥均拒绝启动（static 分支与原内联缺 token 拒绝同语义） */
function createAuthenticator(options: RelayOptions): Authenticator {
  const authMode =
    options.authMode ?? (options.authPubkeyFile ? 'jwt' : 'static');
  if (authMode === 'jwt') {
    if (!options.authPubkeyFile)
      throw new Error('relay 拒绝启动：jwt 模式需要 --auth-pubkey');
    const publicKeyPem = readFileSync(options.authPubkeyFile, 'utf8');
    // 启动时公钥可解析性校验：坏 PEM 若漏到运行期，verifyAccessJwt 的
    // 归一语义会把它伪装成凭证问题——所有连接 4001 invalid-token
    try {
      createPublicKey(publicKeyPem);
    } catch {
      throw new Error('relay 拒绝启动：--auth-pubkey 不是合法公钥');
    }
    return createJwtAuthenticator(
      publicKeyPem,
      // 吊销检查面（CRL 拉取，多租户批 Task 6 接线）：当前无吊销源
      () => false,
    );
  }
  if (!options.token) throw new Error('relay 拒绝启动：缺少 token');
  return createStaticAuthenticator(options.token);
}

/**
 * 中继服务：被控端（role=server）与控制端（role=client）经 /ws 配对后
 * 帧级直转。纯 node:http(s) + ws，不依赖 Nest。
 *
 * 凭证面（安全批 I）：升级 query 携带 token 的明文会留存在反代/负载
 * 均衡访问日志——鉴权首选**首帧 auth**（升级后第一条消息，ws 帧不经
 * 访问日志）；query 凭证双轨受理（老客户端兼容窗口，命中打弃用告警），
 * 窗口期后客户端侧移除 query。
 */
export async function startRelay(options: RelayOptions): Promise<RelayHandle> {
  const authenticator = createAuthenticator(options);
  if ((options.certFile !== undefined) !== (options.keyFile !== undefined)) {
    throw new Error('relay 拒绝启动：--cert 与 --key 必须成对提供');
  }
  const registry = new RelayRegistry(options.maxBufferFrames);
  const requestListener: RequestListener = (req, res) => {
    if (req.url?.split('?')[0] === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    res.writeHead(404).end();
  };
  const httpServer =
    options.certFile && options.keyFile
      ? createHttpsServer(
          {
            cert: readFileSync(options.certFile),
            key: readFileSync(options.keyFile),
          },
          requestListener,
        )
      : createServer(requestListener);
  // F4：单帧上限 4MiB，超限 ws 层直接 close(1009)，防巨包打爆内存
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 4 * 1024 * 1024,
  });
  const lastPong = new Map<WebSocket, number>();

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://relay');
    if (url.pathname !== '/ws') return void socket.destroy();
    // 安全批 J：query 凭证双轨窗口关闭——四端客户端已全部切换首帧 auth
    //（批 I 起 URL 零凭证），query 一律无视；升级后只等首帧 auth 窗
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => {});
      const authTimer = setTimeout(
        () => void ws.close(4001, 'invalid-token'),
        options.authWindowMs ?? DEFAULT_AUTH_WINDOW_MS,
      );
      authTimer.unref?.();
      ws.once('message', (raw) => {
        clearTimeout(authTimer);
        const first = parseFrame(decodeRaw(raw));
        if (first?.kind !== 'auth') return void ws.close(4001, 'invalid-token');
        const auth = first as AuthFrame;
        admitConnection(
          ws,
          typeof auth.token === 'string' ? auth.token : '',
          auth.role,
          typeof auth.connectionId === 'string' ? auth.connectionId : '',
        );
      });
    });
  });

  /** 鉴权落定分流：Authenticator 裁决后进既有连接处理（static 裁决面
   *  与原内联校验逐字节一致——4001 invalid-token / 4000 invalid-role）。
   *  多租户批 Task 4：裁决携带 tenantId/quota 透传至连接处理做三闸门 */
  function admitConnection(
    ws: WebSocket,
    token: string,
    role: unknown,
    connId: string,
  ): void {
    const decision = authenticator.admit({
      token,
      role,
      connectionId: connId,
    });
    if (!decision.ok)
      return void ws.close(decision.closeCode, decision.reason);
    // jwt 防御闸：tenantId 在场而 quota 畸形（缺失/字段非正数）→ 与验签
    // 失败同归 4001；tenantId 缺失按 static 语义旁路（设计内行为，
    // 不因此拒绝）——static 裁决 tenantId 恒缺省，本闸零参与
    if (decision.tenantId !== undefined && !isUsableQuota(decision.quota))
      return void ws.close(4001, 'invalid-token');
    handleConnection(
      ws,
      decision.role,
      connId,
      decision.tenantId,
      decision.quota,
    );
  }

  function handleConnection(
    ws: WebSocket,
    role: string,
    connId: string,
    tenantId?: string,
    quota?: AccessQuota,
  ): void {
    // F4：maxPayload 超限/协议错误——ws 已自行 close(1009) 并随后 emit('error')，
    // 此处仅兜住事件防进程级未处理错误，不得 terminate（会抢跑 1009 close 帧）
    ws.on('error', () => {});
    lastPong.set(ws, Date.now());
    ws.on('pong', () => lastPong.set(ws, Date.now()));
    ws.on('close', () => {
      lastPong.delete(ws);
      registry.forget(ws);
    });
    if (role === 'server')
      handleServerSocket(ws, connId, tenantId, quota);
    else handleClientSocket(ws, tenantId, quota);
  }

  function handleServerSocket(
    ws: WebSocket,
    connectionId: string,
    tenantId?: string,
    quota?: AccessQuota,
  ): void {
    if (!connectionId) return void ws.close(4000, 'missing-connection-id');
    // 三闸门之一·配额（jwt 模式）：租户 server 连接达 maxServers → 4005。
    // 防御闸已保证 tenantId 在场时 quota 形状合法，此处解引用安全
    if (
      tenantId !== undefined &&
      quota &&
      registry.tenantConnCount(tenantId, 'server') >= quota.maxServers
    )
      return void ws.close(RELAY_CLOSE_CODES.QUOTA_EXCEEDED, 'quota-exceeded');
    const registered = registry.registerServer(connectionId, ws, tenantId);
    // 三闸门之二·顶号：异租户注册已占 id → 4006（同租户重注册=重连顶号，
    // 现状保留）；冲突时 registry 不动现有注册，直接拆新连接
    if (registered === 'id-conflict')
      return void ws.close(RELAY_CLOSE_CODES.ID_CONFLICT, 'id-conflict');
    ws.on('message', (raw) => {
      const frame = parseFrame(decodeRaw(raw));
      // register=首帧元数据；auth=鉴权层帧（畸形迟到到达也不透传）
      if (!frame || frame.kind === 'register' || frame.kind === 'auth') return;
      registry.forwardToClients(connectionId, frame);
    });
    // F1：close 事件带身份交 registry 核验（被重注册顶掉的旧连接不拆配对）
    ws.on('close', () => registry.dropServer(connectionId, ws, 'server-gone'));
  }

  function handleClientSocket(
    ws: WebSocket,
    tenantId?: string,
    quota?: AccessQuota,
  ): void {
    let attached: string | null = null;
    ws.on('message', (raw) => {
      const frame = parseFrame(decodeRaw(raw));
      if (!frame) return;
      if (frame.kind === 'auth') return; // 鉴权层帧不转发（含迟到畸形）
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
        // 三闸门之一·配额（jwt 模式）：租户 client 配对达 maxClients →
        // 4005。重开已配对目标（attached===target）不增连接数，旁路防
        // 自拒（计数已含本连接的 1 条）
        if (
          tenantId !== undefined &&
          quota &&
          attached !== target &&
          registry.tenantConnCount(tenantId, 'client') >= quota.maxClients
        ) {
          attached = null;
          sendDirect(ws, closeFrame(target, 'quota-exceeded'));
          return void ws.close(
            RELAY_CLOSE_CODES.QUOTA_EXCEEDED,
            'quota-exceeded',
          );
        }
        const attachResult = registry.attachClient(target, ws, tenantId);
        if (attachResult !== 'ok') {
          // 4004/4007 拆连接前收敛 attached：F3 已对旧目标发过
          // client-gone，置空防 ws close 事件对旧目标再发一次（重复帧，
          // server 侧幂等消费契约此前靠被控端自兜——T11/T12 契约注记收敛于此）
          attached = null;
          if (attachResult === 'forbidden') {
            // 三闸门之三·attach 授权：跨租户配对 → 4007
            sendDirect(ws, closeFrame(target, 'tenant-forbidden'));
            return void ws.close(
              RELAY_CLOSE_CODES.TENANT_FORBIDDEN,
              'tenant-forbidden',
            );
          }
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
  function parseFrame(raw: string): RelayFrame | AuthFrame | null {
    try {
      const frame = JSON.parse(raw) as RelayFrame | AuthFrame;
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
    else if (name === '--cert') options.certFile = value;
    else if (name === '--key') options.keyFile = value;
    else if (name === '--auth-pubkey') options.authPubkeyFile = value;
    else if (name === '--internal-secret') options.internalSecret = value;
  }
  return options;
}
const toInt = (value: string): number => Number.parseInt(value, 10) || 0;
// CLI 入口：node dist/src/relay/relay-main.js --port 8411 --token <t> --max-buffer-frames 200
// TLS 可选：--cert <pem> --key <pem>（成对传入即 wss 监听；缺省 http——默认部署架构为反代终止 TLS）
// 鉴权模式（多租户批 Task 3）：--auth-pubkey <pem> 在场即 jwt 验签（免 --token）；
// --internal-secret <s> 内部端点凭证（Task 5 消费）
if (require.main === module) {
  const options = parseCliArgs(process.argv.slice(2));
  if (!options.token && !options.authPubkeyFile) {
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

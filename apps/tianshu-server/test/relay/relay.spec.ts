import WebSocket from 'ws';
import { waitFor } from '../support/wait-for';
import {
  startRelay,
  parseCliArgs,
  DEFAULT_RELAY_PORT,
  DEFAULT_MAX_BUFFER_FRAMES,
  type RelayHandle,
} from 'src/relay/relay-main';
import { RelayRegistry } from 'src/relay/registry';

/** 测试内最小帧形状（relay 对业务负载透传不解释） */
interface TestFrame {
  kind: string;
  connectionId?: string;
  id?: number;
  reason?: string;
  [key: string]: unknown;
}

interface TrackedSocket {
  ws: WebSocket;
  frames: TestFrame[];
  waitForFrame(
    predicate: (frame: TestFrame) => boolean,
    timeoutMs?: number,
  ): Promise<TestFrame>;
}

/** 记录 socket 收到的全部 JSON 帧并支持谓词等待 */
function trackFrames(ws: WebSocket): TrackedSocket {
  const frames: TestFrame[] = [];
  const pending: {
    predicate: (frame: TestFrame) => boolean;
    resolve: (frame: TestFrame) => void;
    timer: NodeJS.Timeout;
  }[] = [];
  ws.on('message', (raw) => {
    const frame = JSON.parse((raw as Buffer).toString()) as TestFrame;
    frames.push(frame);
    const index = pending.findIndex((item) => item.predicate(frame));
    if (index >= 0) {
      const [item] = pending.splice(index, 1);
      clearTimeout(item.timer);
      item.resolve(frame);
    }
  });
  return {
    ws,
    frames,
    waitForFrame(predicate, timeoutMs = 3000) {
      const hit = frames.find(predicate);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        pending.push({
          predicate,
          resolve,
          timer: setTimeout(
            () =>
              reject(
                new Error(
                  `waitForFrame 超时，已收帧: ${JSON.stringify(frames)}`,
                ),
              ),
            timeoutMs,
          ),
        });
      });
    },
  };
}

/** 等 socket 关闭并取回 close code */
function closeCodeOf(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.on('close', (code) => resolve(code)));
}

const TOKEN = 'relay-secret';

describe('relay 配对转发（真实 ws 双客户端）', () => {
  let relay: RelayHandle;
  let openedSockets: WebSocket[];

  const openRelaySocket = (query: string): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/ws?${query}`);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });

  beforeEach(async () => {
    relay = await startRelay({ port: 0, token: TOKEN });
    openedSockets = [];
  });

  afterEach(async () => {
    for (const ws of openedSockets) ws.terminate();
    await relay.close();
  });

  it('server 注册后 client open/req/res/event 双向透传', async () => {
    const server = trackFrames(
      await openRelaySocket(`role=server&token=${TOKEN}&connectionId=s1`),
    );
    openedSockets.push(server.ws);
    const client = trackFrames(
      await openRelaySocket(`role=client&token=${TOKEN}`),
    );
    openedSockets.push(client.ws);

    // open：client 发起配对，server 收到 open 通知帧
    client.ws.send(JSON.stringify({ kind: 'open', connectionId: 's1' }));
    await server.waitForFrame(
      (frame) => frame.kind === 'open' && frame.connectionId === 's1',
    );

    // req：client → server
    client.ws.send(
      JSON.stringify({
        kind: 'req',
        id: 1,
        method: 'session.send',
        payload: { text: '你好' },
      }),
    );
    const req = await server.waitForFrame(
      (frame) => frame.kind === 'req' && frame.id === 1,
    );
    expect(req.method).toBe('session.send');
    expect(req.payload).toEqual({ text: '你好' });

    // res：server → client（按 id 关联）
    server.ws.send(JSON.stringify({ kind: 'res', id: 1, ok: true }));
    const res = await client.waitForFrame(
      (frame) => frame.kind === 'res' && frame.id === 1,
    );
    expect(res.ok).toBe(true);

    // event：server → client 透传
    server.ws.send(
      JSON.stringify({
        kind: 'event',
        type: 'message.chunk',
        payload: { delta: 'h' },
      }),
    );
    await client.waitForFrame((frame) => frame.kind === 'event');
  });

  it('token 不符：升级后即 close(4001)', async () => {
    const ws = await openRelaySocket(`role=client&token=WRONG`);
    openedSockets.push(ws);
    await expect(closeCodeOf(ws)).resolves.toBe(4001);
  });

  it('GET /health 返回 200 ok', async () => {
    const response = await fetch(`http://127.0.0.1:${relay.port}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  it('server 首帧 register 元数据不透传给 client', async () => {
    const server = trackFrames(
      await openRelaySocket(`role=server&token=${TOKEN}&connectionId=s1`),
    );
    openedSockets.push(server.ws);
    server.ws.send(
      JSON.stringify({
        kind: 'register',
        instanceId: 'i-1',
        capabilities: ['chat'],
        name: '办公机',
      }),
    );
    const client = trackFrames(
      await openRelaySocket(`role=client&token=${TOKEN}`),
    );
    openedSockets.push(client.ws);
    client.ws.send(JSON.stringify({ kind: 'open', connectionId: 's1' }));
    await server.waitForFrame((frame) => frame.kind === 'open');
    server.ws.send(JSON.stringify({ kind: 'event', type: 'ping.pong' }));
    await client.waitForFrame((frame) => frame.kind === 'event');
    expect(client.frames.some((frame) => frame.kind === 'register')).toBe(
      false,
    );
  });

  it('client 断开：server 收到 close 帧（notifyClose）', async () => {
    const server = trackFrames(
      await openRelaySocket(`role=server&token=${TOKEN}&connectionId=s1`),
    );
    openedSockets.push(server.ws);
    const client = trackFrames(
      await openRelaySocket(`role=client&token=${TOKEN}`),
    );
    client.ws.send(JSON.stringify({ kind: 'open', connectionId: 's1' }));
    await server.waitForFrame((frame) => frame.kind === 'open');
    client.ws.close();
    await server.waitForFrame(
      (frame) => frame.kind === 'close' && frame.connectionId === 's1',
    );
  });
});

describe('relay 健壮性（not-found/close 通知/背压）', () => {
  let relay: RelayHandle;
  let openedSockets: WebSocket[];

  const openRelaySocket = (query: string): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/ws?${query}`);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });

  beforeEach(async () => {
    relay = await startRelay({ port: 0, token: TOKEN, maxBufferFrames: 200 });
    openedSockets = [];
  });

  afterEach(async () => {
    for (const ws of openedSockets) ws.terminate();
    await relay.close();
  });

  it('server 未注册时 open：client 收 close 帧(reason=not-found)并被断开', async () => {
    const client = trackFrames(
      await openRelaySocket(`role=client&token=${TOKEN}`),
    );
    openedSockets.push(client.ws);
    client.ws.send(JSON.stringify({ kind: 'open', connectionId: 'ghost' }));
    const frame = await client.waitForFrame(
      (item) => item.kind === 'close' && item.reason === 'not-found',
    );
    expect(frame.connectionId).toBe('ghost');
    await expect(closeCodeOf(client.ws)).resolves.toBe(4004);
  });

  it('server 掉线：已配对 client 收 close 帧(reason=server-gone)并被断开', async () => {
    const server = trackFrames(
      await openRelaySocket(`role=server&token=${TOKEN}&connectionId=s2`),
    );
    openedSockets.push(server.ws);
    const client = trackFrames(
      await openRelaySocket(`role=client&token=${TOKEN}`),
    );
    openedSockets.push(client.ws);
    client.ws.send(JSON.stringify({ kind: 'open', connectionId: 's2' }));
    await server.waitForFrame((item) => item.kind === 'open');
    server.ws.close();
    const frame = await client.waitForFrame(
      (item) => item.kind === 'close' && item.reason === 'server-gone',
    );
    expect(frame.connectionId).toBe('s2');
    await expect(closeCodeOf(client.ws)).resolves.toBe(4003);
  });

  it('F1 同 id 重注册：旧连接 close 不误拆 client、新连接接管配对（真实 ws）', async () => {
    const serverA = trackFrames(
      await openRelaySocket(`role=server&token=${TOKEN}&connectionId=r1`),
    );
    openedSockets.push(serverA.ws);
    const client = trackFrames(
      await openRelaySocket(`role=client&token=${TOKEN}`),
    );
    openedSockets.push(client.ws);
    client.ws.send(JSON.stringify({ kind: 'open', connectionId: 'r1' }));
    await serverA.waitForFrame((item) => item.kind === 'open');
    // serverB 重注册同 id：serverA 被顶掉(4000)，其 close 事件不得触发拆配对
    const serverB = trackFrames(
      await openRelaySocket(`role=server&token=${TOKEN}&connectionId=r1`),
    );
    openedSockets.push(serverB.ws);
    await expect(closeCodeOf(serverA.ws)).resolves.toBe(4000);
    await new Promise((resolve) => setTimeout(resolve, 150)); // 留出（错误的）dropServer 窗口
    expect(client.frames.some((item) => item.kind === 'close')).toBe(false);
    expect(client.ws.readyState).toBe(WebSocket.OPEN); // 未被误拆 4003
    // 已配对 client 的 req 由新连接接管
    client.ws.send(JSON.stringify({ kind: 'req', id: 1, method: 'x' }));
    await serverB.waitForFrame((item) => item.kind === 'req' && item.id === 1);
    // 新 client open 也不应 not-found
    const client2 = trackFrames(
      await openRelaySocket(`role=client&token=${TOKEN}`),
    );
    openedSockets.push(client2.ws);
    client2.ws.send(JSON.stringify({ kind: 'open', connectionId: 'r1' }));
    await serverB.waitForFrame(
      (item) => item.kind === 'open' && item.connectionId === 'r1',
    );
  });

  // T11/T12 契约注记收敛：换目标 open 撞 not-found（4004 拆连接）时，
  // attached 收敛为 null——旧目标的 client-gone 只发一次，ws close 事件
  // 不得对旧目标重复通知（被控端 client-gone 重复帧幂等消费依赖此修复）
  it('open 目标 not-found 拆连接：旧目标 client-gone 不重复（attached=null 收敛）', async () => {
    const server = trackFrames(
      await openRelaySocket(`role=server&token=${TOKEN}&connectionId=n1`),
    );
    openedSockets.push(server.ws);
    const client = trackFrames(
      await openRelaySocket(`role=client&token=${TOKEN}`),
    );
    openedSockets.push(client.ws);
    client.ws.send(JSON.stringify({ kind: 'open', connectionId: 'n1' }));
    await server.waitForFrame((item) => item.kind === 'open');
    // 已配对 n1 后 open 不存在的 ghost：F3 先对 n1 发 client-gone，4004
    // 拆连接的 close 事件不得再发一次
    client.ws.send(JSON.stringify({ kind: 'open', connectionId: 'ghost' }));
    await server.waitForFrame(
      (item) => item.kind === 'close' && item.reason === 'client-gone',
    );
    await client.waitForFrame(
      (item) => item.kind === 'close' && item.reason === 'not-found',
    );
    await expect(closeCodeOf(client.ws)).resolves.toBe(4004);
    // 留出（错误的）close 事件重复通知窗口
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(
      server.frames.filter(
        (item) => item.kind === 'close' && item.reason === 'client-gone',
      ).length,
    ).toBe(1);
  });

  it('F2 client close 控制帧：拆配对并双向通知，ws 保留可重新 open', async () => {
    const server = trackFrames(
      await openRelaySocket(`role=server&token=${TOKEN}&connectionId=c1`),
    );
    openedSockets.push(server.ws);
    const client = trackFrames(
      await openRelaySocket(`role=client&token=${TOKEN}`),
    );
    openedSockets.push(client.ws);
    client.ws.send(JSON.stringify({ kind: 'open', connectionId: 'c1' }));
    await server.waitForFrame((item) => item.kind === 'open');
    client.ws.send(JSON.stringify({ kind: 'close', connectionId: 'c1' }));
    await server.waitForFrame(
      (item) => item.kind === 'close' && item.reason === 'client-gone',
    );
    await client.waitForFrame(
      (item) => item.kind === 'close' && item.reason === 'closed',
    );
    // 拆配对后的 req 丢弃；重新 open 后恢复转发
    client.ws.send(JSON.stringify({ kind: 'req', id: 9, method: 'x' }));
    client.ws.send(JSON.stringify({ kind: 'open', connectionId: 'c1' }));
    await waitFor(
      () =>
        expect(
          server.frames.filter((item) => item.kind === 'open').length,
        ).toBe(2),
      1500,
    );
    expect(
      server.frames.some((item) => item.kind === 'req' && item.id === 9),
    ).toBe(false);
    client.ws.send(JSON.stringify({ kind: 'req', id: 10, method: 'x' }));
    await server.waitForFrame((item) => item.kind === 'req' && item.id === 10);
  });

  it('F3 client 换 open 目标：旧配对被清并通知旧 server，req 走新 server', async () => {
    const server1 = trackFrames(
      await openRelaySocket(`role=server&token=${TOKEN}&connectionId=d1`),
    );
    openedSockets.push(server1.ws);
    const server2 = trackFrames(
      await openRelaySocket(`role=server&token=${TOKEN}&connectionId=d2`),
    );
    openedSockets.push(server2.ws);
    const client = trackFrames(
      await openRelaySocket(`role=client&token=${TOKEN}`),
    );
    openedSockets.push(client.ws);
    client.ws.send(JSON.stringify({ kind: 'open', connectionId: 'd1' }));
    await server1.waitForFrame((item) => item.kind === 'open');
    client.ws.send(JSON.stringify({ kind: 'open', connectionId: 'd2' }));
    await server2.waitForFrame((item) => item.kind === 'open');
    await server1.waitForFrame(
      (item) => item.kind === 'close' && item.reason === 'client-gone',
    );
    client.ws.send(JSON.stringify({ kind: 'req', id: 1, method: 'x' }));
    await server2.waitForFrame((item) => item.kind === 'req' && item.id === 1);
    expect(server1.frames.some((item) => item.kind === 'req')).toBe(false);
  });

  it('F4 单帧超过 4MiB maxPayload：ws 层 close(1009)', async () => {
    const server = await openRelaySocket(
      `role=server&token=${TOKEN}&connectionId=b1`,
    );
    openedSockets.push(server);
    const client = await openRelaySocket(`role=client&token=${TOKEN}`);
    openedSockets.push(client);
    client.send(
      JSON.stringify({
        kind: 'open',
        connectionId: 'b1',
        pad: 'x'.repeat(5 * 1024 * 1024),
      }),
    );
    await expect(closeCodeOf(client)).resolves.toBe(1009);
  });

  it('startRelay 缺 token 拒绝启动', async () => {
    await expect(startRelay({ port: 0, token: '' })).rejects.toThrow('token');
  });

  it('CLI 参数解析：空格/= 两种形式 + 默认值 + 缺 token 留空（CLI 层拒绝）', () => {
    expect(parseCliArgs([])).toEqual({
      port: DEFAULT_RELAY_PORT,
      token: '',
      maxBufferFrames: DEFAULT_MAX_BUFFER_FRAMES,
    });
    expect(
      parseCliArgs([
        '--port',
        '8411',
        '--token',
        't',
        '--max-buffer-frames',
        '50',
      ]),
    ).toEqual({ port: 8411, token: 't', maxBufferFrames: 50 });
    expect(parseCliArgs(['--port=9', '--token=k'])).toEqual({
      port: 9,
      token: 'k',
      maxBufferFrames: DEFAULT_MAX_BUFFER_FRAMES,
    });
  });
});

/** 永不回调的假 socket：模拟对端不读、发送缓冲积压 */
class FakeSocket {
  sent: string[] = [];
  closeCode: number | undefined;
  /** true 时 send 立即回调 cb（模拟落盘确认，背压递减路径用） */
  flushOnSend = false;
  send(data: string, cb?: (err?: Error) => void): void {
    this.sent.push(data);
    if (cb && this.flushOnSend) cb();
  }
  close(code?: number): void {
    this.closeCode = code;
  }
}

describe('RelayRegistry 背压与转发容错（假 socket 单元级）', () => {
  it('积压帧超过 maxBufferFrames：拆对端连接(4002)不再发送', () => {
    const registry = new RelayRegistry(2);
    const server = new FakeSocket();
    const client = new FakeSocket();
    registry.registerServer('s1', server);
    expect(registry.attachClient('s1', client)).toBe(true);
    registry.forwardToServer('s1', { kind: 'req', id: 1 });
    registry.forwardToServer('s1', { kind: 'req', id: 2 });
    expect(server.closeCode).toBeUndefined();
    registry.forwardToServer('s1', { kind: 'req', id: 3 }); // 积压 3 > 2
    expect(server.closeCode).toBe(4002);
    expect(server.sent).toHaveLength(2);
  });

  it('发送回调确认落盘后积压递减：正常流量不误拆', () => {
    const registry = new RelayRegistry(2);
    const server = new FakeSocket();
    server.flushOnSend = true; // send 立即落盘
    const client = new FakeSocket();
    registry.registerServer('s1', server);
    registry.attachClient('s1', client);
    for (let i = 1; i <= 10; i++) {
      registry.forwardToServer('s1', { kind: 'req', id: i });
    }
    expect(server.closeCode).toBeUndefined();
    expect(server.sent).toHaveLength(10);
  });

  it('转发 send 抛错：拆连接不向外扩散（T2 F1）', () => {
    const registry = new RelayRegistry();
    const server = new FakeSocket();
    server.send = () => {
      throw new Error('socket dead');
    };
    const client = new FakeSocket();
    registry.registerServer('s1', server);
    registry.attachClient('s1', client);
    expect(() =>
      registry.forwardToServer('s1', { kind: 'req', id: 1 }),
    ).not.toThrow();
    expect(server.closeCode).toBe(1011);
  });

  it('同 connectionId 重复注册：旧连接被顶掉(4000 replaced)', () => {
    const registry = new RelayRegistry();
    const first = new FakeSocket();
    const second = new FakeSocket();
    registry.registerServer('s1', first);
    registry.registerServer('s1', second);
    expect(first.closeCode).toBe(4000);
    expect(registry.hasServer('s1')).toBe(true);
  });

  it('F1 dropServer 身份守卫：旧连接的 close 不清新注册、不误拆 client', () => {
    const registry = new RelayRegistry();
    const first = new FakeSocket();
    const second = new FakeSocket();
    const client = new FakeSocket();
    registry.registerServer('s1', first);
    registry.attachClient('s1', client);
    registry.registerServer('s1', second); // first 被顶掉(4000)
    registry.dropServer('s1', first, 'server-gone'); // 旧 ws 的 close 事件
    expect(registry.hasServer('s1')).toBe(true); // 新注册仍在
    expect(client.closeCode).toBeUndefined(); // client 未被误拆
    expect(client.sent).toHaveLength(0);
    registry.dropServer('s1', second, 'server-gone'); // 新连接真断开
    expect(client.closeCode).toBe(4003);
    expect(JSON.parse(client.sent[0])).toEqual({
      kind: 'close',
      connectionId: 's1',
      reason: 'server-gone',
    });
    expect(registry.hasServer('s1')).toBe(false);
  });
});

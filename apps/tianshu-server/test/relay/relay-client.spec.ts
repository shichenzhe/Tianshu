import WebSocket from 'ws';
import { INestApplication } from '@nestjs/common';
import { instanceId } from 'src/modules/info/info.controller';
import { EventBusService } from 'src/commons/event-bus/event-bus.service';
import { EventBusModule } from 'src/commons/event-bus/event-bus.module';
import { InfoModule } from 'src/modules/info/info.module';
import { SessionModule } from 'src/modules/session/session.module';
import { startRelay, type RelayHandle } from 'src/relay/relay-main';
import {
  resolveRelayLaunch,
  startHeadlessRelay,
  stopHeadlessRelay,
  stopRelayAndExit,
  type HeadlessRelayApp,
} from 'src/relay/relay-client';
import { createTestDb, type TestDb } from '../support/test-db';
import { createTestApp } from '../support/test-app';

/**
 * 无头端 relay 客户端 e2e（计划缺口补件）：本机起真 relay + 真 Nest app
 * （testing module，全拦截器/守卫链）——覆盖：
 * - register 后控制端（role=client）open 配对 → req 帧（session/query、
 *   session/create、GET info）经 fastify.inject 内部派发 → res 帧
 *   （starter 包装体 {code,success,data}）
 * - 应用层 ping → pong 应答（mirror ws-liveness 25s ping 依赖）
 * - EventBus publish → event 帧（Date→ISO 字符串，SSE wire 口径同构）
 * - Bearer 不匹配 → res 401 + code 4010 透传（控制端 invalid-token 判据）
 * - relay 重启 → 指数退避重连（1s 起）后重新 register 恢复服务
 */
const RELAY_TOKEN = 'relay-token';
const GUARD_TOKEN = 'guard-token';

jest.setTimeout(20_000);

interface TestFrame {
  kind: string;
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

function trackFrames(ws: WebSocket): TrackedSocket {
  const frames: TestFrame[] = [];
  const pending: {
    predicate: (frame: TestFrame) => boolean;
    resolve: (frame: TestFrame) => void;
    timer: NodeJS.Timeout;
  }[] = [];
  ws.on('message', (raw) => {
    let frame: TestFrame;
    try {
      frame = JSON.parse((raw as Buffer).toString()) as TestFrame;
    } catch {
      return;
    }
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
    waitForFrame(predicate, timeoutMs = 5000) {
      const hit = frames.find(predicate);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        pending.push({
          predicate,
          resolve,
          timer: setTimeout(() => {
            const index = pending.findIndex((item) => item.resolve === resolve);
            if (index >= 0) pending.splice(index, 1);
            reject(
              new Error(`waitForFrame 超时，已收帧: ${JSON.stringify(frames)}`),
            );
          }, timeoutMs),
        });
      });
    },
  };
}

/** 控制端（role=client）连 relay 并 open 配对到本进程 instanceId */
async function connectControl(port: number): Promise<TrackedSocket> {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws?role=client&token=${encodeURIComponent(RELAY_TOKEN)}`,
  );
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (error) => reject(error));
  });
  ws.send(JSON.stringify({ kind: 'open', connectionId: instanceId }));
  return trackFrames(ws);
}

function sendReq(
  control: TrackedSocket,
  id: number,
  method: string,
  path: string,
  body?: unknown,
): void {
  control.ws.send(JSON.stringify({ kind: 'req', id, method, path, body }));
}

describe('headless relay 客户端（真 relay + 真 Nest app）', () => {
  let app: INestApplication;
  // testing module 出来的 INestApplication（FastifyAdapter 实例）运行时带
  // inject——结构化断言交给 HeadlessRelayApp（名义类型不兼容处窄化）
  let relayApp: HeadlessRelayApp;
  let db: TestDb;
  let relay: RelayHandle;
  let relayPort: number;

  beforeAll(async () => {
    db = await createTestDb();
    const built = await createTestApp(db.prisma, [
      EventBusModule,
      InfoModule,
      SessionModule,
    ]);
    app = built.app;
    relayApp = built.app as unknown as HeadlessRelayApp;
    // StaticTokenGuard 请求期读 env：设 guard token 后 inject 需带正确 Bearer
    process.env.TIANSHU_TOKEN = GUARD_TOKEN;
    relay = await startRelay({ port: 0, token: RELAY_TOKEN });
    relayPort = relay.port;
    await startHeadlessRelay({
      app: relayApp,
      relayUrl: `ws://127.0.0.1:${relayPort}/ws`,
      relayToken: RELAY_TOKEN,
      bearerToken: GUARD_TOKEN,
      pingIntervalMs: 60_000,
    });
  });

  afterAll(async () => {
    stopHeadlessRelay();
    delete process.env.TIANSHU_TOKEN;
    await relay.close();
    await app.close();
    await db.cleanup();
  });

  it('open 配对后 session/query 走通：req 帧 → inject 派发 → res 包装体', async () => {
    const control = await connectControl(relayPort);
    try {
      sendReq(control, 1, 'POST', 'session/query', { page: 1 });
      const res = await control.waitForFrame(
        (f) => f.kind === 'res' && f.id === 1,
      );
      expect(res.status).toBe(200);
      const body = res.body as {
        code: string;
        success: boolean;
        data: { records: unknown[]; total: number };
      };
      expect(body.success).toBe(true);
      expect(body.code).toBe('2000');
      expect(Array.isArray(body.data.records)).toBe(true);
    } finally {
      control.ws.close();
    }
  });

  it('session/create 受理 + GET info 协商（路径前导斜杠归一）', async () => {
    const control = await connectControl(relayPort);
    try {
      sendReq(control, 2, 'POST', 'session/create', { title: 'relay 会话' });
      const create = await control.waitForFrame(
        (f) => f.kind === 'res' && f.id === 2,
      );
      expect(create.status).toBe(200);
      expect((create.body as { data: { title: string } }).data.title).toBe(
        'relay 会话',
      );

      sendReq(control, 3, 'GET', '/info');
      const info = await control.waitForFrame(
        (f) => f.kind === 'res' && f.id === 3,
      );
      expect(info.status).toBe(200);
      expect(
        (info.body as { data: { instanceId: string } }).data.instanceId,
      ).toBe(instanceId);
    } finally {
      control.ws.close();
    }
  });

  it('应用层 ping → pong 应答（控制端 ws-liveness 25s ping 依赖）', async () => {
    const control = await connectControl(relayPort);
    try {
      control.ws.send(JSON.stringify({ kind: 'ping' }));
      await control.waitForFrame((f) => f.kind === 'pong', 3000);
    } finally {
      control.ws.close();
    }
  });

  it('EventBus publish → event 帧（updatedAt 已 ISO 字符串，payload 原样透传）', async () => {
    const control = await connectControl(relayPort);
    try {
      app.get(EventBusService).publish({
        type: 'session.updated',
        payload: {
          id: 1,
          title: null,
          updatedAt: '2026-10-17T08:00:00.000Z',
          unreadCount: 0,
          lastMessage: null,
        },
      });
      const event = await control.waitForFrame(
        (f) => f.kind === 'event' && f.type === 'session.updated',
      );
      expect(event.payload).toEqual({
        id: 1,
        title: null,
        updatedAt: '2026-10-17T08:00:00.000Z',
        unreadCount: 0,
        lastMessage: null,
      });
    } finally {
      control.ws.close();
    }
  });

  it('Bearer 不匹配 → res 401 + code 4010 透传（invalid-token 判据）', async () => {
    stopHeadlessRelay();
    await startHeadlessRelay({
      app: relayApp,
      relayUrl: `ws://127.0.0.1:${relayPort}/ws`,
      relayToken: RELAY_TOKEN,
      bearerToken: 'wrong-token',
      pingIntervalMs: 60_000,
    });
    const control = await connectControl(relayPort);
    try {
      sendReq(control, 11, 'GET', 'info');
      const res = await control.waitForFrame(
        (f) => f.kind === 'res' && f.id === 11,
      );
      expect(res.status).toBe(401);
      expect((res.body as { code: string }).code).toBe('4010');
    } finally {
      control.ws.close();
      // 恢复正确 bearer 供后续用例
      stopHeadlessRelay();
      await startHeadlessRelay({
        app: relayApp,
        relayUrl: `ws://127.0.0.1:${relayPort}/ws`,
        relayToken: RELAY_TOKEN,
        bearerToken: GUARD_TOKEN,
        pingIntervalMs: 60_000,
      });
    }
  });

  it('relay 重启 → 退避重连后恢复 register 与请求服务', async () => {
    await relay.close();
    relay = await startRelay({ port: relayPort, token: RELAY_TOKEN });
    // 客户端 1s 退避起重连 → 重新 register；轮询新开控制端直至请求可用
    await pollUntil(
      async () => {
        try {
          const control = await connectControl(relayPort);
          try {
            sendReq(control, 21, 'GET', 'info');
            const res = await control.waitForFrame(
              (f) => f.kind === 'res' && f.id === 21,
              1500,
            );
            return res.status === 200;
          } finally {
            control.ws.close();
          }
        } catch {
          return false;
        }
      },
      10_000,
      300,
    );
  });
});

/** 异步谓词轮询等待（waitFor 只收同步断言，此处请求探活为异步） */
async function pollUntil(
  fn: () => Promise<boolean>,
  timeoutMs: number,
  stepMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error('pollUntil 超时');
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

describe('resolveRelayLaunch（CLI/环境驱动）', () => {
  it('CLI 优先于环境变量；两者齐备才返回（缺任一 null）', () => {
    expect(
      resolveRelayLaunch(['--relay-url', 'ws://cli/ws', '--relay-token=tok'], {
        TIANSHU_RELAY_URL: 'ws://env/ws',
        TIANSHU_RELAY_TOKEN: 'env-tok',
      }),
    ).toEqual({ relayUrl: 'ws://cli/ws', relayToken: 'tok' });

    expect(
      resolveRelayLaunch([], {
        TIANSHU_RELAY_URL: 'ws://env/ws',
        TIANSHU_RELAY_TOKEN: 'env-tok',
      }),
    ).toEqual({ relayUrl: 'ws://env/ws', relayToken: 'env-tok' });

    expect(
      resolveRelayLaunch([], { TIANSHU_RELAY_URL: 'ws://env/ws' }),
    ).toBeNull();
    expect(resolveRelayLaunch(['--relay-url', 'ws://only/ws'], {})).toBeNull();
    expect(resolveRelayLaunch([], {})).toBeNull();
  });
});

describe('stopRelayAndExit（relay 模式信号收口）', () => {
  const exitCalls: (number | undefined)[] = [];
  let exitSpy: jest.SpyInstance;

  beforeAll(() => {
    // process.exit 钉住不真退（测试进程保活）；退出码断言依赖调用记录
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation((code?: number) => {
        exitCalls.push(code);
        return undefined as never;
      });
  });

  afterAll(() => {
    exitSpy.mockRestore();
  });

  it('停 relay → app.close() → process.exit(0)；close 异常也保证退出', async () => {
    const close = jest.fn(() => Promise.resolve());
    await stopRelayAndExit({ close });
    expect(close).toHaveBeenCalledTimes(1);
    expect(exitCalls).toEqual([0]);

    // app.close() 抛错：仍要退出进程（否则首个 Ctrl-C 后进程存活——F2 原症状）
    exitCalls.length = 0;
    const brokenClose = jest.fn(() =>
      Promise.reject(new Error('close failed')),
    );
    await expect(
      stopRelayAndExit({ close: brokenClose }),
    ).resolves.toBeUndefined();
    expect(brokenClose).toHaveBeenCalledTimes(1);
    expect(exitCalls).toEqual([0]);
  });
});

import { WebSocket, WebSocketServer } from 'ws';
import {
  resolveRelayLaunch,
  startHeadlessRelay,
  stopHeadlessRelay,
  type HeadlessRelayApp,
  type RelayAkCredentials,
} from 'src/relay/relay-client';

/**
 * relay-client AK 凭证通道（Task 14，spec §5.4 消费侧）：
 * - AK 模式启动：ensureAccess 先于连接（未换到 access 不连 relay），
 *   首帧 auth token=access（Basic 头与 token 端点契约锁定）
 * - 启动网络失败 → 退避重试；401 → 干净启动失败（reject + 零连接）
 * - shouldRenew 真值 → 低频巡检换新 → 内存 access 更新（重连后的
 *   auth 帧读当前 access——getter 语义）；换新后 shouldRenew 假不再换
 * - 续期 401（AK 失效）→ 断开 relay + 粘滞不再重连 + 告警日志
 * - static token 与 AK 配置双存在 → static 优先零漂移（零 AK 请求）
 *
 * 网络面 mock：admin http 走 global fetch 拦截（web-tools.ts 同一全局
 * 依赖面）；relay 侧用裸 WebSocketServer 记帧（需观测客户端首帧 auth
 * 的 token 字段——真 relay 不回显对向 auth 帧，裸服务端是唯一观测点）。
 */
const DAY_MS = 86_400_000;
/** T12 契约：access TTL 30d（maxAgeSec 2592000） */
const MAX_AGE_SEC = 2_592_000;
const AK: RelayAkCredentials = {
  adminUrl: 'http://127.0.0.1:8412',
  akId: 'ak-id-1',
  akSecret: 'ak-secret-1',
};

jest.setTimeout(20_000);

interface TestFrame {
  kind: string;
  [key: string]: unknown;
}

interface TrackedServerConn {
  ws: WebSocket;
  frames: TestFrame[];
  closed: boolean;
  waitForFrame(
    predicate: (frame: TestFrame) => boolean,
    timeoutMs?: number,
  ): Promise<TestFrame>;
}

interface FakeRelay {
  port: number;
  connections: TrackedServerConn[];
  /** 服务端拆指定连接（模拟断线触发客户端重连退避） */
  cut(index: number): void;
  close(): Promise<void>;
}

/** 裸 relay 观测桩：收一切连接、记全部入站帧（auth/register/ping 等） */
async function startFakeRelay(
  onConnect?: () => void,
): Promise<FakeRelay> {
  const wss = new WebSocketServer({ port: 0 });
  const connections: TrackedServerConn[] = [];
  wss.on('connection', (ws) => {
    onConnect?.();
    const conn: TrackedServerConn = {
      ws,
      frames: [],
      closed: false,
      waitForFrame(predicate, timeoutMs = 5000) {
        const hit = conn.frames.find(predicate);
        if (hit) return Promise.resolve(hit);
        return new Promise((resolve, reject) => {
          const poll = setInterval(() => {
            const hit = conn.frames.find(predicate);
            if (!hit) return;
            clearInterval(poll);
            clearTimeout(timer);
            resolve(hit);
          }, 10);
          const timer = setTimeout(() => {
            clearInterval(poll);
            reject(
              new Error(
                `waitForFrame 超时，已收帧: ${JSON.stringify(conn.frames)}`,
              ),
            );
          }, timeoutMs);
        });
      },
    };
    connections.push(conn);
    ws.on('message', (raw) => {
      try {
        conn.frames.push(JSON.parse(String(raw)) as TestFrame);
      } catch {
        /* 坏帧不记 */
      }
    });
    ws.on('close', () => {
      conn.closed = true;
    });
  });
  await new Promise<void>((resolve) => wss.on('listening', () => resolve()));
  return {
    port: (wss.address() as { port: number }).port,
    connections,
    cut(index) {
      connections[index]?.ws.close(1011, 'server-cut');
    },
    close() {
      return new Promise<void>((resolve) => {
        for (const conn of connections) {
          try {
            conn.ws.terminate();
          } catch {
            /* 已关 */
          }
        }
        wss.close(() => resolve());
      });
    },
  };
}

/** inject/get 最小 app 面（本 spec 不触业务派发——EventBus 订阅桩即可） */
function fakeApp(): HeadlessRelayApp {
  return {
    inject: async () => ({ statusCode: 200, json: () => null, body: null }),
    get: () => ({ subscribe: () => () => undefined }),
  } as unknown as HeadlessRelayApp;
}

/** T12 token 端点成功响应（统一信封 {code,message,data} 三元组） */
function tokenOk(accessToken: string, expiresAt: number): Response {
  return {
    status: 200,
    ok: true,
    json: async () => ({
      code: '2000',
      success: true,
      message: '成功',
      data: { accessToken, expiresAt, maxAgeSec: MAX_AGE_SEC },
    }),
  } as unknown as Response;
}

/** 401 信封（RelayProtocolFilter 直出真状态码 + data.reason） */
function tokenUnauthorized(): Response {
  return {
    status: 401,
    ok: false,
    json: async () => ({
      code: '4010',
      success: false,
      data: { reason: 'disabled' },
      message: 'AK 已被禁用（或所属用户已被禁用）',
    }),
  } as unknown as Response;
}

function expectedBasicHeader(credentials: RelayAkCredentials): string {
  return `Basic ${Buffer.from(
    `${credentials.akId}:${credentials.akSecret}`,
  ).toString('base64')}`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** 异步谓词轮询等待 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  stepMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await sleep(stepMs);
  }
}

describe('relay-client AK 凭证通道', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    stopHeadlessRelay();
    fetchMock.mockRestore();
  });

  it('AK 模式启动：先换 access 再连 relay，首帧 auth token=access（端点与 Basic 头契约）', async () => {
    const sequence: string[] = [];
    const relay = await startFakeRelay(() => sequence.push('connect'));
    let resolveFetch!: (response: Response) => void;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = (response) => {
            sequence.push('access');
            resolve(response);
          };
        }),
    );
    const starting = startHeadlessRelay({
      app: fakeApp(),
      relayUrl: `ws://127.0.0.1:${relay.port}/ws`,
      ak: AK,
      pingIntervalMs: 60_000,
      deadAfterMs: 60_000,
      renewCheckIntervalMs: 60_000,
    });
    // 观察窗内零连接：未换到 access 不连 relay
    await sleep(150);
    expect(relay.connections).toHaveLength(0);
    resolveFetch(tokenOk('access-1', Date.now() + 30 * DAY_MS));
    await starting;
    // 顺序锁定：access → connect（连接因果在 access 之后）
    expect(sequence).toEqual(['access', 'connect']);
    const auth = await relay.connections[0].waitForFrame(
      (f) => f.kind === 'auth',
    );
    expect(auth.token).toBe('access-1');
    expect(auth.role).toBe('server');
    // T12 消费契约：POST {adminUrl}/relay-admin/token + Basic base64(akId:akSecret)
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://127.0.0.1:8412/relay-admin/token',
    );
    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({ method: 'POST' }),
    );
    expect(
      (fetchMock.mock.calls[0][1].headers as Record<string, string>)
        .authorization,
    ).toBe(expectedBasicHeader(AK));
    await relay.close();
  });

  it('启动换 access 网络失败 → 退避重试后成功才连（不持空 token 连接）', async () => {
    const relay = await startFakeRelay();
    fetchMock
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:8412'))
      .mockResolvedValueOnce(tokenOk('access-1', Date.now() + 30 * DAY_MS));
    await startHeadlessRelay({
      app: fakeApp(),
      relayUrl: `ws://127.0.0.1:${relay.port}/ws`,
      ak: AK,
      pingIntervalMs: 60_000,
      deadAfterMs: 60_000,
      akRetryBaseMs: 80,
      renewCheckIntervalMs: 60_000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const auth = await relay.connections[0].waitForFrame(
      (f) => f.kind === 'auth',
    );
    expect(auth.token).toBe('access-1');
    await relay.close();
  });

  it('启动 401（AK 失效）→ 干净启动失败：reject + 零连接 + 告警日志（无崩溃循环）', async () => {
    const relay = await startFakeRelay();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValue(tokenUnauthorized());
    await expect(
      startHeadlessRelay({
        app: fakeApp(),
        relayUrl: `ws://127.0.0.1:${relay.port}/ws`,
        ak: AK,
      }),
    ).rejects.toThrow(/AK 凭证失效/);
    await sleep(200);
    expect(relay.connections).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(
      '[relay-client] AK 凭证失效（disabled/expired），需运营方恢复或换发',
    );
    errorSpy.mockRestore();
    await relay.close();
  });

  it('shouldRenew 真值 → 巡检换新且内存 access 更新（重连后 auth 帧用新 token）；换新后不再换', async () => {
    const relay = await startFakeRelay();
    fetchMock
      // 剩 10d < 半寿 15d → shouldRenew 立即真
      .mockResolvedValueOnce(tokenOk('access-1', Date.now() + 10 * DAY_MS))
      // 换新后剩 30d > 15d → 不再触发
      .mockResolvedValueOnce(tokenOk('access-2', Date.now() + 30 * DAY_MS));
    await startHeadlessRelay({
      app: fakeApp(),
      relayUrl: `ws://127.0.0.1:${relay.port}/ws`,
      ak: AK,
      pingIntervalMs: 60_000,
      deadAfterMs: 60_000,
      renewCheckIntervalMs: 60,
    });
    expect(
      (await relay.connections[0].waitForFrame((f) => f.kind === 'auth')).token,
    ).toBe('access-1');
    // 60ms 巡检窗内触发换新
    await waitFor(() => fetchMock.mock.calls.length >= 2);
    // 新 access 半寿充足 → 后续巡检不再换
    await sleep(300);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 断线 → 重连 auth 帧读「当前」access（getter 语义，非启动时快照）
    relay.cut(0);
    await waitFor(() => relay.connections.length >= 2);
    const renewed = await relay.connections[1].waitForFrame(
      (f) => f.kind === 'auth',
    );
    expect(renewed.token).toBe('access-2');
    await relay.close();
  });

  it('续期 401（AK 失效）→ 断开 relay 且粘滞不再重连 + 告警日志', async () => {
    const relay = await startFakeRelay();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce(tokenOk('access-1', Date.now() + 10 * DAY_MS))
      .mockResolvedValue(tokenUnauthorized());
    await startHeadlessRelay({
      app: fakeApp(),
      relayUrl: `ws://127.0.0.1:${relay.port}/ws`,
      ak: AK,
      pingIntervalMs: 60_000,
      deadAfterMs: 60_000,
      renewCheckIntervalMs: 50,
    });
    await relay.connections[0].waitForFrame((f) => f.kind === 'auth');
    // 客户端粘滞拆链（close 到达服务端）
    await waitFor(() => relay.connections[0].closed);
    // 跨过两轮重连退避窗（1s + 2s）仍零新连接——不重连
    await sleep(3_500);
    expect(relay.connections).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalledWith(
      '[relay-client] AK 凭证失效（disabled/expired），需运营方恢复或换发',
    );
    errorSpy.mockRestore();
    await relay.close();
  });

  it('static token 与 AK 双存在 → static 优先零漂移：auth 用 static token、零 AK 请求', async () => {
    // 解析层：static 在场即纯 static（AK env 全在也不挂 ak）
    const launch = resolveRelayLaunch([], {
      TIANSHU_RELAY_URL: 'ws://static/ws',
      TIANSHU_RELAY_TOKEN: 'static-tok',
      TIANSHU_RELAY_ADMIN_URL: 'http://admin',
      TIANSHU_RELAY_AK_ID: 'env-ak-id',
      TIANSHU_RELAY_AK_SECRET: 'env-ak-secret',
    });
    expect(launch).toEqual({
      relayUrl: 'ws://static/ws',
      relayToken: 'static-tok',
    });
    // 装配层：options.relayToken 在场时即使 ak 同传也整体旁路
    const relay = await startFakeRelay();
    fetchMock.mockImplementation(() => {
      throw new Error('static 模式不应发起 AK 请求');
    });
    await startHeadlessRelay({
      app: fakeApp(),
      relayUrl: `ws://127.0.0.1:${relay.port}/ws`,
      relayToken: 'static-tok',
      ak: AK,
      pingIntervalMs: 60_000,
    });
    const auth = await relay.connections[0].waitForFrame(
      (f) => f.kind === 'auth',
    );
    expect(auth.token).toBe('static-tok');
    expect(fetchMock).not.toHaveBeenCalled();
    await relay.close();
  });
});

describe('resolveRelayLaunch（AK 链——CLI 优先 env、三要素齐备）', () => {
  it('无 static token 时 AK 三要素齐备 → AK 模式（CLI 逐参优先于 env）', () => {
    expect(
      resolveRelayLaunch(
        [
          '--relay-url',
          'ws://cli/ws',
          '--relay-admin-url',
          'http://cli:8412',
          '--relay-ak-id=cli-ak',
          '--relay-ak-secret=cli-secret',
        ],
        {
          TIANSHU_RELAY_ADMIN_URL: 'http://env:8412',
          TIANSHU_RELAY_AK_ID: 'env-ak',
          TIANSHU_RELAY_AK_SECRET: 'env-secret',
        },
      ),
    ).toEqual({
      relayUrl: 'ws://cli/ws',
      ak: {
        adminUrl: 'http://cli:8412',
        akId: 'cli-ak',
        akSecret: 'cli-secret',
      },
    });
    expect(
      resolveRelayLaunch([], {
        TIANSHU_RELAY_URL: 'ws://env/ws',
        TIANSHU_RELAY_ADMIN_URL: 'http://env:8412',
        TIANSHU_RELAY_AK_ID: 'env-ak',
        TIANSHU_RELAY_AK_SECRET: 'env-secret',
      }),
    ).toEqual({
      relayUrl: 'ws://env/ws',
      ak: {
        adminUrl: 'http://env:8412',
        akId: 'env-ak',
        akSecret: 'env-secret',
      },
    });
  });

  it('AK 三要素缺一 → null（不半启动）；static token 与 AK 混布（env static + CLI AK）→ static 优先', () => {
    expect(
      resolveRelayLaunch([], {
        TIANSHU_RELAY_URL: 'ws://env/ws',
        TIANSHU_RELAY_ADMIN_URL: 'http://env:8412',
        TIANSHU_RELAY_AK_ID: 'env-ak',
      }),
    ).toBeNull();
    expect(
      resolveRelayLaunch(
        [
          '--relay-admin-url',
          'http://cli:8412',
          '--relay-ak-id=cli-ak',
          '--relay-ak-secret=cli-secret',
        ],
        {
          TIANSHU_RELAY_URL: 'ws://env/ws',
          TIANSHU_RELAY_TOKEN: 'env-static-tok',
        },
      ),
    ).toEqual({
      relayUrl: 'ws://env/ws',
      relayToken: 'env-static-tok',
    });
  });
});

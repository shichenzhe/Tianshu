import WebSocket from 'ws';
import { INestApplication } from '@nestjs/common';
import { instanceId } from 'src/modules/info/info.controller';
import { EventBusService } from 'src/commons/event-bus/event-bus.service';
import { EventBusModule } from 'src/commons/event-bus/event-bus.module';
import { InfoModule } from 'src/modules/info/info.module';
import { PrismaModule } from 'src/commons/database/prisma.module';
import { startRelay, type RelayHandle } from 'src/relay/relay-main';
import {
  startHeadlessRelay,
  stopHeadlessRelay,
  type HeadlessRelayApp,
} from 'src/relay/relay-client';
import {
  E2E_SECURE_KIND,
  createE2ESession,
  deriveSessionKeys,
  fingerprintOf,
  generateEphemeralPair,
  type E2ESecureEnvelope,
  type E2ESession,
} from '@tianshu/core';
import { createTestDb, type TestDb } from '../support/test-db';
import { createTestApp } from '../support/test-app';

/**
 * 无头端 relay E2E（spec 2026-10-18-relay-e2e §3.2，E2E-T2）：mirror
 * server-face relay-e2e.test.ts 的对偶最小面——本机真 relay + 真 Nest app，
 * 控制端替身走完整握手与信封通道：
 * - e2e-hello（临时公钥）→ e2e-ack（静态公钥+指纹）→ 密文 req → inject
 *   派发 → 密文 res 解封（wire 无明文断言）
 * - 静态密钥落 option 表（tianshu.relay/e2eKey）；重启 relay 客户端同静态
 *   公钥重新握手（密钥持久化）
 * - e2e=required：明文业务帧被拒（断开，无 res）
 * - 重放相同 hello 被忽略（会话不重置）+ 其后重放旧密文 req 被拒（EE 终审 F1）
 */
const RELAY_TOKEN = 'relay-token';
const E2E_OPTION = { type: 'tianshu.relay', name: 'e2eKey' };

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

/** 控制端视角握手（mirror 侧对偶）：hello 临时公钥 → ack 静态公钥+指纹 */
async function shakeHands(
  control: TrackedSocket,
): Promise<{ session: E2ESession; staticKey: string; fingerprint: string }> {
  const ephemeral = generateEphemeralPair();
  control.ws.send(
    JSON.stringify({
      kind: 'e2e-hello',
      ephemeralKey: ephemeral.publicKey.toString('base64'),
    }),
  );
  const ack = await control.waitForFrame((f) => f.kind === 'e2e-ack');
  const staticKey = ack.staticKey as string;
  const fingerprint = ack.fingerprint as string;
  expect(fingerprintOf(staticKey)).toBe(fingerprint);
  const keys = deriveSessionKeys({
    ephemeralPrivateKey: ephemeral.privateKey,
    staticPublicKey: Buffer.from(staticKey, 'base64'),
    connectionId: instanceId,
  });
  return {
    session: createE2ESession(keys, 'client'),
    staticKey,
    fingerprint,
  };
}

function sendSealed(
  control: TrackedSocket,
  session: E2ESession,
  frame: unknown,
): void {
  control.ws.send(JSON.stringify(session.seal(JSON.stringify(frame))));
}

function openSealed(
  session: E2ESession,
  frame: TestFrame,
): Record<string, unknown> {
  expect(frame.kind).toBe(E2E_SECURE_KIND);
  return JSON.parse(
    session.open(frame as unknown as E2ESecureEnvelope).toString('utf8'),
  ) as Record<string, unknown>;
}

function waitClosed(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => ws.once('close', () => resolve()));
}

describe('headless relay E2E（真 relay + 真 Nest app）', () => {
  let app: INestApplication;
  let relayApp: HeadlessRelayApp;
  let db: TestDb;
  let relay: RelayHandle;
  let relayPort: number;

  beforeAll(async () => {
    db = await createTestDb();
    const built = await createTestApp(db.prisma, [
      PrismaModule,
      EventBusModule,
      InfoModule,
    ]);
    app = built.app;
    relayApp = built.app as unknown as HeadlessRelayApp;
    relay = await startRelay({ port: 0, token: RELAY_TOKEN });
    relayPort = relay.port;
    await startHeadlessRelay({
      app: relayApp,
      relayUrl: `ws://127.0.0.1:${relayPort}/ws`,
      relayToken: RELAY_TOKEN,
      pingIntervalMs: 60_000,
    });
  });

  afterAll(async () => {
    stopHeadlessRelay();
    await relay.close();
    await app.close();
    await db.cleanup();
  });

  it('握手往返：hello→ack→密文 req→res（wire 无明文）；静态密钥落 option 表', async () => {
    const control = await connectControl(relayPort);
    try {
      const { session, staticKey, fingerprint } = await shakeHands(control);
      expect(staticKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
      expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);

      sendSealed(control, session, {
        kind: 'req',
        id: 1,
        method: 'GET',
        path: '/info',
      });
      const rawRes = await control.waitForFrame(
        (f) => f.kind === E2E_SECURE_KIND,
      );
      // wire 零明文断言：密文帧不含业务哨兵（relay 只见密文）
      expect(JSON.stringify(rawRes)).not.toContain('info');
      const res = openSealed(session, rawRes);
      expect(res).toMatchObject({ kind: 'res', id: 1, status: 200 });
      expect(
        (res.body as { data: { instanceId: string } }).data.instanceId,
      ).toBe(instanceId);

      const optionRow = await db.prisma.option.findFirst({
        where: E2E_OPTION,
      });
      expect(optionRow?.value).toMatch(/^tianshu-e2e-static-v1:/);
    } finally {
      control.ws.close();
    }
  });

  it('重启 relay 客户端：同静态公钥重新握手（静态对持久）', async () => {
    const first = await connectControl(relayPort);
    const firstHandshake = await shakeHands(first);
    first.ws.close();

    stopHeadlessRelay();
    await startHeadlessRelay({
      app: relayApp,
      relayUrl: `ws://127.0.0.1:${relayPort}/ws`,
      relayToken: RELAY_TOKEN,
      pingIntervalMs: 60_000,
    });

    const second = await connectControl(relayPort);
    try {
      const secondHandshake = await shakeHands(second);
      expect(secondHandshake.staticKey).toBe(firstHandshake.staticKey);
      expect(secondHandshake.fingerprint).toBe(firstHandshake.fingerprint);
    } finally {
      second.ws.close();
    }
  });

  it('e2e=required：明文业务帧被拒（断开，无 res）', async () => {
    stopHeadlessRelay();
    await startHeadlessRelay({
      app: relayApp,
      relayUrl: `ws://127.0.0.1:${relayPort}/ws`,
      relayToken: RELAY_TOKEN,
      e2eMode: 'required',
      pingIntervalMs: 60_000,
    });

    const control = await connectControl(relayPort);
    try {
      const closed = waitClosed(control.ws);
      control.ws.send(
        JSON.stringify({ kind: 'req', id: 2, method: 'GET', path: '/info' }),
      );
      await closed;
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(control.frames.some((f) => f.kind === 'res')).toBe(false);
    } finally {
      control.ws.close();
    }
  });

  it('e2e=required 未握手：出站 event 帧被丢弃（零明文 wire，连接不拆）', async () => {
    // 显式重启（上一用例 forceReconnect 后本处仍在 1s 退避窗内——重启即
    // 换新连接，与「required 拒明文」用例同款装配消除竞态）
    stopHeadlessRelay();
    await startHeadlessRelay({
      app: relayApp,
      relayUrl: `ws://127.0.0.1:${relayPort}/ws`,
      relayToken: RELAY_TOKEN,
      e2eMode: 'required',
      pingIntervalMs: 60_000,
    });

    const control = await connectControl(relayPort);
    try {
      app.get(EventBusService).publish({
        type: 'session.updated',
        payload: { id: 1, title: null, updatedAt: '2026-10-18T08:00:00.000Z', unreadCount: 0, lastMessage: null },
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(control.frames.some((f) => f.kind === 'event')).toBe(false);
      expect(control.ws.readyState).toBe(control.ws.OPEN);
    } finally {
      control.ws.close();
    }
  });

  it('重放相同 hello 被忽略：会话不重置，其后重放旧密文 req 被拒（EE 终审 F1）', async () => {
    // 前一用例装配为 required——重启回 auto 消除装配耦合
    stopHeadlessRelay();
    await startHeadlessRelay({
      app: relayApp,
      relayUrl: `ws://127.0.0.1:${relayPort}/ws`,
      relayToken: RELAY_TOKEN,
      pingIntervalMs: 60_000,
    });

    const control = await connectControl(relayPort);
    try {
      // 控制端握手（持住临时钥，以便其后字节级重放同一 hello）
      const ephemeral = generateEphemeralPair();
      const helloFrame = JSON.stringify({
        kind: 'e2e-hello',
        ephemeralKey: ephemeral.publicKey.toString('base64'),
      });
      control.ws.send(helloFrame);
      const ack = await control.waitForFrame((f) => f.kind === 'e2e-ack');
      const session = createE2ESession(
        deriveSessionKeys({
          ephemeralPrivateKey: ephemeral.privateKey,
          staticPublicKey: Buffer.from(ack.staticKey as string, 'base64'),
          connectionId: instanceId,
        }),
        'client',
      );

      // 首次密文 req 正常往返（计数器 1 进真实会话重放窗）
      const sealedReq = session.seal(
        JSON.stringify({ kind: 'req', id: 3, method: 'GET', path: '/info' }),
      );
      control.ws.send(JSON.stringify(sealedReq));
      const rawRes = await control.waitForFrame(
        (f) => f.kind === E2E_SECURE_KIND,
      );
      expect(openSealed(session, rawRes)).toMatchObject({
        kind: 'res',
        id: 3,
        status: 200,
      });

      // 重放字节相同的 hello：被忽略（无第二个 ack=会话未重置；连接不拆）
      control.ws.send(helloFrame);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(control.frames.filter((f) => f.kind === 'e2e-ack').length).toBe(1);
      expect(control.ws.readyState).toBe(control.ws.OPEN);

      // 其后重放旧密文 req（同 nonce 计数器，窗口内已见）→ 重放拒断开；
      // 若 hello 重放重置了会话，此处会产出第二个 id=3 res（重执行面）
      const closed = waitClosed(control.ws);
      control.ws.send(JSON.stringify(sealedReq));
      await closed;
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(
        control.frames.filter((f) => f.kind === E2E_SECURE_KIND).length,
      ).toBe(1);
    } finally {
      control.ws.close();
    }
  });
});

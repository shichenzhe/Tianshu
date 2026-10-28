// T7 e2e：POST session/send（202 受理 + EventBus 事件流）、POST session/abort、
// GET /event SSE 事件桥；另含 T6 顺手修 M1（@@map 表名）/M2（技能 enabled
// 过滤）/M3（deleteProtection config 化）各一条用例。
// fake model 经 CHAT_RUNNER_DEPS 注入点（T6 scripted-chat-model）。
import request from 'supertest';
import * as http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { INestApplication } from '@nestjs/common';
import { ChatCoreModule } from 'src/core/chat-core.module';
import { CHAT_RUNNER_DEPS } from 'src/core/chat-runner.service';
import { EventModule } from 'src/modules/event/event.module';
import { encodeSseFrame } from 'src/modules/event/event.controller';
import { SessionModule } from 'src/modules/session/session.module';
import { EventBusModule } from 'src/commons/event-bus/event-bus.module';
import { EventBusService } from 'src/commons/event-bus/event-bus.service';
import type { ServerEvent } from '@tianshu/protocol';
import { createTestDb, type TestDb } from '../support/test-db';
import { createTestApp, WrappedBody } from '../support/test-app';
import { waitFor } from '../support/wait-for';
import { makeDirs, makeRunner, seedSession } from '../support/chat-fixture';
import {
  HangingChatModel,
  ScriptedChatModel,
} from '../helpers/scripted-chat-model';

/** SSE 帧（`event: <type>\ndata: <json>\n\n`）解析结果 */
interface SseFrame {
  event: string;
  data: Record<string, unknown>;
}

function parseFrame(frame: string): SseFrame {
  const lines = frame.split('\n');
  if (lines[0]?.startsWith('event: ') && lines[1]?.startsWith('data: ')) {
    return {
      event: lines[0].slice('event: '.length),
      data: JSON.parse(lines[1].slice('data: '.length)) as Record<
        string,
        unknown
      >,
    };
  }
  throw new Error(`非法 SSE 帧格式: ${JSON.stringify(frame)}`);
}

describe('session/send + abort + SSE (e2e)', () => {
  let app: INestApplication;
  let server: http.Server;
  let db: TestDb;
  let baseUrl: string;
  let bus: EventBusService;
  /** 每用例置换的假模型（modelFactory 实时取引用） */
  let activeModel: ScriptedChatModel;
  /** modelFactory 收到的 SDK 模型标识序列（请求级模型选择断言用） */
  let factoryModelIds: string[];
  /** EventBus 全量事件序列（每用例清零重收） */
  let events: ServerEvent[];
  let unsubscribe: () => void;

  beforeAll(async () => {
    db = await createTestDb();
    activeModel = new ScriptedChatModel([]);
    const built = await createTestApp(
      db.prisma,

      // EventBusModule 为全局模块但需被实例化（AppModule 侧同款导入）
      [EventBusModule, SessionModule, ChatCoreModule, EventModule],
      (builder) =>
        builder.overrideProvider(CHAT_RUNNER_DEPS).useValue({
          modelFactory: (_provider, modelId) => {
            factoryModelIds.push(modelId);
            return activeModel;
          },
          config: () => ({
            dataRoot: db.dataRoot,
            allowDangerousTools: false,
            deleteProtection: true,
            accessMode: 'default',
          }),
        }),
    );
    app = built.app;
    server = built.server;
    bus = app.get(EventBusService);
    events = [];
    factoryModelIds = [];
    unsubscribe = bus.subscribe((event) => events.push(event));
    // SSE 用例需常驻监听（supertest 逐请求起停，不适合永不结束的流）
    await app.listen(0);
    baseUrl = await app.getUrl();
  }, 120_000);

  afterAll(async () => {
    unsubscribe();
    await app.close();
    await db.cleanup();
  });

  const post = (path: string, body?: Record<string, unknown>): request.Test =>
    request(server)
      .post(path)
      .send(body ?? {});

  /** 该会话的 message.chunk 事件（按到达序） */
  const chunkEvents = (sessionId: number) =>
    events.filter(
      (event): event is Extract<ServerEvent, { type: 'message.chunk' }> =>
        event.type === 'message.chunk' && event.payload.sessionId === sessionId,
    );

  describe('POST /session/send', () => {
    it('202 受理：chunk 序列 text-delta…finish → session.updated，assistant 落库', async () => {
      const { session } = await seedSession(db, makeDirs());
      activeModel = new ScriptedChatModel([
        {
          steps: [
            { kind: 'text', delta: '你好' },
            { kind: 'text', delta: '！' },
          ],
          usage: { input: 4, output: 6 },
        },
      ]);
      events.length = 0;

      const res = await post('/session/send', {
        sessionId: session.id,
        content: '打个招呼',
      }).expect(202);
      expect((res.body as WrappedBody<{ accepted: boolean }>).data).toEqual({
        accepted: true,
      });

      await waitFor(() =>
        expect(events.some((event) => event.type === 'session.updated')).toBe(
          true,
        ),
      );

      // 事件序列：text-delta…→ finish 收尾 chunk；session.updated 殿后；无 session.error
      const chunks = chunkEvents(session.id).map(
        (event) => event.payload.chunk,
      );
      expect(chunks).toEqual([
        { type: 'text-delta', text: '你好' },
        { type: 'text-delta', text: '！' },
        { type: 'finish' },
      ]);
      const updated = events[events.length - 1] as Extract<
        ServerEvent,
        { type: 'session.updated' }
      >;
      expect(updated.type).toBe('session.updated');
      expect(updated.payload.id).toBe(session.id);
      // wire 口径（RC-T2，协议包 ServerEvent 定义）：publish 边界已
      // Date→ISO 字符串，SSE/relay 序列化层原样透传
      expect(typeof updated.payload.updatedAt).toBe('string');
      expect(updated.payload.updatedAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
      expect(events.some((event) => event.type === 'session.error')).toBe(
        false,
      );

      const messages = await db.prisma.messageRecord.findMany({
        where: { sessionId: session.id },
        orderBy: { id: 'asc' },
      });
      expect(messages).toHaveLength(2);
      expect(JSON.parse(messages[1].blocks)).toEqual([
        { type: 'text', text: '你好！' },
        { type: 'usage', input: 4, output: 6 },
      ]);
      // P1 未读角标批：enriched payload——NULL 游标全计（1 条 assistant）+
      // 末条摘要（id/role/kind/text 为 summarizeLastMessage 口径）
      expect(updated.payload.unreadCount).toBe(1);
      expect(updated.payload.lastMessage).toEqual({
        id: messages[1].id,
        role: 'assistant',
        kind: 'text',
        text: '你好！',
        createdAt: messages[1].createdAt.toISOString(),
      });
    });

    it('请求级 modelId 覆盖会话当前模型：写回 currentModelId 且本轮即用（照 assistantId 先例）', async () => {
      const { session, model } = await seedSession(db, makeDirs());
      // 同 provider 另建一模型（SDK 标识不同）；会话当前值仍指 seed 模型
      const seedRow = await db.prisma.model.findUnique({
        where: { id: model.id },
      });
      const override = await db.prisma.model.create({
        data: {
          providerId: seedRow!.providerId,
          modelId: 'override-model',
          name: '请求级模型',
          contextWindow: 8192,
        },
      });
      activeModel = new ScriptedChatModel([
        { steps: [{ kind: 'text', delta: 'ok' }] },
      ]);
      factoryModelIds.length = 0;
      events.length = 0;

      await post('/session/send', {
        sessionId: session.id,
        content: 'hi',
        modelId: override.id,
      }).expect(202);
      await waitFor(() =>
        expect(events.some((event) => event.type === 'session.updated')).toBe(
          true,
        ),
      );

      // 写回会话当前值（会话记住上次选择）
      const after = await db.prisma.sessionRecord.findUnique({
        where: { id: session.id },
      });
      expect(after?.currentModelId).toBe(override.id);
      // 本轮即用请求级模型：工厂收到覆盖模型的 SDK 标识，而非会话当前模型
      expect(factoryModelIds).toContain('override-model');
      expect(factoryModelIds).not.toContain('test-model');
      // assistant 消息行落覆盖模型 id
      const assistant = await db.prisma.messageRecord.findFirst({
        where: { sessionId: session.id, role: 'assistant' },
      });
      expect(assistant?.modelId).toBe(override.id);
    });

    it('会话不存在：业务错 HTTP 200 + code 4040（不启动流）', async () => {
      const res = await post('/session/send', {
        sessionId: 999999,
        content: 'hi',
      }).expect(200);
      const body = res.body as WrappedBody<null>;
      expect(body.success).toBe(false);
      expect(body.code).toBe('4040');
    });

    it('未配模型：202 后经 session.error 事件回传 NO_MODEL（含配置提示文案）', async () => {
      // 兜底链存在后 NO_MODEL 需全库无启用模型（此前用例 seed 的已禁用）
      await db.prisma.model.updateMany({ data: { enabled: false } });
      const workspace = await db.prisma.workspace.create({
        data: { name: 'empty-ws', userId: 1 },
      });
      const session = await db.prisma.sessionRecord.create({
        data: { workspaceId: workspace.id, title: 't', userId: 1 },
      });
      events.length = 0;

      await post('/session/send', {
        sessionId: session.id,
        content: 'hi',
      }).expect(202);

      await waitFor(() =>
        expect(events.some((event) => event.type === 'session.error')).toBe(
          true,
        ),
      );
      const error = events.find(
        (event): event is Extract<ServerEvent, { type: 'session.error' }> =>
          event.type === 'session.error',
      )!;
      expect(error.payload.sessionId).toBe(session.id);
      expect(error.payload.code).toBe('NO_MODEL');
      expect(error.payload.message).toContain('provider/save');
    });
  });

  describe('POST /session/regenerate', () => {
    it('重生成最后一条 assistant：替换该消息（user 行不增），chunk/updated 事件同构', async () => {
      const { session } = await seedSession(db, makeDirs());
      activeModel = new ScriptedChatModel([
        {
          steps: [
            { kind: 'text', delta: '第一版回复' },
          ],
          usage: { input: 3, output: 5 },
        },
      ]);
      await post('/session/send', {
        sessionId: session.id,
        content: '写一句',
      }).expect(202);
      await waitFor(() =>
        expect(events.some((event) => event.type === 'session.updated')).toBe(
          true,
        ),
      );
      const before = await db.prisma.messageRecord.findMany({
        where: { sessionId: session.id },
        orderBy: { id: 'asc' },
      });
      expect(before).toHaveLength(2);

      // 第二版脚本 + 重生成
      activeModel = new ScriptedChatModel([
        {
          steps: [
            { kind: 'text', delta: '第二版回复' },
          ],
          usage: { input: 3, output: 7 },
        },
      ]);
      events.length = 0;
      const res = await post('/session/regenerate', {
        sessionId: session.id,
      }).expect(202);
      expect(
        (res.body as WrappedBody<{ accepted: boolean }>).data,
      ).toEqual({ accepted: true });
      await waitFor(() =>
        expect(
          events.filter((event) => event.type === 'session.updated').length,
        ).toBe(1),
      );

      // user 行原样保留（无新增），assistant 原位替换
      const after = await db.prisma.messageRecord.findMany({
        where: { sessionId: session.id },
        orderBy: { id: 'asc' },
      });
      expect(after).toHaveLength(2);
      expect(after[0].id).toBe(before[0].id);
      expect(after[0].role).toBe('user');
      expect(after[1].id).toBeGreaterThan(before[1].id);
      expect(JSON.parse(after[1].blocks)[0]).toEqual({
        type: 'text',
        text: '第二版回复',
      });
      // P1 未读角标批：重生成链收尾 enriched payload（摘要指向新 assistant 行）
      const updatedEvent = events.find(
        (event) => event.type === 'session.updated',
      ) as Extract<ServerEvent, { type: 'session.updated' }>;
      expect(updatedEvent.payload.unreadCount).toBe(1);
      expect(updatedEvent.payload.lastMessage).toMatchObject({
        id: after[1].id,
        role: 'assistant',
        kind: 'text',
        text: '第二版回复',
      });
    });

    it('指定 messageId 重生成中间回复：其后全部截断；非 assistant 消息 202 后 session.error', async () => {
      const { session } = await seedSession(db, makeDirs());
      // 第一轮（照用例 1 模式：waitFor session.updated 再进下一轮）
      activeModel = new ScriptedChatModel([
        {
          steps: [{ kind: 'text', delta: '第1轮回复' }],
          usage: { input: 2, output: 3 },
        },
      ]);
      events.length = 0;
      await post('/session/send', {
        sessionId: session.id,
        content: '第1轮问题',
      }).expect(202);
      await waitFor(() =>
        expect(events.some((event) => event.type === 'session.updated')).toBe(
          true,
        ),
      );
      // 第二轮
      activeModel = new ScriptedChatModel([
        {
          steps: [{ kind: 'text', delta: '第2轮回复' }],
          usage: { input: 2, output: 3 },
        },
      ]);
      events.length = 0;
      await post('/session/send', {
        sessionId: session.id,
        content: '第2轮问题',
      }).expect(202);
      await waitFor(() =>
        expect(events.some((event) => event.type === 'session.updated')).toBe(
          true,
        ),
      );
      const four = await db.prisma.messageRecord.findMany({
        where: { sessionId: session.id },
        orderBy: { id: 'asc' },
      });
      expect(four.map((r) => r.role)).toEqual([
        'user',
        'assistant',
        'user',
        'assistant',
      ]);

      // 指定第 1 轮 assistant 重生成：第 2 轮 user+assistant 均被截断
      const firstAssistant = four.find((r) => r.role === 'assistant')!;
      activeModel = new ScriptedChatModel([
        {
          steps: [{ kind: 'text', delta: '重写第1轮' }],
          usage: { input: 2, output: 3 },
        },
      ]);
      events.length = 0;
      await post('/session/regenerate', {
        sessionId: session.id,
        messageId: firstAssistant.id,
      }).expect(202);
      await waitFor(() =>
        expect(events.some((event) => event.type === 'session.updated')).toBe(
          true,
        ),
      );
      const truncated = await db.prisma.messageRecord.findMany({
        where: { sessionId: session.id },
        orderBy: { id: 'asc' },
      });
      expect(truncated).toHaveLength(2);
      expect(JSON.parse(truncated[1].blocks)[0]).toEqual({
        type: 'text',
        text: '重写第1轮',
      });

      // messageId 指向 user 行：受理后经 session.error 回传
      events.length = 0;
      await post('/session/regenerate', {
        sessionId: session.id,
        messageId: truncated[0].id,
      }).expect(202);
      await waitFor(() =>
        expect(events.some((event) => event.type === 'session.error')).toBe(
          true,
        ),
      );
      const err = events.find((event) => event.type === 'session.error') as
        | Extract<ServerEvent, { type: 'session.error' }>
        | undefined;
      expect(err?.payload.code).toBe('MESSAGE_NOT_FOUND');
    });
  });

  describe('POST /session/editAndResend 与 /session/accessMode（CU 批）', () => {
    it('editAndResend：改写 user 行文本并截断其后重跑', async () => {
      const { session } = await seedSession(db, makeDirs());
      activeModel = new ScriptedChatModel([
        {
          steps: [{ kind: 'text', delta: '原回复' }],
          usage: { input: 2, output: 3 },
        },
      ]);
      events.length = 0;
      await post('/session/send', {
        sessionId: session.id,
        content: '原问题',
      }).expect(202);
      await waitFor(() =>
        expect(events.some((e) => e.type === 'session.updated')).toBe(true),
      );
      const two = await db.prisma.messageRecord.findMany({
        where: { sessionId: session.id },
        orderBy: { id: 'asc' },
      });
      expect(two).toHaveLength(2);

      activeModel = new ScriptedChatModel([
        {
          steps: [{ kind: 'text', delta: '新回复' }],
          usage: { input: 2, output: 3 },
        },
      ]);
      events.length = 0;
      await post('/session/editAndResend', {
        sessionId: session.id,
        messageId: two[0].id,
        content: '改写后的问题',
      }).expect(202);
      await waitFor(() =>
        expect(events.some((e) => e.type === 'session.updated')).toBe(true),
      );
      const after = await db.prisma.messageRecord.findMany({
        where: { sessionId: session.id },
        orderBy: { id: 'asc' },
      });
      // user 行原位改写（id 不变）+ 尾部截断重跑（2 行）
      expect(after).toHaveLength(2);
      expect(after[0].id).toBe(two[0].id);
      expect(JSON.parse(after[0].blocks)).toEqual([
        { type: 'text', text: '改写后的问题' },
      ]);
      expect(JSON.parse(after[1].blocks)[0]).toEqual({
        type: 'text',
        text: '新回复',
      });
      // P1 未读角标批：编辑重发链收尾 enriched payload（摘要指向重跑后的
      // assistant 行；user 行原位改写不产生未读）
      const updatedEvent = events.find(
        (event) => event.type === 'session.updated',
      ) as Extract<ServerEvent, { type: 'session.updated' }>;
      expect(updatedEvent.payload.unreadCount).toBe(1);
      expect(updatedEvent.payload.lastMessage).toMatchObject({
        id: after[1].id,
        role: 'assistant',
        kind: 'text',
        text: '新回复',
      });
    });

    it('accessMode：缺省查询 default；携带即设置回读 full', async () => {
      const { session } = await seedSession(db, makeDirs());
      const got = (await post('/session/accessMode', {
        sessionId: session.id,
      }).expect(200)).body as WrappedBody<{ mode: string }>;
      expect(got.data.mode).toBe('default');

      const set = (await post('/session/accessMode', {
        sessionId: session.id,
        mode: 'full',
      }).expect(200)).body as WrappedBody<{ mode: string }>;
      expect(set.data.mode).toBe('full');
    });
  });

  describe('POST /session/abort', () => {
    it('中止进行中的流：aborted true → 流收尾（finish chunk + session.updated），再 abort 返回 false', async () => {
      const { session } = await seedSession(db, makeDirs());
      activeModel = new HangingChatModel();
      events.length = 0;

      await post('/session/send', {
        sessionId: session.id,
        content: 'hi',
      }).expect(202);
      await waitFor(() => expect(activeModel.calls).toBeGreaterThan(0));

      const res = await post('/session/abort', {
        sessionId: session.id,
      }).expect(200);
      expect((res.body as WrappedBody<{ aborted: boolean }>).data).toEqual({
        aborted: true,
      });

      // 中止后流收尾不悬挂：finish chunk + session.updated，无 session.error
      await waitFor(() =>
        expect(events.some((event) => event.type === 'session.updated')).toBe(
          true,
        ),
      );
      expect(
        chunkEvents(session.id).some(
          (event) =>
            (event.payload.chunk as { type: string }).type === 'finish',
        ),
      ).toBe(true);
      expect(events.some((event) => event.type === 'session.error')).toBe(
        false,
      );

      const again = await post('/session/abort', {
        sessionId: session.id,
      }).expect(200);
      expect((again.body as WrappedBody<{ aborted: boolean }>).data).toEqual({
        aborted: false,
      });
    });

    it('会话不存在：业务错 4040', async () => {
      const res = await post('/session/abort', { sessionId: 999999 }).expect(
        200,
      );
      expect((res.body as WrappedBody<null>).code).toBe('4040');
    });
  });

  describe('GET /event (SSE)', () => {
    /** 建立 SSE 连接，按 `\n\n` 切帧回调；返回响应对象（测试侧负责 destroy） */
    const connect = (
      onFrame: (frame: string) => void,
    ): Promise<http.IncomingMessage> =>
      new Promise((resolve, reject) => {
        const req = http.get(`${baseUrl}/event`, (res) => {
          let buf = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            buf += chunk;
            for (;;) {
              const idx = buf.indexOf('\n\n');
              if (idx < 0) break;
              onFrame(buf.slice(0, idx + 2));
              buf = buf.slice(idx + 2);
            }
          });
          resolve(res);
        });
        req.on('error', reject);
      });

    it('首帧 server.connected（instanceId/capabilities），send 后逐事件 message.chunk 帧流入', async () => {
      const frames: string[] = [];
      const res = await connect((frame) => frames.push(frame));
      await waitFor(() => expect(frames.length).toBeGreaterThan(0));

      const first = parseFrame(frames[0]);
      expect(frames[0]).toBe(
        'event: server.connected\ndata: ' + JSON.stringify(first.data) + '\n\n',
      );
      expect(typeof first.data.instanceId).toBe('string');
      // GA-T6：无头端能力域增 graph（spec §4.2）；FA-T1 增 files；
      // library 批增 library（spec 2026-10-26）；MO 批增 monitor（2026-10-27）
      expect(first.data.capabilities).toEqual([
        'chat',
        'provider',
        'graph',
        'files',
        'library',
        'monitor',
      ]);

      // 触发一轮真实事件流，断言 message.chunk 帧在线到达
      const { session } = await seedSession(db, makeDirs());
      activeModel = new ScriptedChatModel([
        { steps: [{ kind: 'text', delta: '在线' }] },
      ]);
      const sent = await fetch(`${baseUrl}/session/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: session.id, content: 'hi' }),
      });
      expect(sent.status).toBe(202);

      await waitFor(() =>
        expect(
          frames.some((frame) => {
            try {
              const parsed = parseFrame(frame);
              return (
                parsed.event === 'message.chunk' &&
                (parsed.data.chunk as { type?: string })?.type === 'finish' &&
                parsed.data.sessionId === session.id
              );
            } catch {
              return false;
            }
          }),
        ).toBe(true),
      );
      res.destroy();
    });

    it('帧编码（encodeSseFrame）：单帧格式 + updatedAt ISO 字符串原样透传', () => {
      expect(
        encodeSseFrame({
          type: 'server.connected',
          payload: { instanceId: 'i-1', capabilities: ['chat'] },
        }),
      ).toBe(
        'event: server.connected\ndata: {"instanceId":"i-1","capabilities":["chat"]}\n\n',
      );
      expect(
        encodeSseFrame({
          type: 'session.updated',
          payload: {
            id: 1,
            title: null,
            updatedAt: '1970-01-01T00:00:00.000Z',
            unreadCount: 0,
            lastMessage: null,
          },
        }),
      ).toBe(
        'event: session.updated\ndata: {"id":1,"title":null,"updatedAt":"1970-01-01T00:00:00.000Z","unreadCount":0,"lastMessage":null}\n\n',
      );
    });
  });

  describe('T6 顺手修 M1-M3', () => {
    it('M1：@@map 恢复 mirror 原表名 planItem/skillRecord（sqlite_master 实证）', async () => {
      const tables = await db.prisma.$queryRawUnsafe<Array<{ name: string }>>(
        "SELECT name FROM sqlite_master WHERE type='table'",
      );
      const names = tables.map((row) => row.name);
      expect(names).toContain('planItem');
      expect(names).toContain('skillRecord');
      expect(names).not.toContain('plan_item');
      expect(names).not.toContain('SkillRecord');
      // 客户端模型 → 物理表映射实际可用（写读一往返）
      await db.prisma.skillRecord.create({
        data: { name: 'map-probe', source: 'user', dir: '/tmp/map-probe' },
      });
      expect(await db.prisma.skillRecord.count()).toBe(1);
    });

    it('M2：skillRecord.enabled=false 的技能即时剔除，翻回启用即恢复注入', async () => {
      const dirs = makeDirs('tianshu-m2-');
      const skillDir = path.join(dirs.dataRoot, 'skills', 'probe-skill');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: probe-skill\ndescription: 技能过滤探针\n---\n正文',
      );
      await db.prisma.skillRecord.create({
        data: {
          name: 'probe-skill',
          source: 'user',
          dir: skillDir,
          enabled: false,
        },
      });

      const { session } = await seedSession(db, dirs);
      const disabled = makeRunner(db, dirs, [
        { steps: [{ kind: 'text', delta: 'ok' }] },
      ]);
      await disabled.runner.run({ sessionId: session.id, content: 'hi' });
      // 禁用对模型=不存在：system 技能清单与 read_skill 目录均不含该技能
      expect(JSON.stringify(disabled.model.callsLog[0].messages)).not.toContain(
        'probe-skill',
      );

      await db.prisma.skillRecord.update({
        where: { name: 'probe-skill' },
        data: { enabled: true },
      });
      const enabled = makeRunner(db, dirs, [
        { steps: [{ kind: 'text', delta: 'ok' }] },
      ]);
      await enabled.runner.run({ sessionId: session.id, content: 'hi again' });
      expect(
        JSON.stringify(enabled.model.callsLog[0].messages[0].content),
      ).toContain('- probe-skill: 技能过滤探针');
    });

    it('M3：deleteProtection=true 移入回收目录（默认），=false 永久删除（回收目录空）', async () => {
      // 保护默认开：delete_file 落 trash/<sessionId>/
      const protectDirs = makeDirs('tianshu-m3-protect-');
      const protect = await seedSession(db, protectDirs);
      const victim = path.join(protectDirs.workspace, 'a.txt');
      fs.writeFileSync(victim, 'x');
      await makeRunner(
        db,
        protectDirs,
        [
          {
            steps: [
              {
                kind: 'tool',
                toolCallId: 'd1',
                toolName: 'delete_file',
                input: { path: 'a.txt' },
              },
            ],
          },
          { steps: [{ kind: 'text', delta: '已删' }] },
        ],
        { accessMode: 'auto-approve' },
      ).runner.run({ sessionId: protect.session.id, content: '删掉它' });
      await waitFor(() => expect(fs.existsSync(victim)).toBe(false));
      expect(
        fs.readdirSync(
          path.join(protectDirs.dataRoot, 'trash', String(protect.session.id)),
        ).length,
      ).toBe(1);

      // 保护关：永久删除，回收目录不落任何条目
      const permanentDirs = makeDirs('tianshu-m3-permanent-');
      const permanent = await seedSession(db, permanentDirs);
      const victim2 = path.join(permanentDirs.workspace, 'b.txt');
      fs.writeFileSync(victim2, 'x');
      await makeRunner(
        db,
        permanentDirs,
        [
          {
            steps: [
              {
                kind: 'tool',
                toolCallId: 'd2',
                toolName: 'delete_file',
                input: { path: 'b.txt' },
              },
            ],
          },
          { steps: [{ kind: 'text', delta: '已删' }] },
        ],
        { accessMode: 'auto-approve', deleteProtection: false },
      ).runner.run({ sessionId: permanent.session.id, content: '删掉它' });
      await waitFor(() => expect(fs.existsSync(victim2)).toBe(false));
      expect(
        fs.readdirSync(path.join(permanentDirs.dataRoot, 'trash')).length,
      ).toBe(0);
    });
  });
});

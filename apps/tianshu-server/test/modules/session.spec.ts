import request from 'supertest'; // esModuleInterop 开启后 export= 不可命名空间直调
import * as http from 'node:http';
import { INestApplication } from '@nestjs/common';
import { SessionModule } from 'src/modules/session/session.module';
import { SessionService } from 'src/modules/session/session.service';
import { SessionRepository } from 'src/modules/session/session.repository';
import { EventBusModule } from 'src/commons/event-bus/event-bus.module';
import { EventBusService } from 'src/commons/event-bus/event-bus.service';
import type { ServerEvent } from '@tianshu/protocol';
import { createTestDb, TestDb } from '../support/test-db';
import {
  createTestApp,
  QueryResultBody,
  WrappedBody,
} from '../support/test-app';

/** session 行（响应侧，日期已被 JSON 序列化拦截器转为字符串） */
interface SessionRow {
  id: number;
  workspaceId: number;
  userId: number | null;
  title: string;
  [key: string]: unknown;
}

interface MessageBrief {
  id: number;
  role: string;
  blocks: string;
}

interface SessionDetail {
  session: SessionRow;
  messages: MessageBrief[];
}

/**
 * session 模块 e2e：POST create/query/getById/delete（supertest + 临时测试库，
 * TIANSHU_DATA_ROOT 隔离，不触碰 prisma/local.db）。
 * 伴生语义（T1 裁定）：userId 写死 1。
 */
describe('SessionController (e2e)', () => {
  let app: INestApplication;
  let server: http.Server;
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();

    // SessionService 依赖全局 EventBusService（全局模块仍需实例化于测试容器）
    const built = await createTestApp(db.prisma, [
      EventBusModule,
      SessionModule,
    ]);
    app = built.app;
    server = built.server;
  });

  afterAll(async () => {
    await app.close();
    await db.cleanup();
  });

  /** 发 POST（返回 supertest Test，可继续链 .expect） */
  const post = (path: string, body?: Record<string, unknown>): request.Test =>
    request(server)
      .post(path)
      .send(body ?? {});

  describe('POST /session/create', () => {
    // 启动兜底（onModuleInit ensure）已在 app.init() 建默认空间——本用例
    // 验证省略 workspaceId 挂靠该空间且 create 不再自建（RC-T6 对齐 mirror）
    it('省略 workspaceId：挂靠启动兜底的默认工作空间，返回带 id 的会话行（userId=1 伴生语义）', async () => {
      const res = await post('/session/create', { title: '测试会话' }).expect(
        200,
      );
      const body = res.body as WrappedBody<SessionRow>;
      expect(body.success).toBe(true);
      expect(typeof body.data.id).toBe('number');
      expect(body.data.id).toBeGreaterThan(0);
      expect(body.data.title).toBe('测试会话');
      expect(body.data.userId).toBe(1);

      const workspaces = await db.prisma.workspace.findMany();
      expect(workspaces).toHaveLength(1);
      expect(workspaces[0].userId).toBe(1);
      expect(body.data.workspaceId).toBe(workspaces[0].id);
    });

    // mirror 依据：server-face routes.ts handleCreate 缺省挂
    // resolveDefaultWorkspaceId（用户最新一个空间，id desc），无空间报
    // 4040 不自建（桌面端工作空间带目录语义，被控面不可替用户拍板目录）
    it('省略 workspaceId 挂最近一个工作空间（mirror id desc 口径），create 不新建空间', async () => {
      const before = await db.prisma.workspace.count();
      const w1 = await db.prisma.workspace.create({
        data: { name: 'align-w1', userId: 1 },
      });
      const w2 = await db.prisma.workspace.create({
        data: { name: 'align-w2', userId: 1 },
      });

      const res = await post('/session/create', {
        title: '缺省挂靠最近空间',
      }).expect(200);
      const body = res.body as WrappedBody<SessionRow>;
      expect(body.success).toBe(true);
      // 最近一个 = id 最大者（w2），非首个（w1）也非 create 时自建的新行
      expect(body.data.workspaceId).toBe(w2.id);
      expect(body.data.workspaceId).not.toBe(w1.id);
      expect(await db.prisma.workspace.count()).toBe(before + 2);
    });

    it('缺省 title 落库默认「新会话」', async () => {
      const res = await post('/session/create').expect(200);
      const body = res.body as WrappedBody<SessionRow>;
      expect(body.success).toBe(true);
      expect(body.data.title).toBe('新会话');
      expect(body.data.id).toBeGreaterThan(0);
    });

    it('显式 workspaceId 不存在：业务错误 4040', async () => {
      const res = await post('/session/create', {
        workspaceId: 999999,
      }).expect(200);
      const body = res.body as WrappedBody<null>;
      expect(body.success).toBe(false);
      expect(body.code).toBe('4040');
    });
  });

  describe('POST /session/query', () => {
    it('分页 + workspaceId 过滤 + 默认 lastMessageAt 倒序（对齐 mirror listAllSessions）', async () => {
      const ws = await db.prisma.workspace.create({
        data: { name: 'q-ws', userId: 1 },
      });
      const other = await db.prisma.workspace.create({
        data: { name: 'other-ws', userId: 1 },
      });
      const s1 = await db.prisma.sessionRecord.create({
        data: { workspaceId: ws.id, userId: 1, title: 's1' },
      });
      const s2 = await db.prisma.sessionRecord.create({
        data: { workspaceId: ws.id, userId: 1, title: 's2' },
      });
      await db.prisma.sessionRecord.create({
        data: { workspaceId: other.id, userId: 1, title: 'other-session' },
      });
      // RC-T6 排序语义用例：lastMessageAt 与 updatedAt 顺序相反的构造——
      // 默认 lastMessageAt desc 期望 [s1, s2]；若实现退回 updatedAt desc
      // 则得 [s2, s1]（用例能区分两个排序键）
      await db.prisma.sessionRecord.update({
        where: { id: s1.id },
        data: {
          lastMessageAt: new Date('2026-03-01T00:00:00Z'),
          updatedAt: new Date('2026-01-01T00:00:00Z'),
        },
      });
      await db.prisma.sessionRecord.update({
        where: { id: s2.id },
        data: {
          lastMessageAt: new Date('2026-02-01T00:00:00Z'),
          updatedAt: new Date('2026-06-01T00:00:00Z'),
        },
      });

      const query = async (params: Record<string, unknown>) =>
        (
          (await post('/session/query', params).expect(200))
            .body as WrappedBody<QueryResultBody<SessionRow>>
        ).data;

      // workspaceId 过滤 + 默认排序（lastMessageAt 倒序）
      const filtered = await query({
        page: 1,
        pageSize: 10,
        workspaceId: ws.id,
      });
      expect(filtered.total).toBe(2);
      expect(filtered.records.map((r) => r.title)).toEqual(['s1', 's2']);

      // 对照：显式 updatedAt desc 得相反顺序（证明构造可区分两键）
      const byUpdated = await query({
        page: 1,
        pageSize: 10,
        workspaceId: ws.id,
        sorts: [{ field: 'updatedAt', direction: 'desc' }],
      });
      expect(byUpdated.records.map((r) => r.title)).toEqual(['s2', 's1']);

      // 分页
      const page1 = await query({
        page: 1,
        pageSize: 1,
        workspaceId: ws.id,
      });
      expect(page1.total).toBe(2);
      expect(page1.records.map((r) => r.title)).toEqual(['s1']);
      const page2 = await query({
        page: 2,
        pageSize: 1,
        workspaceId: ws.id,
      });
      expect(page2.records.map((r) => r.title)).toEqual(['s2']);

      // sorts 覆盖默认排序
      const asc = await query({
        page: 1,
        pageSize: 10,
        workspaceId: ws.id,
        sorts: [{ field: 'id', direction: 'asc' }],
      });
      expect(asc.records.map((r) => r.title)).toEqual(['s1', 's2']);

      // keyword（title includes）
      const kw = await query({
        page: 1,
        pageSize: 10,
        workspaceId: ws.id,
        keyword: 's1',
      });
      expect(kw.total).toBe(1);
      expect(kw.records[0].title).toBe('s1');
    });

    // mirror 依据：server-face routes.ts handleQuery 内存
    // s.title.includes(params.keyword)——大小写敏感；SQLite LIKE 对 ASCII
    // 不敏感（Prisma SQLite 无 mode 参数），故 server 须内存过滤对齐
    it('keyword 大小写敏感：仅命中大小写完全一致的标题', async () => {
      const ws = await db.prisma.workspace.create({
        data: { name: 'kw-ws', userId: 1 },
      });
      await db.prisma.sessionRecord.create({
        data: { workspaceId: ws.id, userId: 1, title: 'Alpha Test Log' },
      });
      await db.prisma.sessionRecord.create({
        data: { workspaceId: ws.id, userId: 1, title: 'alpha test log' },
      });

      const query = async (params: Record<string, unknown>) =>
        (
          (await post('/session/query', params).expect(200))
            .body as WrappedBody<QueryResultBody<SessionRow>>
        ).data;

      const upper = await query({
        page: 1,
        pageSize: 10,
        workspaceId: ws.id,
        keyword: 'Test',
      });
      expect(upper.total).toBe(1);
      expect(upper.records.map((r) => r.title)).toEqual(['Alpha Test Log']);

      const lower = await query({
        page: 1,
        pageSize: 10,
        workspaceId: ws.id,
        keyword: 'test',
      });
      expect(lower.total).toBe(1);
      expect(lower.records.map((r) => r.title)).toEqual(['alpha test log']);
    });

    // RC-T8 tie-break 用例：lastMessageAt 平局（SQLite DESC 下 null 并列居尾）
    // 由 id desc 次键决胜——分页确定性依赖次键，防止实现退化为单键后同平局
    // 顺序漂移（对齐 mirror listAllSessions 排序口径）
    it('lastMessageAt 平局（同为 null）时 id desc 次键决胜', async () => {
      const ws = await db.prisma.workspace.create({
        data: { name: 'tie-ws', userId: 1 },
      });
      const withMsg = await db.prisma.sessionRecord.create({
        data: { workspaceId: ws.id, userId: 1, title: 'has-msg' },
      });
      await db.prisma.sessionRecord.update({
        where: { id: withMsg.id },
        data: { lastMessageAt: new Date('2026-05-01T00:00:00Z') },
      });
      const nullA = await db.prisma.sessionRecord.create({
        data: { workspaceId: ws.id, userId: 1, title: 'null-a' },
      });
      const nullB = await db.prisma.sessionRecord.create({
        data: { workspaceId: ws.id, userId: 1, title: 'null-b' },
      });
      expect(nullB.id).toBeGreaterThan(nullA.id);

      const res = await post('/session/query', {
        page: 1,
        pageSize: 10,
        workspaceId: ws.id,
      }).expect(200);
      const body = res.body as WrappedBody<QueryResultBody<SessionRow>>;
      expect(body.success).toBe(true);
      expect(body.data.total).toBe(3);
      // 有消息时间者居首（lastMessageAt desc）；null 平局居尾按 id desc——
      // 后建的 null-b 在前，null-a 殿后
      expect(body.data.records.map((r) => r.title)).toEqual([
        'has-msg',
        'null-b',
        'null-a',
      ]);
    });

    // A11 会话时间筛选批（spec §1.1/§1.2）：activityAfter 下推 DB where，
    // 活动时间 lastMessageAt ?? updatedAt >= 阈值（含边界）；两条查询路径
    // （无 keyword DB 分页 / 有 keyword 先全量再内存）分页前都生效；
    // lastMessageAt null 行回退 updatedAt；畸形时间串校验错 5000
    it('activityAfter 时间窗：两路径过滤、null 回退 updatedAt、与 keyword/archived 叠加、坏串 5000', async () => {
      const ws = await db.prisma.workspace.create({
        data: { name: 'a11-ws', userId: 1 },
      });
      const mk = async (
        title: string,
        patch: {
          lastMessageAt?: Date | null;
          updatedAt?: Date;
          archivedAt?: Date;
        },
      ) => {
        const row = await db.prisma.sessionRecord.create({
          data: { workspaceId: ws.id, userId: 1, title },
        });
        await db.prisma.sessionRecord.update({
          where: { id: row.id },
          data: patch,
        });
        return row;
      };
      const THRESHOLD = '2026-06-01T00:00:00.000Z';
      // 边界：lastMessageAt 恰=阈值（含边界入选）
      await mk('a11-edge', { lastMessageAt: new Date(THRESHOLD) });
      // 早于阈值排除
      await mk('a11-old', {
        lastMessageAt: new Date('2026-05-31T23:59:59.000Z'),
      });
      // lastMessageAt null 回退 updatedAt：新→入选 / 旧→排除
      await mk('a11-fallback-new', {
        lastMessageAt: null,
        updatedAt: new Date('2026-09-01T00:00:00.000Z'),
      });
      await mk('a11-fallback-old', {
        lastMessageAt: null,
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      // 归档但有近期活动：叠加 archived 用
      await mk('a11-archived-recent', {
        lastMessageAt: new Date('2026-08-01T00:00:00.000Z'),
        archivedAt: new Date('2026-08-02T00:00:00.000Z'),
      });

      const query = async (params: Record<string, unknown>) =>
        (
          (await post('/session/query', params).expect(200))
            .body as WrappedBody<QueryResultBody<SessionRow>>
        ).data;

      // 无 keyword DB 分页路径：边界内 3 条（含回退新），边界外 2 条排除
      const base = await query({
        page: 1,
        pageSize: 10,
        workspaceId: ws.id,
        activityAfter: THRESHOLD,
      });
      expect(base.total).toBe(3);
      expect(base.records.map((r) => r.title).sort()).toEqual([
        'a11-archived-recent',
        'a11-edge',
        'a11-fallback-new',
      ]);

      // 分页在过滤后：过滤剩 3 条，pageSize=2 → 第 2 页剩 1 条（total=3）
      const page2 = await query({
        page: 2,
        pageSize: 2,
        workspaceId: ws.id,
        activityAfter: THRESHOLD,
      });
      expect(page2.total).toBe(3);
      expect(page2.records).toHaveLength(1);

      // 有 keyword 内存路径：时间过滤在 DB where 已生效，再叠加 title 过滤
      const kw = await query({
        page: 1,
        pageSize: 10,
        workspaceId: ws.id,
        keyword: 'a11-old',
        activityAfter: THRESHOLD,
      });
      expect(kw.total).toBe(0);
      const kwHit = await query({
        page: 1,
        pageSize: 10,
        workspaceId: ws.id,
        keyword: 'a11-edge',
        activityAfter: THRESHOLD,
      });
      expect(kwHit.total).toBe(1);
      expect(kwHit.records[0].title).toBe('a11-edge');

      // 与 archived 叠加：archived=true 只剩归档近期行；false 不含它
      const archived = await query({
        page: 1,
        pageSize: 10,
        workspaceId: ws.id,
        activityAfter: THRESHOLD,
        archived: true,
      });
      expect(archived.total).toBe(1);
      expect(archived.records[0].title).toBe('a11-archived-recent');
      const active = await query({
        page: 1,
        pageSize: 10,
        workspaceId: ws.id,
        activityAfter: THRESHOLD,
        archived: false,
      });
      expect(active.total).toBe(2);
      expect(active.records.map((r) => r.title).sort()).toEqual([
        'a11-edge',
        'a11-fallback-new',
      ]);

      // 畸形时间串：DTO 校验错 5000（对齐空 title 校验错口径）
      const bad = await post('/session/query', {
        page: 1,
        pageSize: 10,
        workspaceId: ws.id,
        activityAfter: 'not-a-date',
      }).expect(200);
      expect((bad.body as WrappedBody<null>).code).toBe('5000');
    });
  });

  describe('POST /session/getById', () => {
    it('新会话返回空 messages 数组', async () => {
      const created = (
        (await post('/session/create', { title: '空会话' }).expect(200))
          .body as WrappedBody<SessionRow>
      ).data;

      const res = await post('/session/getById', { id: created.id }).expect(
        200,
      );
      const body = res.body as WrappedBody<SessionDetail>;
      expect(body.success).toBe(true);
      expect(body.data.session.id).toBe(created.id);
      expect(body.data.session.title).toBe('空会话');
      expect(body.data.messages).toEqual([]);
    });

    it('带消息历史：blocks 原样字符串、按 id 升序', async () => {
      const created = (
        (await post('/session/create', { title: '带消息' }).expect(200))
          .body as WrappedBody<SessionRow>
      ).data;
      const blocks1 = '[{"type":"text","text":"你好"}]';
      const blocks2 =
        '[{"type":"thinking","text":"思考"},{"type":"text","text":"在的"}]';
      const m1 = await db.prisma.messageRecord.create({
        data: { sessionId: created.id, role: 'user', blocks: blocks1 },
      });
      const m2 = await db.prisma.messageRecord.create({
        data: {
          sessionId: created.id,
          role: 'assistant',
          blocks: blocks2,
          // durationMs 批：round 计时列——serializer 透出断言
          durationMs: 2350,
        },
      });

      const res = await post('/session/getById', { id: created.id }).expect(
        200,
      );
      const body = res.body as WrappedBody<SessionDetail>;
      // CU 批起 createdAt/modelId 透出（时间戳与模型名显示管道）：
      // createdAt ISO、user 行 modelId null；durationMs 批起耗时透出：
      // assistant 带计时直透、user 行 null
      expect(body.data.messages).toEqual([
        {
          id: m1.id,
          role: 'user',
          blocks: blocks1,
          createdAt: m1.createdAt.toISOString(),
          modelId: null,
          durationMs: null,
        },
        {
          id: m2.id,
          role: 'assistant',
          blocks: blocks2,
          createdAt: m2.createdAt.toISOString(),
          modelId: null,
          durationMs: 2350,
        },
      ]);
    });

    it('不存在 id：业务错误 4040', async () => {
      const res = await post('/session/getById', { id: 999999 }).expect(200);
      const body = res.body as WrappedBody<null>;
      expect(body.success).toBe(false);
      expect(body.code).toBe('4040');
    });
  });

  describe('POST /session/delete', () => {
    it('删除后 getById 4040、query 查不到，消息级联清理', async () => {
      const ws = await db.prisma.workspace.create({
        data: { name: 'del-ws', userId: 1 },
      });
      const created = (
        (
          await post('/session/create', {
            title: '待删除',
            workspaceId: ws.id,
          }).expect(200)
        ).body as WrappedBody<SessionRow>
      ).data;
      await db.prisma.messageRecord.create({
        data: { sessionId: created.id, role: 'user', blocks: '[]' },
      });
      await db.prisma.messageRecord.create({
        data: { sessionId: created.id, role: 'assistant', blocks: '[]' },
      });

      const res = await post('/session/delete', { id: created.id }).expect(200);
      expect((res.body as WrappedBody<null>).success).toBe(true);

      const got = await post('/session/getById', { id: created.id }).expect(
        200,
      );
      expect((got.body as WrappedBody<null>).code).toBe('4040');

      const listed = (
        (
          await post('/session/query', {
            page: 1,
            pageSize: 100,
            workspaceId: ws.id,
          }).expect(200)
        ).body as WrappedBody<QueryResultBody<SessionRow>>
      ).data;
      expect(listed.total).toBe(0);

      const messageCount = await db.prisma.messageRecord.count({
        where: { sessionId: created.id },
      });
      expect(messageCount).toBe(0);
    });

    it('重复删除：业务错误 4040', async () => {
      const res = await post('/session/delete', { id: 999999 }).expect(200);
      const body = res.body as WrappedBody<null>;
      expect(body.success).toBe(false);
      expect(body.code).toBe('4040');
    });
  });

  describe('POST /session/update（重命名）', () => {
    it('重命名成功（title trim 落库）；空 title 校验错；归属外 4040', async () => {
      const created = await post('/session/create', {}).expect(200);
      const id = (created.body as WrappedBody<SessionRow>).data.id;

      await post('/session/update', {
        sessionId: id,
        title: '  重命名后  ',
      }).expect(200);
      const renamed = (
        (await post('/session/getById', { id }).expect(200))
          .body as WrappedBody<{
          session: SessionRow;
        }>
      ).data.session;
      expect(renamed.title).toBe('重命名后');

      const empty = await post('/session/update', {
        sessionId: id,
        title: '',
      }).expect(200);
      expect(empty.body.code).toBe('5000');

      const foreign = await post('/session/update', {
        sessionId: 424242,
        title: 'x',
      }).expect(200);
      expect(foreign.body.code).toBe('4040');
    });
  });

  // P1 未读角标批（spec §1.1/§1.4/§3）：query enriched 动态未读口径、
  // lastMessage 摘要形状、read 单调推进/幂等不回退/归属校验/并发收敛
  describe('POST /session/read + 未读角标（P1 批）', () => {
    // workspace_userId_name 唯一索引：每用例独立空间名（自增序保证不撞）
    let seq = 0;

    /** 造未读场景：1 user + 2 assistant（末条为 tool_call——摘要 tool 分支） */
    const seedUnreadSession = async () => {
      const ws = await db.prisma.workspace.create({
        data: { name: `p1-ws-${++seq}`, userId: 1 },
      });
      const session = await db.prisma.sessionRecord.create({
        data: { workspaceId: ws.id, userId: 1, title: 'p1-session' },
      });
      await db.prisma.messageRecord.create({
        data: {
          sessionId: session.id,
          role: 'user',
          blocks: '[{"type":"text","text":"问题"}]',
        },
      });
      const a1 = await db.prisma.messageRecord.create({
        data: {
          sessionId: session.id,
          role: 'assistant',
          blocks:
            '[{"type":"thinking","text":"想"},{"type":"text","text":"第一答"}]',
        },
      });
      const a2 = await db.prisma.messageRecord.create({
        data: {
          sessionId: session.id,
          role: 'assistant',
          blocks:
            '[{"type":"tool_call","toolCallId":"t1","toolName":"read","input":{}}]',
        },
      });
      return { ws, session, a1, a2 };
    };

    const queryOne = async (workspaceId: number) => {
      const res = await post('/session/query', {
        page: 1,
        pageSize: 10,
        workspaceId,
      }).expect(200);
      return (res.body as WrappedBody<QueryResultBody<SessionRow>>).data
        .records[0];
    };

    it('query enriched：NULL 游标全计（2 条 assistant），lastMessage 为末条 tool 摘要', async () => {
      const { ws, session, a2 } = await seedUnreadSession();

      const record = await queryOne(ws.id);
      expect(record.id).toBe(session.id);
      expect(record.unreadCount).toBe(2);
      expect(record.lastMessage).toEqual({
        id: a2.id,
        role: 'assistant',
        kind: 'tool',
        text: 'read',
        createdAt: a2.createdAt.toISOString(),
      });
    });

    it('read 推进后计数下降：读到 a1 未读 1，读到 a2 未读 0，lastMessage 不变', async () => {
      const { ws, session, a1, a2 } = await seedUnreadSession();

      const r1 = (
        (
          await post('/session/read', {
            sessionId: session.id,
            messageId: a1.id,
          }).expect(200)
        ).body as WrappedBody<{
          sessionId: number;
          lastReadMessageId: number;
          unreadCount: number;
        }>
      ).data;
      expect(r1).toEqual({
        sessionId: session.id,
        lastReadMessageId: a1.id,
        unreadCount: 1,
      });

      const r2 = (
        (
          await post('/session/read', {
            sessionId: session.id,
            messageId: a2.id,
          }).expect(200)
        ).body as WrappedBody<{
          sessionId: number;
          lastReadMessageId: number;
          unreadCount: number;
        }>
      ).data;
      expect(r2).toEqual({
        sessionId: session.id,
        lastReadMessageId: a2.id,
        unreadCount: 0,
      });

      const record = await queryOne(ws.id);
      expect(record.unreadCount).toBe(0);
      expect((record.lastMessage as { id: number }).id).toBe(a2.id);
    });

    it('read 幂等不回退（迟到旧响应）：游标在 a2 后再报 a1，生效游标与库值均保持 a2', async () => {
      const { session, a1, a2 } = await seedUnreadSession();
      await post('/session/read', { sessionId: session.id, messageId: a2.id });

      const late = (
        (
          await post('/session/read', {
            sessionId: session.id,
            messageId: a1.id,
          }).expect(200)
        ).body as WrappedBody<{
          lastReadMessageId: number;
          unreadCount: number;
        }>
      ).data;
      expect(late.lastReadMessageId).toBe(a2.id);
      expect(late.unreadCount).toBe(0);

      const row = await db.prisma.sessionRecord.findUnique({
        where: { id: session.id },
      });
      expect(row?.lastReadMessageId).toBe(a2.id);
    });

    it('并发 read 收敛：两请求并发推进，游标终值取 max 不回退', async () => {
      const { session, a1, a2 } = await seedUnreadSession();

      const [r1, r2] = await Promise.all([
        post('/session/read', { sessionId: session.id, messageId: a1.id }),
        post('/session/read', { sessionId: session.id, messageId: a2.id }),
      ]);
      expect((r1.body as WrappedBody<unknown>).success).toBe(true);
      // 大 id 请求：无论交序，生效游标=max(库值,a2)=a2，未读按 a2 现算
      expect(
        (
          r2.body as WrappedBody<{
            lastReadMessageId: number;
            unreadCount: number;
          }>
        ).data,
      ).toEqual({
        sessionId: session.id,
        lastReadMessageId: a2.id,
        unreadCount: 0,
      });

      const row = await db.prisma.sessionRecord.findUnique({
        where: { id: session.id },
      });
      expect(row?.lastReadMessageId).toBe(a2.id);
    });

    it('read 归属拒：会话不存在 4040', async () => {
      const { a1 } = await seedUnreadSession();
      const res = await post('/session/read', {
        sessionId: 999999,
        messageId: a1.id,
      }).expect(200);
      const body = res.body as WrappedBody<null>;
      expect(body.success).toBe(false);
      expect(body.code).toBe('4040');
    });

    it('read message 不属会话拒：4040 且不推进游标（不泄露存在性）', async () => {
      const { session, a1 } = await seedUnreadSession();
      const otherWs = await db.prisma.workspace.create({
        data: { name: `p1-other-ws-${++seq}`, userId: 1 },
      });
      const other = await db.prisma.sessionRecord.create({
        data: { workspaceId: otherWs.id, userId: 1, title: 'p1-other' },
      });
      const foreignMsg = await db.prisma.messageRecord.create({
        data: { sessionId: other.id, role: 'user', blocks: '[]' },
      });

      const res = await post('/session/read', {
        sessionId: session.id,
        messageId: foreignMsg.id,
      }).expect(200);
      const body = res.body as WrappedBody<null>;
      expect(body.success).toBe(false);
      expect(body.code).toBe('4040');

      const row = await db.prisma.sessionRecord.findUnique({
        where: { id: session.id },
      });
      expect(row?.lastReadMessageId).toBeNull();
      // 对照：本会话自己的消息可正常推进（排除上面 4040 是其他原因）
      await post('/session/read', {
        sessionId: session.id,
        messageId: a1.id,
      }).expect(200);
      const after = await db.prisma.sessionRecord.findUnique({
        where: { id: session.id },
      });
      expect(after?.lastReadMessageId).toBe(a1.id);
    });

    it('read 成功后发 enriched session.updated（unreadCount=0 + lastMessage 摘要，updatedAt 库值）', async () => {
      const { session, a2 } = await seedUnreadSession();
      const bus = app.get(EventBusService);
      const got: ServerEvent[] = [];
      const off = bus.subscribe((event) => got.push(event));

      try {
        await post('/session/read', {
          sessionId: session.id,
          messageId: a2.id,
        }).expect(200);
        const updated = got.find(
          (event) => event.type === 'session.updated',
        ) as Extract<ServerEvent, { type: 'session.updated' }> | undefined;
        expect(updated).toBeDefined();
        expect(updated?.payload.id).toBe(session.id);
        expect(updated?.payload.unreadCount).toBe(0);
        expect(updated?.payload.updatedAt).toMatch(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
        );
        expect(updated?.payload.lastMessage).toMatchObject({
          id: a2.id,
          kind: 'tool',
          text: 'read',
        });
      } finally {
        off();
      }
    });
  });
});

// RC-T6 workspace 裁决用例：mirror server-face routes.ts handleCreate 对
// workspaceId 缺省的真实行为——挂用户最近一个空间，无空间报 4040
// 「工作空间不存在」，create 不自建（桌面端空间带目录语义，被控面不可替
// 用户拍板目录）。server 的默认空间改为启动兜底（onModuleInit ensure），
// 故本用例直接构造 SessionService（不经 Nest 启动生命周期）覆盖空库分支
describe('create 缺省 workspace（mirror 语义：无空间不自建）', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  }, 120_000);

  afterAll(async () => {
    await db.cleanup();
  });

  it('空库直接 create：4040 业务错且不落任何工作空间行', async () => {
    const repo = new SessionRepository(db.prisma);
    // 不触发 onModuleInit 启动兜底；chatRunner/bus/config 在 4040 路径不触达
    const service = new SessionService(
      repo,
      {} as never,
      {} as never,
      { get: () => undefined } as never,
      {} as never,
    );
    await expect(service.create({ title: '无空间' })).rejects.toMatchObject({
      code: '4040',
    });
    expect(await db.prisma.workspace.count()).toBe(0);
  });
});

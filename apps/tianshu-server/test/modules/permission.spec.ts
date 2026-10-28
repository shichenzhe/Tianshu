import request from 'supertest';
import * as http from 'node:http';
import { INestApplication } from '@nestjs/common';
import { PermissionModule } from 'src/modules/permission/permission.module';
import { ChatRunnerService } from 'src/core/chat-runner.service';
import { createTestDb, TestDb } from '../support/test-db';
import { createTestApp, WrappedBody } from '../support/test-app';
import type {
  PermissionFullGrantsResult,
  PermissionRememberedItem,
  PermissionRevokeResult,
} from '@tianshu/protocol';

/**
 * 审批记忆面 e2e（A10 批，spec 2026-10-26 §2）：permission 五端点——
 * remembered 面（本人空间过滤/createdAt 倒序/取名回落/单条幂等 no-op/
 * 全部撤销计数/他人行不透）+ full 面（运行态 list 标题回落/清空计数）+
 * PERMISSION_INVALID 稳定码（与桌面 face 同码）。
 */
describe('PermissionController (e2e)', () => {
  let app: INestApplication;
  let server: http.Server;
  let db: TestDb;
  let chatRunner: ChatRunnerService;

  beforeAll(async () => {
    db = await createTestDb();
    const created = await createTestApp(db.prisma, [PermissionModule]);
    app = created.app;
    server = created.server;
    chatRunner = app.get(ChatRunnerService);
  });

  afterAll(async () => {
    await app.close();
    await db.cleanup();
  });

  const post = (path: string, body?: Record<string, unknown>): request.Test =>
    request(server)
      .post(path)
      .send(body ?? {});

  it('POST /permission/listRemembered：本人空间过滤 + createdAt 倒序 + 取名；他人行不透', async () => {
    const [wsA, wsB, wsOther] = await Promise.all(
      [
        { userId: 1, name: '空间A' },
        { userId: 1, name: '空间B' },
        { userId: 2, name: '他人空间' },
      ].map((data) => db.prisma.workspace.create({ data })),
    );
    await db.prisma.toolPermission.createMany({
      data: [
        {
          workspaceId: wsA.id,
          toolName: 'write_file',
          createdAt: new Date('2026-10-20T08:00:00.000Z'),
        },
        {
          workspaceId: wsB.id,
          toolName: 'bash',
          createdAt: new Date('2026-10-25T08:00:00.000Z'),
        },
        {
          workspaceId: wsOther.id,
          toolName: 'secret_tool',
          createdAt: new Date('2026-10-26T08:00:00.000Z'),
        },
      ],
    });

    const body = (await post('/permission/listRemembered').expect(200))
      .body as WrappedBody<PermissionRememberedItem[]>;
    expect(body.success).toBe(true);
    // createdAt 倒序（他人行最新但不透）；四字段形状；createdAt ISO 串
    expect(body.data).toEqual([
      {
        id: expect.any(Number),
        workspaceName: '空间B',
        toolName: 'bash',
        createdAt: '2026-10-25T08:00:00.000Z',
      },
      {
        id: expect.any(Number),
        workspaceName: '空间A',
        toolName: 'write_file',
        createdAt: '2026-10-20T08:00:00.000Z',
      },
    ]);
    expect(JSON.stringify(body)).not.toContain('secret_tool');
  });

  it('POST /permission/listRemembered：孤儿 workspaceId 行（空间已删）被归属过滤不透', async () => {
    // 直接插孤儿 workspaceId 行——不属本人空间即不可见（与桌面 v12 本人
    // 空间过滤同口径；#id 回落仅覆盖归属内取名竞态，孤儿行走不到）
    await db.prisma.toolPermission.create({
      data: { workspaceId: 999999, toolName: 'orphan_tool' },
    });
    const body = (await post('/permission/listRemembered').expect(200))
      .body as WrappedBody<PermissionRememberedItem[]>;
    const orphan = body.data.find((r) => r.toolName === 'orphan_tool');
    expect(orphan).toBeUndefined();
    // 本人空间行取名正常
    expect(body.data.every((r) => !r.workspaceName.startsWith('#'))).toBe(true);
  });

  it('POST /permission/revokeRemembered：本人行删除返 null；他人行/不存在幂等成功且不删', async () => {
    const [wsOwn, wsOther] = await Promise.all(
      [
        { userId: 1, name: '撤销空间' },
        { userId: 2, name: '他人撤销空间' },
      ].map((data) => db.prisma.workspace.create({ data })),
    );
    const [own, other] = await Promise.all([
      db.prisma.toolPermission.create({
        data: { workspaceId: wsOwn.id, toolName: 'own_tool' },
      }),
      db.prisma.toolPermission.create({
        data: { workspaceId: wsOther.id, toolName: 'other_tool' },
      }),
    ]);

    // 他人行 id：幂等成功（桌面 no-op 语义），行保留
    const foreign = (
      await post('/permission/revokeRemembered', { id: other.id }).expect(200)
    ).body as WrappedBody<null>;
    expect(foreign.success).toBe(true);
    expect(foreign.data).toBeNull();
    expect(
      await db.prisma.toolPermission.findUnique({ where: { id: other.id } }),
    ).not.toBeNull();

    // 不存在 id：同样幂等成功
    const missing = (
      await post('/permission/revokeRemembered', { id: 987654 }).expect(200)
    ).body as WrappedBody<null>;
    expect(missing.success).toBe(true);

    // 本人行：真删
    const ownRevoke = (
      await post('/permission/revokeRemembered', { id: own.id }).expect(200)
    ).body as WrappedBody<null>;
    expect(ownRevoke.success).toBe(true);
    expect(
      await db.prisma.toolPermission.findUnique({ where: { id: own.id } }),
    ).toBeNull();
  });

  it('POST /permission/revokeRemembered：非正整数 PERMISSION_INVALID 稳定码', async () => {
    for (const id of [0, -1]) {
      const body = (
        await post('/permission/revokeRemembered', { id }).expect(200)
      ).body as WrappedBody<null>;
      expect(body.success).toBe(false);
      expect(body.message).toBe('PERMISSION_INVALID');
    }
    // 非整数形态被 ValidationPipe 拒（语义同桌面形态校验——不进 service）
    const malformed = (
      await post('/permission/revokeRemembered', { id: 'x' }).expect(200)
    ).body as WrappedBody<null>;
    expect(malformed.success).toBe(false);
  });

  it('POST /permission/revokeAllRemembered：按本人空间级联删除，返回实际条数；他人行保留', async () => {
    const [wsOwn, wsOther] = await Promise.all(
      [
        { userId: 1, name: '全删空间' },
        { userId: 2, name: '他人全删空间' },
      ].map((data) => db.prisma.workspace.create({ data })),
    );
    await db.prisma.toolPermission.createMany({
      data: [
        { workspaceId: wsOwn.id, toolName: 'tool_1' },
        { workspaceId: wsOwn.id, toolName: 'tool_2' },
        { workspaceId: wsOther.id, toolName: 'tool_keep' },
      ],
    });

    // 前置断言基线：revokeAll 删本人全部空间的记忆（跨空间级联，不止本
    // 用例建的两行——前面用例的空间行仍在）
    const ownedIds = (
      await db.prisma.workspace.findMany({
        where: { userId: 1 },
        select: { id: true },
      })
    ).map((w) => w.id);
    const ownedBefore = await db.prisma.toolPermission.count({
      where: { workspaceId: { in: ownedIds } },
    });

    const body = (await post('/permission/revokeAllRemembered').expect(200))
      .body as WrappedBody<PermissionRevokeResult>;
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ revoked: ownedBefore });
    // 本人空间行清零；他人行保留
    expect(
      await db.prisma.toolPermission.count({
        where: { workspaceId: { in: ownedIds } },
      }),
    ).toBe(0);
    expect(
      await db.prisma.toolPermission.count({
        where: { workspaceId: wsOther.id },
      }),
    ).toBe(1);

    // 空集再撤：0 语义
    const again = (await post('/permission/revokeAllRemembered').expect(200))
      .body as WrappedBody<PermissionRevokeResult>;
    expect(again.data).toEqual({ revoked: 0 });
  });

  it('POST /permission/listFullGrants：full 运行态列表（标题取库，缺行回落「会话 #id」）', async () => {
    const ws = await db.prisma.workspace.create({
      data: { userId: 1, name: 'full空间' },
    });
    const [s1, s2] = await Promise.all(
      [
        { workspaceId: ws.id, title: '改造计划' },
        { workspaceId: ws.id, title: '调研会话' },
      ].map((data) => db.prisma.sessionRecord.create({ data })),
    );
    chatRunner.setAccessMode(s1.id, 'full');
    chatRunner.setAccessMode(s2.id, 'full');
    chatRunner.setAccessMode(424242, 'full'); // 库缺行 → 标题回落

    const body = (await post('/permission/listFullGrants').expect(200))
      .body as WrappedBody<PermissionFullGrantsResult>;
    expect(body.success).toBe(true);
    expect(body.data).toEqual({
      grants: [
        { sessionId: s1.id, title: '改造计划' },
        { sessionId: s2.id, title: '调研会话' },
        { sessionId: 424242, title: '会话 #424242' },
      ],
    });
  });

  it('POST /permission/revokeAllFull：清空 full 运行态，返回收回条数；幂等再清 0', async () => {
    const body = (await post('/permission/revokeAllFull').expect(200))
      .body as WrappedBody<PermissionRevokeResult>;
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ revoked: 3 });

    const after = (await post('/permission/listFullGrants').expect(200))
      .body as WrappedBody<PermissionFullGrantsResult>;
    expect(after.data).toEqual({ grants: [] });

    const again = (await post('/permission/revokeAllFull').expect(200))
      .body as WrappedBody<PermissionRevokeResult>;
    expect(again.data).toEqual({ revoked: 0 });
  });
});

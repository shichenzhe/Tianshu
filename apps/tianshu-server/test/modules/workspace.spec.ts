import request from 'supertest';
import * as http from 'node:http';
import { INestApplication } from '@nestjs/common';
import { WorkspaceModule } from 'src/modules/workspace/workspace.module';
import { createTestDb, TestDb } from '../support/test-db';
import { createTestApp, WrappedBody } from '../support/test-app';

/** workspace/query 列表项（HD-A1：单 UI 远程态侧栏分组树数据源） */
interface WorkspaceBrief {
  id: number;
  name: string;
  directoryPath: string | null;
  defaultModelId: number | null;
}

describe('WorkspaceController (e2e)', () => {
  let app: INestApplication;
  let server: http.Server;
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
    const created = await createTestApp(db.prisma, [WorkspaceModule]);
    app = created.app;
    server = created.server;
  });

  afterAll(async () => {
    await app.close();
    await db.cleanup();
  });

  const post = (path: string, body?: Record<string, unknown>): request.Test =>
    request(server)
      .post(path)
      .send(body ?? {});

  it('POST /workspace/query：空库空列表；伴生用户行全量、他人行不透、敏感面不外露', async () => {
    const empty = (await post('/workspace/query').expect(200))
      .body as WrappedBody<WorkspaceBrief[]>;
    expect(empty.data).toEqual([]);

    await db.prisma.workspace.createMany({
      data: [
        { userId: 1, name: 'default', directoryPath: '/data/workspace' },
        {
          userId: 1,
          name: 'second',
          directoryPath: null,
          defaultModelId: 3,
          writeApprovedAt: new Date(),
          projectId: 99,
        },
        { userId: 2, name: '他人空间' },
      ],
    });

    const body = (await post('/workspace/query').expect(200))
      .body as WrappedBody<WorkspaceBrief[]>;
    expect(body.success).toBe(true);
    // 仅伴生用户（userId=1）行；概要四字段；writeApprovedAt/projectId 不外露
    expect(body.data).toEqual([
      {
        id: expect.any(Number),
        name: 'default',
        directoryPath: '/data/workspace',
        defaultModelId: null,
      },
      {
        id: expect.any(Number),
        name: 'second',
        directoryPath: null,
        defaultModelId: 3,
      },
    ]);
    expect(JSON.stringify(body)).not.toContain('writeApprovedAt');
    expect(JSON.stringify(body)).not.toContain('projectId');
  });

  it('POST /workspace/create：建行为伴生用户所有，概要四字段回传；name 空拒 WORKSPACE_INVALID', async () => {
    const created = (
      await post('/workspace/create', {
        name: ' 新空间 ',
        icon: '🚀',
        defaultModelId: 3,
      }).expect(200)
    ).body as WrappedBody<WorkspaceBrief>;
    expect(created.success).toBe(true);
    expect(created.data).toEqual({
      id: expect.any(Number),
      name: '新空间',
      directoryPath: null,
      defaultModelId: 3,
    });
    const row = await db.prisma.workspace.findUnique({
      where: { id: created.data.id },
    });
    expect(row?.userId).toBe(1);
    expect(row?.icon).toBe('🚀');

    // name 空串/纯空白/缺省：稳定码经 message 信封（与桌面 face 同码）
    for (const payload of [{ name: '' }, { name: '   ' }, {}]) {
      const invalid = (
        await post('/workspace/create', payload).expect(200)
      ).body as WrappedBody<null>;
      expect(invalid.success).toBe(false);
      expect(invalid.message).toBe('WORKSPACE_INVALID');
    }
  });

  it('POST /workspace/update：改名/图标/默认模型；他人空间报 WORKSPACE_NOT_FOUND；name 空拒', async () => {
    const target = await db.prisma.workspace.create({
      data: { userId: 1, name: '原名称' },
    });
    const updated = (
      await post('/workspace/update', {
        id: target.id,
        name: ' 新名称 ',
        defaultModelId: 7,
      }).expect(200)
    ).body as WrappedBody<WorkspaceBrief>;
    expect(updated.success).toBe(true);
    expect(updated.data).toEqual({
      id: target.id,
      name: '新名称',
      directoryPath: null,
      defaultModelId: 7,
    });

    // 他人空间与不存在同码（不泄露存在性；库级 (userId,name) 唯一约束，
    // 命名避开 query 用例已建的同名行）
    const other = await db.prisma.workspace.create({
      data: { userId: 2, name: '他人空间-2' },
    });
    for (const id of [other.id, 999999]) {
      const notFound = (
        await post('/workspace/update', { id, name: 'x' }).expect(200)
      ).body as WrappedBody<null>;
      expect(notFound.success).toBe(false);
      expect(notFound.message).toBe('WORKSPACE_NOT_FOUND');
    }

    const invalid = (
      await post('/workspace/update', { id: target.id, name: ' ' }).expect(200)
    ).body as WrappedBody<null>;
    expect(invalid.success).toBe(false);
    expect(invalid.message).toBe('WORKSPACE_INVALID');
  });

  it('POST /workspace/delete：硬级联删消息→会话→空间行；他人空间拒；返回 null', async () => {
    const target = await db.prisma.workspace.create({
      data: { userId: 1, name: '待删空间' },
    });
    const keep = await db.prisma.workspace.create({
      data: { userId: 1, name: '保留空间' },
    });
    const [s1, s2] = await Promise.all(
      [target.id, target.id, keep.id].map((workspaceId) =>
        db.prisma.sessionRecord.create({
          data: { workspaceId, title: '会话' },
        }),
      ),
    );
    await db.prisma.messageRecord.createMany({
      data: [
        { sessionId: s1.id, role: 'user', blocks: '[]' },
        { sessionId: s2.id, role: 'assistant', blocks: '[]' },
      ],
    });

    const deleted = (
      await post('/workspace/delete', { id: target.id }).expect(200)
    ).body as WrappedBody<null>;
    expect(deleted.success).toBe(true);
    expect(deleted.data).toBeNull();
    // 级联：目标空间的会话/消息全清；保留空间不动
    expect(
      await db.prisma.workspace.findUnique({ where: { id: target.id } }),
    ).toBeNull();
    expect(
      await db.prisma.sessionRecord.count({
        where: { workspaceId: target.id },
      }),
    ).toBe(0);
    expect(await db.prisma.messageRecord.count()).toBe(0);
    expect(
      await db.prisma.sessionRecord.count({ where: { workspaceId: keep.id } }),
    ).toBe(1);

    // 他人空间与重复删除同码（命名避开 query 用例已建的同名行）
    const other = await db.prisma.workspace.create({
      data: { userId: 2, name: '他人空间-3' },
    });
    for (const id of [other.id, target.id]) {
      const notFound = (
        await post('/workspace/delete', { id }).expect(200)
      ).body as WrappedBody<null>;
      expect(notFound.success).toBe(false);
      expect(notFound.message).toBe('WORKSPACE_NOT_FOUND');
    }
  });

  it('写面载荷形态校验：update id 非整数被 ValidationPipe 拒', async () => {
    const badId = (
      await post('/workspace/update', { id: 'x' }).expect(200)
    ).body as WrappedBody<null>;
    expect(badId.success).toBe(false);
  });
});

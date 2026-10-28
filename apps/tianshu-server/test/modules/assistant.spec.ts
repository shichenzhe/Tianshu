import request from 'supertest';
import * as http from 'node:http';
import { INestApplication } from '@nestjs/common';
import { AssistantModule } from 'src/modules/assistant/assistant.module';
import { createTestDb, TestDb } from '../support/test-db';
import { createTestApp, WrappedBody } from '../support/test-app';

interface AssistantBrief {
  id: number;
  name: string;
  description: null;
}

describe('AssistantController (e2e)', () => {
  let app: INestApplication;
  let server: http.Server;
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
    const created = await createTestApp(db.prisma, [AssistantModule]);
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

  it('POST /assistant/query：空库空列表；伴生用户行按 id 升序、不含 systemPrompt', async () => {
    const empty = (await post('/assistant/query').expect(200))
      .body as WrappedBody<AssistantBrief[]>;
    expect(empty.data).toEqual([]);

    await db.prisma.assistant.createMany({
      data: [
        {
          userId: 1,
          name: '专家B',
          systemPrompt: 'SECRET-B',
        },
        {
          userId: 1,
          name: '专家A',
          systemPrompt: 'SECRET-A',
        },
        {
          userId: 2,
          name: '他人专家',
          systemPrompt: 'SECRET-C',
        },
      ],
    });

    const body = (await post('/assistant/query').expect(200))
      .body as WrappedBody<AssistantBrief[]>;
    expect(body.success).toBe(true);
    // 仅伴生用户（userId=1）行，按 id 升序；systemPrompt 不外露
    expect(body.data.map((a) => a.name)).toEqual(['专家B', '专家A']);
    expect(JSON.stringify(body)).not.toContain('SECRET');
  });

  // A2 尾：导出 JSON 文本（归属校验/纯内容面）与导入（parse 校验/dedupe/
  // members 透传/skillNames 过滤已安装）
  it('POST /assistant/export：归属校验产 JSON 文本；他人所有 4040', async () => {
    const created = await db.prisma.assistant.create({
      data: {
        userId: 1,
        name: '导出甲',
        systemPrompt: 'PROMPT-EXPORT',
        description: 'desc',
        tags: '["a"]',
      },
    });
    const body = (
      await post('/assistant/export', { id: created.id }).expect(200)
    ).body as WrappedBody<{ json: string }>;
    expect(body.success).toBe(true);
    const parsed = JSON.parse(body.data.json) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      kind: 'tianshu-expert',
      version: 1,
      name: '导出甲',
      systemPrompt: 'PROMPT-EXPORT',
      tags: ['a'],
    });
    // 纯内容面：无 id/builtin/时间戳/sourceSlug 泄漏
    expect(body.data.json).not.toContain('createdAt');
    expect(body.data.json).not.toContain('sourceSlug');

    const missing = (await post('/assistant/export', { id: 9999 }).expect(200))
      .body as { code: string; success: boolean };
    expect(missing.success).toBe(false);
    expect(missing.code).toBe('4040');
    const other = await db.prisma.assistant.create({
      data: { userId: 2, name: '他人', systemPrompt: 'X' },
    });
    const foreign = (
      await post('/assistant/export', { id: other.id }).expect(200)
    ).body as { code: string; success: boolean };
    expect(foreign.success).toBe(false);
    expect(foreign.code).toBe('4040');
  });

  it('POST /assistant/import：合法 JSON 新建并回传 id/name；重名后缀', async () => {
    const payload = JSON.stringify({
      kind: 'tianshu-expert',
      version: 1,
      name: '导入甲',
      systemPrompt: '你是导入甲',
      expertType: 'team',
      members: [
        { id: 'm1', name: '成员', profession: 'P', systemPrompt: 'MP' },
      ],
    });
    const first = (
      await post('/assistant/import', { json: payload }).expect(200)
    ).body as WrappedBody<{ id: number; name: string }>;
    expect(first.data.name).toBe('导入甲');
    // 成员团透传
    const row = await db.prisma.assistant.findUnique({
      where: { id: first.data.id },
    });
    expect(row?.expertType).toBe('team');
    expect(row?.members).toContain('m1');

    const second = (
      await post('/assistant/import', { json: payload }).expect(200)
    ).body as WrappedBody<{ id: number; name: string }>;
    expect(second.data.name).toBe('导入甲-2');
  });

  it('POST /assistant/import：坏 JSON/kind 不符拒 ASSISTANT_INVALID；skillNames 过滤未安装', async () => {
    const bad = (await post('/assistant/import', { json: 'not-json{' }))
      .body as {
      code: string;
    };
    expect(bad.code).toBe('ASSISTANT_INVALID');

    await db.prisma.skillRecord.create({
      data: {
        name: '已安装技能',
        source: 'local',
        dir: '/skills/已安装技能',
        description: null,
      },
    });
    const payload = JSON.stringify({
      kind: 'tianshu-expert',
      version: 1,
      name: '过滤技能',
      systemPrompt: 'S',
      skillNames: ['已安装技能', '未安装技能'],
    });
    const ok = (await post('/assistant/import', { json: payload }).expect(200))
      .body as WrappedBody<{ id: number }>;
    const row = await db.prisma.assistant.findUnique({
      where: { id: ok.data.id },
    });
    expect(row?.skillNames).toBe('["已安装技能"]');
  });
});

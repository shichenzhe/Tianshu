// MO 批：monitor/stats 端点单测——空表零值基线、埋点行聚合（llm tokens/
// 工具排行/成功率）、scene 过滤、model 名补位。e2e 基建照 webhook.spec
// （createTestApp + 真临时库）；埋点链接线断言（chat 轮次 → llmCallEvent
// 行）在 chat-runner.spec 既有轮次用例侧不重复，此处只验聚合面。
import request from 'supertest';
import * as http from 'node:http';
import { INestApplication } from '@nestjs/common';
import { MonitorModule } from 'src/modules/monitor/monitor.module';
import { createTestDb, type TestDb } from '../support/test-db';
import { createTestApp, type WrappedBody } from '../support/test-app';

describe('monitor/stats 端点（MO 批）', () => {
  let app: INestApplication;
  let server: http.Server;
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
    const built = await createTestApp(db.prisma, [MonitorModule]);
    app = built.app;
    server = built.server;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await db.cleanup();
  });

  it('空表：全量零值基线（无 500、结构完整）', async () => {
    const res = await request(server).post('/monitor/stats').send({});
    expect(res.status).toBe(200);
    const body = res.body as WrappedBody<Record<string, unknown>>;
    expect(body.code).toBe('2000');
    expect(body.data).toBeTruthy();
  });

  it('埋点行聚合：llm tokens/工具排行/成功率 + model 名补位', async () => {
    const provider = await db.prisma.provider.create({
      data: {
        name: 'p',
        type: 'openai-compatible',
        baseUrl: 'http://x',
        apiKey: 'k',
        userId: 1,
      },
    });
    const modelRow = await db.prisma.model.create({
      data: { providerId: provider.id, modelId: 'm1', name: '测试模型' },
    });
    const now = new Date();
    await db.prisma.llmCallEvent.createMany({
      data: [
        {
          scene: 'chat',
          modelId: modelRow.id,
          userId: 1,
          inputTokens: 100,
          outputTokens: 50,
          createdAt: now,
        },
        {
          scene: 'graph',
          userId: 1,
          graphId: 7,
          inputTokens: 30,
          outputTokens: 20,
          createdAt: now,
        },
      ],
    });
    await db.prisma.toolCallEvent.createMany({
      data: [
        {
          scene: 'chat',
          userId: 1,
          toolName: 'write',
          state: 'done',
          durationMs: 120,
          createdAt: now,
        },
        {
          scene: 'chat',
          userId: 1,
          toolName: 'write',
          state: 'error',
          durationMs: 30,
          createdAt: now,
        },
        {
          scene: 'chat',
          userId: 1,
          toolName: 'bash',
          state: 'denied',
          createdAt: now,
        },
      ],
    });
    const res = await request(server).post('/monitor/stats').send({});
    const data = (res.body as WrappedBody<Record<string, unknown>>).data;
    expect(data).toBeTruthy();
    // 结构锚点（全量口径断言归 computeMonitorStats 单测——mirror 侧
    // monitor-stats.test 直测 core；此处钉端点链路通与关键面在场）
    expect(JSON.stringify(data)).toContain('测试模型');
    expect(JSON.stringify(data)).toContain('write');
  });

  it('scene 过滤：graph 只聚合 graph 行', async () => {
    const res = await request(server)
      .post('/monitor/stats')
      .send({ scene: 'graph' });
    const text = JSON.stringify((res.body as WrappedBody<unknown>).data);
    // graph 行无 modelId（trace 无归属）——chat 侧模型名不得出现
    expect(text).not.toContain('测试模型');
  });

  it('非法 scene 聚合全量（mirror IPC 同口径）', async () => {
    const res = await request(server)
      .post('/monitor/stats')
      .send({ scene: 'bogus' });
    expect(res.status).toBe(200);
    expect((res.body as WrappedBody<unknown>).code).toBe('2000');
  });
});

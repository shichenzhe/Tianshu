// GA-T7：webhook 端点 e2e（mirror orchestration/webhook-server 语义对照）。
// 覆盖（任务面）：
// 1. 同步模式：自定义模板渲染 {{nodes.x.output}}/{{input.y}}（原样文本，
//    不再 stringify）+ 配置状态码（201）；空模板 → 默认 {status,output}
//    JSON + 200
// 2. 异步模式：202 {jobId,statusUrl}（runId 即 jobId，run 行 triggerType=
//    webhook）+ GET jobs 轮询到终态（内存结果带 output）
// 3. 404 未知 token（invalid_token 原样体，不经统一包装）
// 4. 同步超时：deps 注入缩短值 → abort → 200 {status:'failed'}（120s 配置化）
// 5. JSON body 顶层字符串 → inputs（非字符串值 JSON 化）
// 6. 旧版裸 token 兼容读（option 值直接存 token 串，启动装载即生效）
// 7. deleteGraph 清理 option 注册（GA-T3 no-op 钩子接线）+ 旧 token 404
// 8. 异步前置失败：图禁用 → 500 graph_not_available
// 9. 外部系统语义（终审 F1）：TIANSHU_TOKEN 部署下无 Bearer 调
//    /webhook/<有效token> 通（守卫豁免前缀）、其余端点仍 401
// 10. 管理三端点（WH 批 2026-10-27）：enable 落库/回显/触发生效/重开换
//     token/图不存在 4040；disable 注销+幂等+旧 token 404+在途中止；
//     status 两态回显；管理面不落豁免前缀（无 Bearer 401）
// 假模型注入与 graph-api.spec 同款（模型工厂 jest.mock 是 executor 唯一
// IO 缝；executor 非流式 invoke 消费面用 plain FakeInvokeModel）。
import request from 'supertest'; // esModuleInterop 开启后 export= 不可命名空间直调
import type { Response } from 'superagent';
import * as http from 'node:http';
import { INestApplication } from '@nestjs/common';
import { GraphModule } from 'src/modules/graph/graph.module';
import { WebhookModule } from 'src/modules/webhook/webhook.module';
import { EventBusModule } from 'src/commons/event-bus/event-bus.module';
import {
  WebhookService,
  type WebhookConfig,
} from 'src/modules/webhook/webhook.service';
import { createTestDb, type TestDb } from '../support/test-db';
import { createTestApp, type WrappedBody } from '../support/test-app';

jest.mock('src/core/provider/model-factory', () => ({
  createChatModel: jest.fn(),
}));

import { createChatModel } from 'src/core/provider/model-factory';

const createChatModelMock = createChatModel as jest.Mock;

/** 脚本化 plain 模型（executor invoke 消费面：content + usage_metadata；
 * signalWait=true 挂起至 signal abort——同步超时用例挂起锚点） */
class FakeInvokeModel {
  calls = 0;

  constructor(
    private readonly replies: Array<{ content: string }>,
    private readonly signalWait = false,
  ) {}

  invoke(
    _messages: unknown,
    opts?: { signal?: AbortSignal },
  ): Promise<{
    content: string;
    usage_metadata?: { input_tokens: number; output_tokens: number };
  }> {
    this.calls += 1;
    if (this.signalWait) {
      return new Promise((_resolve, reject) => {
        if (opts?.signal?.aborted) {
          reject(new Error('aborted'));
          return;
        }
        opts?.signal?.addEventListener(
          'abort',
          () => reject(new Error('aborted')),
          { once: true },
        );
      });
    }
    const reply = this.replies[this.calls - 1] ?? { content: '' };
    return Promise.resolve({ content: reply.content });
  }
}

/** 单节点 llm 图（节点 id=x——模板 {{nodes.x.output}} 消费；prompt 不引用
 * input 变量：inputs 断言只走响应模板面，不依赖图内消费） */
function singleNodeGraphJson(modelId: number): string {
  return JSON.stringify({
    version: 1,
    inputSchema: { q: 'string' },
    nodes: [
      {
        id: 'x',
        name: '处理',
        kind: 'llm',
        modelId,
        prompt: '固定提示词',
        tools: false,
        outputMode: 'text',
      },
    ],
    edges: [{ from: 'x', to: 'END' }],
  });
}

/** 异步断言轮询（graph-api.spec waitFor 同款） */
async function waitFor(check: () => void | Promise<void>, ms = 5000) {
  const startedAt = Date.now();
  for (;;) {
    try {
      await check();
      return;
    } catch (e) {
      if (Date.now() - startedAt > ms) throw e;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

/** 原样文本体消费：模板响应 Content-Type 为 application/json 但体非 JSON
 * （mirror 语义：模板原样文本不再 stringify）——superagent 默认 JSON
 * parser 会炸，换文本 parser 读原文 */
function textParser(
  res: Response,
  callback: (err: Error | null, body: string) => void,
): void {
  res.setEncoding('utf8');
  let raw = '';
  res.on('data', (chunk: string) => {
    raw += chunk;
  });
  res.on('end', () => callback(null, raw));
}

describe('webhook 端点（GA-T7 e2e）', () => {
  let app: INestApplication;
  let server: http.Server;
  let db: TestDb;
  let webhook: WebhookService;
  let modelId: number;
  let graphId: number;
  let asyncGraphId: number;
  let disabledGraphId: number;
  let hangGraphId: number;
  let deleteGraphTargetId: number;
  let manageGraphId: number;

  beforeAll(async () => {
    db = await createTestDb();
    const provider = await db.prisma.provider.create({
      data: {
        name: 'p1',
        type: 'openai-compatible',
        baseUrl: 'http://localhost:9',
        apiKey: 'k',
        userId: 1,
      },
    });
    const modelRow = await db.prisma.model.create({
      data: { providerId: provider.id, modelId: 'test-model' },
    });
    modelId = modelRow.id;
    await db.prisma.workspace.create({
      data: { name: 'webhook-ws', userId: 1 },
    });
    const mkGraph = async (name: string, enabled = true) =>
      (
        await db.prisma.graphDefinition.create({
          data: {
            name,
            graphJson: singleNodeGraphJson(modelId),
            userId: 1,
            ...(enabled ? {} : { enabled: false }),
          },
        })
      ).id;
    graphId = await mkGraph('同步图');
    asyncGraphId = await mkGraph('异步图');
    disabledGraphId = await mkGraph('禁用图', false);
    hangGraphId = await mkGraph('挂起图');
    deleteGraphTargetId = await mkGraph('待删图');
    manageGraphId = await mkGraph('管理图');
    // 旧版裸 token 行先于应用装载（onModuleInit 启动装载路径直证）
    await db.prisma.option.create({
      data: {
        type: 'webhook',
        name: `graph:${graphId}`,
        value: 'legacytoken123',
      },
    });

    const built = await createTestApp(
      db.prisma,
      [EventBusModule, GraphModule, WebhookModule],
      (builder) =>
        // 同步超时缩短值（mirror SYNC_TIMEOUT_MS=120s 的测试注入面）
        builder
          .overrideProvider(WebhookService)
          .useValue(new WebhookService(db.prisma, { syncTimeoutMs: 150 })),
    );
    app = built.app;
    server = built.server;
    webhook = app.get(WebhookService);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await db.cleanup();
  });

  beforeEach(() => {
    createChatModelMock.mockReset();
  });

  const register = (
    gid: number,
    config?: Partial<
      Pick<WebhookConfig, 'responseTemplate' | 'statusCode' | 'async'>
    >,
  ): Promise<WebhookConfig & { url: string }> =>
    webhook.registerWebhook(gid, 1, config);

  it('同步模式：裸 token 兼容读（启动装载）+ 默认体 {status,output} 200', async () => {
    createChatModelMock.mockImplementation(
      () => new FakeInvokeModel([{ content: '默认输出' }]),
    );
    const res = await request(server)
      .post('/webhook/legacytoken123')
      .send({ q: 'hi' })
      .expect(200);
    expect(res.body).toEqual({ status: 'success', output: '默认输出' });
    // run 行落库：triggerType=webhook、attempt=1
    const run = await db.prisma.automationRun.findFirstOrThrow({
      where: { graphId, triggerType: 'webhook' },
    });
    expect(run.status).toBe('success');
    expect(run.attempt).toBe(1);
  });

  it('同步模式：自定义模板 {{nodes.x.output}}/{{input.q}} 原样文本 + 配置状态码 201', async () => {
    createChatModelMock.mockImplementation(
      () => new FakeInvokeModel([{ content: '节点输出' }]),
    );
    const reg = await register(graphId, {
      responseTemplate: '结果={{nodes.x.output}} | 入参={{input.q}}',
      statusCode: 201,
    });
    const res = await request(server)
      .post(`/webhook/${reg.token}`)
      .send({ q: 'hello' })
      .buffer(true)
      .parse(textParser)
      .expect(201);
    expect(res.headers['content-type']).toContain('application/json');
    // 模板渲染为原样文本（不再 stringify）
    expect(res.body).toBe('结果=节点输出 | 入参=hello');
  });

  it('异步模式：202 {jobId,statusUrl} + GET jobs 轮询到 success（内存结果）', async () => {
    createChatModelMock.mockImplementation(
      () => new FakeInvokeModel([{ content: '异步结果' }]),
    );
    const reg = await register(asyncGraphId, { async: true });
    const res = await request(server)
      .post(`/webhook/${reg.token}`)
      .send({ q: 'go' })
      .expect(202);
    const jobId = res.body.jobId as number;
    expect(typeof jobId).toBe('number');
    // statusUrl 基址取请求自身（origin+路径）——对调用端即达
    expect(res.body.statusUrl).toContain(`/webhook/${reg.token}/jobs/${jobId}`);
    // run 行已落（202 受理即存在）
    const run = await db.prisma.automationRun.findFirstOrThrow({
      where: { graphId: asyncGraphId, triggerType: 'webhook' },
    });
    expect(run.id).toBe(jobId);

    // 轮询到终态：内存结果带完整 output（run 行先落 success、内存结果后写
    // ——回落体的 output 恒空，等到带值即内存结果就位，mirror 同序）
    let finalBody: { status?: string; output?: string } = {};
    await waitFor(async () => {
      const poll = await request(server)
        .get(`/webhook/${reg.token}/jobs/${jobId}`)
        .expect(200);
      finalBody = poll.body as typeof finalBody;
      if (finalBody.output !== '异步结果') throw new Error('内存结果未就位');
    });
    expect(finalBody.status).toBe('success');
  });

  it('404 未知 token：POST/GET 均 invalid_token 原样体', async () => {
    const post = await request(server)
      .post('/webhook/deadbeefdeadbeef')
      .send({})
      .expect(404);
    expect(post.body).toEqual({ error: 'invalid_token' });

    const get = await request(server)
      .get('/webhook/deadbeefdeadbeef/jobs/1')
      .expect(404);
    expect(get.body).toEqual({ error: 'invalid_token' });
  });

  it('同步超时：150ms 强杀 → 200 {status:"failed"}（mirror 120s 上限的可配等价）', async () => {
    createChatModelMock.mockImplementation(() => new FakeInvokeModel([], true));
    const reg = await register(hangGraphId);
    const startedAt = Date.now();
    const res = await request(server)
      .post(`/webhook/${reg.token}`)
      .send({ q: 'hang' })
      .expect(200);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(res.body.status).toBe('failed');
    const run = await db.prisma.automationRun.findFirstOrThrow({
      where: { graphId: hangGraphId, triggerType: 'webhook' },
    });
    expect(run.status).toBe('failed');
  });

  it('JSON body 顶层值展平：字符串原样、非字符串 JSON 化 → inputs', async () => {
    createChatModelMock.mockImplementation(
      () => new FakeInvokeModel([{ content: 'ok' }]),
    );
    const reg = await register(graphId, {
      responseTemplate: '{{input.a}}/{{input.b}}',
    });
    const res = await request(server)
      .post(`/webhook/${reg.token}`)
      .send({ a: 'x', b: { n: 1 } })
      .buffer(true)
      .parse(textParser)
      .expect(200);
    expect(res.body).toBe('x/{"n":1}');
  });

  it('异步前置失败：图禁用 → 500 graph_not_available', async () => {
    const reg = await register(disabledGraphId, { async: true });
    const res = await request(server)
      .post(`/webhook/${reg.token}`)
      .send({})
      .expect(500);
    expect(res.body).toEqual({ error: 'graph_not_available' });
  });

  it('deleteGraph：清理 option 注册（GA-T3 钩子接线）+ 旧 token 404', async () => {
    const reg = await register(deleteGraphTargetId);
    const row = await db.prisma.option.findFirst({
      where: { type: 'webhook', name: `graph:${deleteGraphTargetId}` },
    });
    expect(row).not.toBeNull();

    const deleted = await request(server)
      .post('/graph/delete')
      .send({ id: deleteGraphTargetId })
      .expect(200);
    expect((deleted.body as WrappedBody<null>).code).toBe('2000');
    // option 行随图删除清理
    const gone = await db.prisma.option.findFirst({
      where: { type: 'webhook', name: `graph:${deleteGraphTargetId}` },
    });
    expect(gone).toBeNull();
    // 内存注册同步清理：旧 token 不再可达
    await request(server).post(`/webhook/${reg.token}`).send({}).expect(404);
  });

  it('GET jobs：内存缺席回落 run 表（output 空+note）；未知 jobId 404', async () => {
    // 同步触发的 run 不写内存 job 结果——GET 走 run 表回落路径
    createChatModelMock.mockImplementation(
      () => new FakeInvokeModel([{ content: '同步完成' }]),
    );
    const reg = await register(asyncGraphId);
    const res = await request(server)
      .post(`/webhook/${reg.token}`)
      .send({ q: 'fb' })
      .expect(200);
    expect(res.body.status).toBe('success');
    const run = await db.prisma.automationRun.findFirstOrThrow({
      where: { graphId: asyncGraphId, triggerType: 'webhook' },
      orderBy: { id: 'desc' },
    });
    const poll = await request(server)
      .get(`/webhook/${reg.token}/jobs/${run.id}`)
      .expect(200);
    expect(poll.body).toEqual({
      status: 'success',
      output: '',
      note: '重启后详细输出不保留（完整轨迹见运行历史）',
    });

    const asyncReg = await register(asyncGraphId, { async: true });
    const missing = await request(server)
      .get(`/webhook/${asyncReg.token}/jobs/99999999`)
      .expect(404);
    expect(missing.body).toEqual({ error: 'job_not_found' });
  });

  it('管理面 enable：落库 + 回显 + 回传 url 触发生效（配置状态码）', async () => {
    createChatModelMock.mockImplementation(
      () => new FakeInvokeModel([{ content: '管理面输出' }]),
    );
    const res = await request(server)
      .post('/graph/webhook/enable')
      .send({ graphId: manageGraphId, statusCode: 201, fullAccess: true })
      .expect(200);
    const data = res.body.data as {
      enabled: boolean;
      url: string;
      statusCode: number;
      async: boolean;
      fullAccess: boolean;
    };
    expect(data.enabled).toBe(true);
    // url 相对路径（无头端部署 host 不定，控制端拼 base——适配点 6）
    expect(data.url).toMatch(/^\/webhook\/[0-9a-f]+$/);
    expect(data.statusCode).toBe(201);
    expect(data.fullAccess).toBe(true);
    expect(data.async).toBe(false);
    // option 行落库（JSON 配置形态，重装后启动装载同款）
    const row = await db.prisma.option.findFirstOrThrow({
      where: { type: 'webhook', name: `graph:${manageGraphId}` },
    });
    expect(JSON.parse(row.value)).toMatchObject({
      statusCode: 201,
      fullAccess: true,
      async: false,
    });
    // 回传 url 直接触发生效（默认体 + 配置状态码 201）
    const trigger = await request(server)
      .post(data.url)
      .send({ q: 'm' })
      .expect(201);
    expect(trigger.body).toEqual({ status: 'success', output: '管理面输出' });
  });

  it('管理面 enable 重开换 token：旧 token 404、新 token 可达', async () => {
    createChatModelMock.mockImplementation(
      () => new FakeInvokeModel([{ content: '重开输出' }]),
    );
    const enable = async () =>
      (
        (
          await request(server)
            .post('/graph/webhook/enable')
            .send({ graphId: manageGraphId })
            .expect(200)
        ).body.data as { url: string }
      ).url;
    const first = await enable();
    const second = await enable();
    expect(second).not.toBe(first);
    await request(server).post(first).send({ q: 'x' }).expect(404);
    const fresh = await request(server).post(second).send({ q: 'x' }).expect(200);
    expect(fresh.body).toEqual({ status: 'success', output: '重开输出' });
  });

  it('管理面 enable 图不存在：业务错 4040', async () => {
    const denied = (
      await request(server)
        .post('/graph/webhook/enable')
        .send({ graphId: 999999 })
        .expect(200)
    ).body as { code: string; success: boolean };
    expect(denied.success).toBe(false);
    expect(denied.code).toBe('4040');
  });

  it('管理面 status：注册态回显四配置、未注册 {enabled:false,url:""}', async () => {
    await request(server)
      .post('/graph/webhook/enable')
      .send({
        graphId: manageGraphId,
        responseTemplate: 'T={{nodes.x.output}}',
        statusCode: 202,
        async: true,
        fullAccess: true,
      })
      .expect(200);
    const on = (
      await request(server)
        .post('/graph/webhook/status')
        .send({ graphId: manageGraphId })
        .expect(200)
    ).body.data as Record<string, unknown>;
    expect(on.enabled).toBe(true);
    expect(on.responseTemplate).toBe('T={{nodes.x.output}}');
    expect(on.statusCode).toBe(202);
    expect(on.async).toBe(true);
    expect(on.fullAccess).toBe(true);
    expect(on.url).toMatch(/^\/webhook\//);

    // 关闭后未注册两态（disable 幂等：未注册同样回 disabled）
    await request(server)
      .post('/graph/webhook/disable')
      .send({ graphId: manageGraphId })
      .expect(200);
    const off = (
      await request(server)
        .post('/graph/webhook/status')
        .send({ graphId: manageGraphId })
        .expect(200)
    ).body.data as { enabled: boolean; url: string };
    expect(off).toEqual({ enabled: false, url: '' });
    await request(server)
      .post('/graph/webhook/disable')
      .send({ graphId: manageGraphId })
      .expect(200);
  });

  it('管理面 disable：注销清行 + 旧 token 404 + 未注册幂等', async () => {
    const enable = (
      await request(server)
        .post('/graph/webhook/enable')
        .send({ graphId: manageGraphId })
        .expect(200)
    ).body.data as { url: string };
    const off = (
      await request(server)
        .post('/graph/webhook/disable')
        .send({ graphId: manageGraphId })
        .expect(200)
    ).body.data as { enabled: boolean; url: string };
    expect(off).toEqual({ enabled: false, url: '' });
    // option 行已清 + 旧 token 404
    const row = await db.prisma.option.findFirst({
      where: { type: 'webhook', name: `graph:${manageGraphId}` },
    });
    expect(row).toBeNull();
    await request(server).post(enable.url).send({ q: 'x' }).expect(404);
    // 幂等：未注册图再 disable 同样回 disabled
    const again = (
      await request(server)
        .post('/graph/webhook/disable')
        .send({ graphId: manageGraphId })
        .expect(200)
    ).body.data as { enabled: boolean };
    expect(again.enabled).toBe(false);
  });

  it('管理面 disable 在途中止：service 层直测（独立长超时实例）', async () => {
    createChatModelMock.mockImplementation(() => new FakeInvokeModel([], true));
    // app 实例 syncTimeoutMs=150 会抢跑兜底（running 窗口窄于轮询间隔），
    // 在途中止语义经独立 60s 实例钉死（abort 必来自 disable 的 activeRuns
    // 清理而非同步超时；同 db 注册表，内存 Map 独立——enable/trigger/
    // disable 全走本实例自洽）
    const service = new WebhookService(db.prisma, { syncTimeoutMs: 60_000 });
    const enabled = await service.enableWebhook(hangGraphId);
    const token = enabled.url.slice('/webhook/'.length);
    const pending = service.trigger(token, { q: 'hang' }, 'http://t');
    await waitFor(async () => {
      const run = await db.prisma.automationRun.findFirstOrThrow({
        where: { graphId: hangGraphId, triggerType: 'webhook' },
        orderBy: { id: 'desc' },
      });
      expect(run.status).toBe('running');
    });
    const off = await service.disableWebhook(hangGraphId);
    expect(off.enabled).toBe(false);
    const outcome = await pending;
    expect(outcome.status).toBe(200);
    expect((outcome.body as { status: string }).status).toBe('failed');
    await waitFor(async () => {
      const run = await db.prisma.automationRun.findFirstOrThrow({
        where: { graphId: hangGraphId, triggerType: 'webhook' },
        orderBy: { id: 'desc' },
      });
      expect(run.status).not.toBe('running');
    });
  });

  it('外部系统语义（终审 F1）：TIANSHU_TOKEN 部署下无 Bearer 调 /webhook/<有效token> 通，其余端点仍 401', async () => {
    createChatModelMock.mockImplementation(
      () => new FakeInvokeModel([{ content: '免鉴权触发' }]),
    );
    process.env.TIANSHU_TOKEN = 'final-f1-secret';
    try {
      // spec §4.3 外部系统首义：仅凭每图 token 调用（不持 TIANSHU_TOKEN）——
      // 守卫豁免 contextPath/webhook/ 前缀（ruling 16）。legacytoken123
      // 已被前序用例的 enable 重开轮换失效（WH 批修复后旧 token 即时
      // 失效），免鉴权语义改用当前有效 token 验证
      const enable = (
        await request(server)
          .post('/graph/webhook/enable')
          .set('Authorization', 'Bearer final-f1-secret')
          .send({ graphId })
          .expect(200)
      ).body.data as { url: string };
      const res = await request(server)
        .post(enable.url)
        .send({ q: 'ext' })
        .expect(200);
      expect(res.body).toEqual({ status: 'success', output: '免鉴权触发' });

      // 豁免 ≠ 匿名通配：每图 token 自鉴权不受影响（未知 token 404）
      await request(server)
        .post('/webhook/deadbeefdeadbeef')
        .send({})
        .expect(404);

      // 其余端点守卫照常：无 Bearer 401、Bearer 放行
      const denied = await request(server)
        .post('/graph/query')
        .send({})
        .expect(401);
      expect((denied.body as WrappedBody<null>).success).toBe(false);
      const allowed = await request(server)
        .post('/graph/query')
        .set('Authorization', 'Bearer final-f1-secret')
        .send({})
        .expect(200);
      expect((allowed.body as WrappedBody<unknown>).code).toBe('2000');

      // WH 批：管理面不在豁免前缀——graph/webhook/* 无 Bearer 同样 401
      //（fullAccess 全权开关不可匿名可达，路径裁定的回归锚点）
      const manageDenied = await request(server)
        .post('/graph/webhook/status')
        .send({ graphId: 1 })
        .expect(401);
      expect((manageDenied.body as WrappedBody<null>).success).toBe(false);
    } finally {
      delete process.env.TIANSHU_TOKEN;
    }
  });
});

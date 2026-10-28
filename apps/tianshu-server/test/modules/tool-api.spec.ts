// TB-T1：POST /tool/respond 端点 e2e（spec §2.2）——桥挂起请求的控制端
// 回传入口（直连 HTTP 与 relay req 帧同达本路由）。覆盖（任务面）：
// 1. 正常收敛：命中挂起 requestId → 2000 {responded:true}，emit 侧 promise
//    收到 result（挂起-respond 匹配经真实 ToolModule 工厂装配的运行时）
// 2. 未知 requestId → 4005（一次性语义：requestId 不可猜测/重放）
// 3. 重复 respond（已收敛后同 id 再发）→ 4005
// 4. 失败结果透传：ok:false 的 error 原样到达 emit 侧（控制端拒绝回喂）
// 5. token 鉴权：TIANSHU_TOKEN 部署下无/错 Bearer 401（@Public 豁免 JWT，
//    静态 token 守卫仍拦——session/* 同款协议面语义）
// 6. DTO 校验：缺 requestId / result 形状不自洽（ok=true 无 output、
//    ok=false 无 error）→ 统一包装 5000 + 消息含字段名（本仓异常过滤器
//    对校验错 BadRequestException 的既定映射，session-approve 同款）
// 挂起注册表三路收敛语义由 test/core/bridge-registry.spec 覆盖。
import request from 'supertest'; // esModuleInterop 开启后 export= 不可命名空间直调
import * as http from 'node:http';
import { INestApplication } from '@nestjs/common';
import { ToolModule } from 'src/modules/tool/tool.module';
import { EventBusModule } from 'src/commons/event-bus/event-bus.module';
import { EventBusService } from 'src/commons/event-bus/event-bus.service';
import { emitToolRequest } from 'src/core/tools/bridge/bridge-registry';
import type { ToolRequestPayload } from '@tianshu/protocol';
import { createTestDb, type TestDb } from '../support/test-db';
import { createTestApp, WrappedBody } from '../support/test-app';

const TOKEN_KEY = 'TIANSHU_TOKEN';

describe('POST /tool/respond (e2e)', () => {
  let app: INestApplication;
  let server: http.Server;
  let db: TestDb;
  let bus: EventBusService;

  beforeAll(async () => {
    db = await createTestDb();
    const built = await createTestApp(db.prisma, [
      // 全局模块仍需实例化于测试容器（session-approve 同款注记）
      EventBusModule,
      ToolModule,
    ]);
    app = built.app;
    server = built.server;
    bus = app.get(EventBusService);
  });

  afterAll(async () => {
    await app.close();
    await db.cleanup();
  });

  const post = (path: string, body?: Record<string, unknown>): request.Test =>
    request(server)
      .post(path)
      .send(body ?? {});

  /** 挂一个「控制端连接」并捕获 tool.request——桥运行时经 ToolModule
   *  工厂以本 bus 为出口装配（真实装配链路，非手动 install） */
  function attachController(): {
    events: ToolRequestPayload[];
    detach: () => void;
  } {
    const events: ToolRequestPayload[] = [];
    const off = bus.subscribe((event) => {
      if (event.type === 'tool.request') events.push(event.payload);
    });
    return { events, detach: off };
  }

  it('正常收敛：命中挂起 requestId → 2000 {responded:true}，emit 侧收到 output', async () => {
    const controller = attachController();
    const pending = emitToolRequest(11, 'browser_snapshot', {});
    await Promise.resolve();
    const requestId = controller.events[0].requestId;

    const res = await post('/tool/respond', {
      requestId,
      result: { ok: true, output: '标题: 示例页\nURL: https://example.com' },
    }).expect(200);
    const body = res.body as WrappedBody<{ responded: boolean }>;
    expect(body.code).toBe('2000');
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ responded: true });
    await expect(pending).resolves.toEqual({
      ok: true,
      output: '标题: 示例页\nURL: https://example.com',
    });
    controller.detach();
  });

  it('未知 requestId → 4005（一次性：不可猜测/重放）', async () => {
    const res = await post('/tool/respond', {
      requestId: 'ghost-id',
      result: { ok: true, output: 'x' },
    }).expect(200);
    const body = res.body as WrappedBody<null>;
    expect(body.success).toBe(false);
    expect(body.code).toBe('4005');
    expect(String(body.message)).toContain('requestId');
  });

  it('重复 respond（已收敛后同 id 再发）→ 4005', async () => {
    const controller = attachController();
    const pending = emitToolRequest(12, 'browser_navigate', {
      url: 'https://example.com',
    });
    await Promise.resolve();
    const requestId = controller.events[0].requestId;

    await post('/tool/respond', {
      requestId,
      result: { ok: true, output: '已导航' },
    }).expect(200);
    await expect(pending).resolves.toEqual({ ok: true, output: '已导航' });

    const res = await post('/tool/respond', {
      requestId,
      result: { ok: true, output: 'replayed' },
    }).expect(200);
    const body = res.body as WrappedBody<null>;
    expect(body.success).toBe(false);
    expect(body.code).toBe('4005');
    // 重放不二次收敛（promise 已定格，值不被覆盖无从断言——挂起表空即可）
    controller.detach();
  });

  it('失败结果透传：ok:false 的 error 原样到达 emit 侧（控制端拒绝回喂）', async () => {
    const controller = attachController();
    const pending = emitToolRequest(13, 'browser_click', { idx: 2 });
    await Promise.resolve();
    const res = await post('/tool/respond', {
      requestId: controller.events[0].requestId,
      result: { ok: false, error: 'denied by user' },
    }).expect(200);
    expect((res.body as WrappedBody<unknown>).code).toBe('2000');
    await expect(pending).resolves.toEqual({
      ok: false,
      error: 'denied by user',
    });
    controller.detach();
  });

  it('token 鉴权：TIANSHU_TOKEN 部署下无/错 Bearer 401，正确 token 放行（@Public 不豁免静态守卫）', async () => {
    process.env[TOKEN_KEY] = 'bridge-secret';
    try {
      await post('/tool/respond', {
        requestId: 'x',
        result: { ok: true, output: 'x' },
      }).expect(401);
      await request(server)
        .post('/tool/respond')
        .set('Authorization', 'Bearer wrong')
        .send({ requestId: 'x', result: { ok: true, output: 'x' } })
        .expect(401);
      const res = await request(server)
        .post('/tool/respond')
        .set('Authorization', 'Bearer bridge-secret')
        .send({ requestId: 'x', result: { ok: true, output: 'x' } })
        .expect(200);
      // 鉴权通过后落业务校验（x 非挂起 id → 4005，非 401 即证明已过守卫）
      expect((res.body as WrappedBody<null>).code).toBe('4005');
    } finally {
      delete process.env[TOKEN_KEY];
    }
  });

  it('DTO 校验：缺 requestId / result 不自洽 → 5000 + 消息含字段名', async () => {
    const missing = await post('/tool/respond', {
      result: { ok: true, output: 'x' },
    }).expect(200);
    const missingBody = missing.body as WrappedBody<null>;
    expect(missingBody.success).toBe(false);
    expect(missingBody.code).toBe('5000');
    expect(String(missingBody.message)).toContain('requestId');

    const incoherentOk = await post('/tool/respond', {
      requestId: 'r',
      result: { ok: true },
    }).expect(200);
    expect((incoherentOk.body as WrappedBody<null>).code).toBe('5000');
    expect(String((incoherentOk.body as WrappedBody<null>).message)).toContain(
      'output',
    );

    const incoherentErr = await post('/tool/respond', {
      requestId: 'r',
      result: { ok: false },
    }).expect(200);
    expect((incoherentErr.body as WrappedBody<null>).code).toBe('5000');
    expect(String((incoherentErr.body as WrappedBody<null>).message)).toContain(
      'error',
    );
  });
});

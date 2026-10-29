// session/approve 端点 e2e（移动端 spec §4.3）：manual 模式挂起审批的远程
// 决议入口。ChatRunnerService 经 overrideProvider 换 approve 替身——本组
// 用例只钉 controller 薄转发契约（命中/未命中/DTO 校验）；挂起与超时语义
// 由 test/core/chat-runner.spec 与 approval.spec 覆盖。
import request from 'supertest'; // esModuleInterop 开启后 export= 不可命名空间直调
import * as http from 'node:http';
import { INestApplication } from '@nestjs/common';
import { SessionModule } from 'src/modules/session/session.module';
import { ChatRunnerService } from 'src/core/chat-runner.service';
import { EventBusModule } from 'src/commons/event-bus/event-bus.module';
import { createTestDb, type TestDb } from '../support/test-db';
import { createTestApp, WrappedBody } from '../support/test-app';

describe('POST /session/approve (e2e)', () => {
  let app: INestApplication;
  let server: http.Server;
  let db: TestDb;
  /** approveRemember 替身：首响应答命中，此后未命中（已应答/不存在）；
   *  remembered 依 (remember && approved && toolName) 派生——真表写链
   *  由 chat-runner.spec 覆盖，本组只钉 controller/service 转发契约 */
  let approveStub: jest.Mock;

  beforeAll(async () => {
    db = await createTestDb();
    // remember 归属校验用例的会话行（COMPANION_USER_ID=1 归属）
    await db.prisma.workspace.create({
      data: { name: 'ws-approve', userId: 1 },
    });
    await db.prisma.sessionRecord.create({
      data: { id: 1, workspaceId: 1, userId: 1 },
    });
    approveStub = jest.fn(
      async (
        _sessionId: number,
        toolCallId: string,
        approved: boolean,
        remember: boolean,
        toolName: string | null,
      ) =>
        toolCallId === 'tc-x'
          ? { hit: true, remembered: remember && approved && toolName != null }
          : { hit: false, remembered: false },
    );
    const built = await createTestApp(
      db.prisma,
      // SessionService 依赖全局 EventBusService（全局模块仍需实例化于测试容器）
      [EventBusModule, SessionModule],
      (builder) =>
        builder.overrideProvider(ChatRunnerService).useValue({
          approveRemember: approveStub,
        }),
    );
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

  it('应答命中 pending：2000 成功 {responded:true}，参数五元透传（审批记忆批）', async () => {
    const res = await post('/session/approve', {
      sessionId: 1,
      toolCallId: 'tc-x',
      approved: true,
    }).expect(200);
    const body = res.body as WrappedBody<{
      responded: boolean;
      remembered: boolean;
    }>;
    expect(body.code).toBe('2000');
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ responded: true, remembered: false });
    expect(approveStub).toHaveBeenCalledWith(1, 'tc-x', true, false, null);
  });

  it('remember+toolName 透传：remembered 随真值返回', async () => {
    const res = await post('/session/approve', {
      sessionId: 1,
      toolCallId: 'tc-x',
      approved: true,
      remember: true,
      toolName: 'write',
    }).expect(200);
    const body = res.body as WrappedBody<{
      responded: boolean;
      remembered: boolean;
    }>;
    expect(body.code).toBe('2000');
    expect(body.data).toEqual({ responded: true, remembered: true });
    expect(approveStub).toHaveBeenLastCalledWith(
      1,
      'tc-x',
      true,
      true,
      'write',
    );
  });

  it('remember+拒绝：不写记忆（remembered:false）', async () => {
    const res = await post('/session/approve', {
      sessionId: 1,
      toolCallId: 'tc-x',
      approved: false,
      remember: true,
      toolName: 'write',
    }).expect(200);
    const body = res.body as WrappedBody<{ remembered: boolean }>;
    expect(body.code).toBe('2000');
    expect(body.data!.remembered).toBe(false);
  });

  it('remember+会话不存在（归属校验升格）：业务错 4040', async () => {
    const res = await post('/session/approve', {
      sessionId: 999,
      toolCallId: 'tc-x',
      approved: true,
      remember: true,
      toolName: 'write',
    }).expect(200);
    const body = res.body as WrappedBody<null>;
    expect(body.success).toBe(false);
    expect(body.code).toBe('4040');
  });

  it('同参再发（已应答/不存在）：业务错 4040（包装 success:false）', async () => {
    const res = await post('/session/approve', {
      sessionId: 1,
      toolCallId: 'tc-miss',
      approved: true,
    }).expect(200);
    const body = res.body as WrappedBody<null>;
    expect(body.success).toBe(false);
    expect(body.code).toBe('4040');
  });

  it('缺 toolCallId：DTO 校验错（统一包装体 success:false，消息含字段名）', async () => {
    // 本仓异常过滤器把一切 HttpException 包成 HTTP 200 + code（校验错
    // BadRequestException 在 ErrorCodeFactory 无映射项落 5000）
    const res = await post('/session/approve', {
      sessionId: 1,
      approved: true,
    }).expect(200);
    const body = res.body as WrappedBody<null>;
    expect(body.success).toBe(false);
    expect(body.code).toBe('5000');
    expect(String(body.message)).toContain('toolCallId');
  });
});

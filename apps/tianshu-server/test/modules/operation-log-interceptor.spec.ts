import { ExecutionContext } from '@nestjs/common';
import { of, firstValueFrom } from 'rxjs';
import { FastifyReply, FastifyRequest } from 'fastify';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import {
  OperationLogInterceptor,
  SKIP_OPERATION_LOG,
} from 'src/modules/operationlog/operation-log.interceptor';
import { OperationLogService } from 'src/modules/operationlog/operation-log.service';
import { OperationLog } from 'src/modules/operationlog/operation-log.entity';

/**
 * 操作日志配置驱动开关（security.md §6 P0-2，遗留 #5）：config.yml
 * `operationLog.enabled` 缺省 true（启用——表与拦截器齐备但脚手架
 * DISABLE_LOG 写死停用的遗留收口）；false 拦截器直通不落表。脱敏口径
 * 对齐桌面审计链 commandPreview 先例：details 只记 method + 截断 100
 * 字符的 url 预览（token query 打码），不落 params/query/body；IP/UA
 * 由表列既有承载。拦截器直构（request-logger.spec 同款替身法）。
 */

interface CapturedLog {
  entity: OperationLog;
}

function buildHarness(options?: {
  config?: Record<string, unknown>;
  skipMetadata?: boolean;
  request?: Partial<FastifyRequest>;
}) {
  const captured: CapturedLog[] = [];
  const service = {
    create: async (entity: OperationLog) => {
      captured.push({ entity });
      return entity;
    },
  } as unknown as OperationLogService;
  const reflector = {
    getAllAndOverride: () => options?.skipMetadata ?? false,
  } as unknown as Reflector;
  const configService = {
    get: (key: string) =>
      key === 'operationLog' ? options?.config : undefined,
  } as unknown as ConfigService;
  const interceptor = new OperationLogInterceptor(
    service,
    reflector,
    configService,
  );
  return { interceptor, captured };
}

function buildContext(request: Partial<FastifyRequest>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ statusCode: 200 }) as Partial<FastifyReply>,
    }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

/** 带 operateContext 的已认证请求替身（operateContext 为守卫附加属性） */
type RequestLike = Partial<FastifyRequest> & { operateContext?: unknown };

function authedRequest(over: RequestLike = {}): Partial<FastifyRequest> {
  return {
    url: '/user/query?page=1',
    method: 'POST',
    ip: '192.168.1.10',
    headers: { 'user-agent': 'jest-agent' },
    operateContext: { operator: { code: 'u1' } },
    ...over,
  } as Partial<FastifyRequest>;
}

async function runOnce(
  harness: ReturnType<typeof buildHarness>,
  request: Partial<FastifyRequest>,
): Promise<void> {
  await firstValueFrom(
    harness.interceptor.intercept(buildContext(request), {
      handle: () => of(undefined),
    }),
  );
}

describe('OperationLogInterceptor 配置驱动开关', () => {
  it('缺省（config 无 operationLog 段）：启用——成功请求落表 status SUCCESS', async () => {
    const harness = buildHarness();
    await runOnce(harness, authedRequest());
    expect(harness.captured).toHaveLength(1);
    expect(harness.captured[0].entity.status).toBe('SUCCESS');
    expect(harness.captured[0].entity.userId).toBe('u1');
    expect(harness.captured[0].entity.operation).toBe('/user/query');
  });

  it('operationLog.enabled: false：直通不落表（业务响应不受影响）', async () => {
    const harness = buildHarness({ config: { enabled: false } });
    const data = await firstValueFrom(
      harness.interceptor.intercept(buildContext(authedRequest()), {
        handle: () => of({ ok: 1 }),
      }),
    );
    expect(data).toEqual({ ok: 1 });
    expect(harness.captured).toHaveLength(0);
  });

  it('operationLog: {}（段在场缺 enabled）：仍启用（缺省 true）', async () => {
    const harness = buildHarness({ config: {} });
    await runOnce(harness, authedRequest());
    expect(harness.captured).toHaveLength(1);
  });

  it('operationLog.enabled: true 显式：启用', async () => {
    const harness = buildHarness({ config: { enabled: true } });
    await runOnce(harness, authedRequest());
    expect(harness.captured).toHaveLength(1);
  });

  it('SkipOperationLog 装饰器：跳过不落表', async () => {
    const harness = buildHarness({ skipMetadata: true });
    await runOnce(harness, authedRequest());
    expect(harness.captured).toHaveLength(0);
  });

  it('无 operateContext（未认证/公共面）：跳过不落表', async () => {
    const harness = buildHarness();
    await runOnce(harness, authedRequest({ operateContext: undefined }));
    expect(harness.captured).toHaveLength(0);
  });

  it('错误响应：落表 status ERROR（异常继续上抛）', async () => {
    const harness = buildHarness();
    const { throwError } = await import('rxjs');
    await firstValueFrom(
      harness.interceptor.intercept(buildContext(authedRequest()), {
        handle: () => throwError(() => new Error('boom')),
      }),
    ).catch(() => of('rethrown'));
    expect(harness.captured).toHaveLength(1);
    expect(harness.captured[0].entity.status).toBe('ERROR');
  });

  it('IP/UA 提取：x-forwarded-for 首段优先、UA 落列', async () => {
    const harness = buildHarness();
    await runOnce(
      harness,
      authedRequest({
        headers: {
          'user-agent': 'Mobile/1.0',
          'x-forwarded-for': '10.0.0.1, 10.0.0.2',
        } as FastifyRequest['headers'],
      }),
    );
    expect(harness.captured[0].entity.ipAddress).toBe('10.0.0.1');
    expect(harness.captured[0].entity.userAgent).toBe('Mobile/1.0');
  });
});

describe('OperationLogInterceptor details 脱敏（commandPreview 口径）', () => {
  it('details 只记 method + url 预览：query token 打码、超长截断 100、params/query/body 不落', async () => {
    const harness = buildHarness();
    const longTail = 'x'.repeat(200);
    await runOnce(
      harness,
      authedRequest({
        url: `/event?token=secret-token&stream=1&tail=${longTail}`,
        method: 'GET',
        query: { token: 'secret-token' },
        params: { id: 7 },
        body: { password: 'p@ss' },
      } as Partial<FastifyRequest>),
    );
    const details = harness.captured[0].entity.details as Record<
      string,
      unknown
    >;
    expect(details.method).toBe('GET');
    expect(String(details.url)).not.toContain('secret-token');
    expect(String(details.url)).toContain('***');
    expect(String(details.url).length).toBeLessThanOrEqual(100);
    expect(JSON.stringify(details)).not.toContain('p@ss');
    expect(details.query).toBeUndefined();
    expect(details.params).toBeUndefined();
    expect(details.body).toBeUndefined();
    // operation 列仍是去 query 的纯路径
    expect(harness.captured[0].entity.operation).toBe('/event');
  });

  it('/webhook/ 路径段 token 同步打码（request-logger 同口径）', async () => {
    const harness = buildHarness();
    await runOnce(
      harness,
      authedRequest({ url: '/webhook/abcdef0123456789abcdef0123456789' }),
    );
    const details = harness.captured[0].entity.details as Record<
      string,
      unknown
    >;
    expect(String(details.url)).not.toContain('abcdef0123456789');
    expect(String(details.url)).toContain('/webhook/***');
  });
});

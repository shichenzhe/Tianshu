import { ExecutionContext } from '@nestjs/common';
import { of, firstValueFrom } from 'rxjs';
import { FastifyReply, FastifyRequest } from 'fastify';
import { LoggerFactory } from 'src/commons/log/logger-factory';
import { Logger } from 'src/commons/log/logger';
import { RequestLoggerInterceptor } from 'src/commons/web/interceptor/request-logger.interceptor';

/**
 * 请求日志凭据脱敏（终审必修 1）：url/query 的 token、authorization 头、
 * 响应体（及请求体）中 apiKey/authKey/token/accessToken/refreshToken 键值
 * 打码为 ***——日志落盘旋转保留 7 天，不可回传明文。拦截器直构（LoggerFactory
 * 替身捕获 info 调用），不经 Nest 测试模块。
 */

interface CapturedLog {
  level: 'info' | 'warn' | 'error';
  message: string;
}

function buildInterceptor() {
  const logs: CapturedLog[] = [];
  const fakeLogger = {
    info: (message: string) => logs.push({ level: 'info', message }),
    warn: (message: string) => logs.push({ level: 'warn', message }),
    error: (message: string) => logs.push({ level: 'error', message }),
  } as unknown as Logger;
  const factory = {
    create: () => fakeLogger,
  } as unknown as LoggerFactory;
  return { interceptor: new RequestLoggerInterceptor(factory), logs };
}

/** 构造仅含拦截器所读字段的 mock ExecutionContext */
function buildContext(
  request: Partial<FastifyRequest>,
  response: Partial<FastifyReply> = { statusCode: 200 },
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

/** 跑一轮拦截：返回 {请求行 JSON, 响应行 JSON, 响应体对象}（各取首条 info） */
async function runOnce(
  request: Partial<FastifyRequest>,
  responseData: unknown,
) {
  const { interceptor, logs } = buildInterceptor();
  await firstValueFrom(
    interceptor.intercept(buildContext(request), {
      handle: () => of(responseData),
    }),
  );
  const requestLog = JSON.parse(
    logs.find((l) => l.message.includes('url'))!.message,
  );
  const responseLog = JSON.parse(
    logs.filter((l) => l.message.includes('response'))[0].message,
  );
  // response 字段为 sanitize 后的 JSON 字符串（未截断时可回解）
  const responseBody =
    typeof responseLog.response === 'string' &&
    responseLog.response.length < 4096
      ? JSON.parse(responseLog.response)
      : undefined;
  return { requestLog, responseLog, responseBody };
}

describe('RequestLoggerInterceptor 凭据脱敏', () => {
  it('url 与 queryParams 的 token 打码 ***，其余参数保留', async () => {
    const { requestLog } = await runOnce(
      {
        method: 'GET',
        url: '/event?token=secret-token&stream=1',
        query: { token: 'secret-token', stream: '1' },
        headers: {},
      },
      null,
    );
    expect(requestLog.url).toBe('/event?token=***&stream=1');
    expect(requestLog.url).not.toContain('secret-token');
    expect(requestLog.queryParams).toEqual({ token: '***', stream: '1' });
  });

  it('url 中段参数 token 打码（非首个参数）', async () => {
    const { requestLog } = await runOnce(
      {
        method: 'GET',
        url: '/session/query?page=1&token=abc&size=10',
        query: { page: '1', token: 'abc', size: '10' },
        headers: {},
      },
      null,
    );
    expect(requestLog.url).toBe('/session/query?page=1&token=***&size=10');
    expect(requestLog.queryParams.token).toBe('***');
  });

  it('authorization 头剔除（Bearer 凭证不落日志），其余头保留', async () => {
    const { requestLog } = await runOnce(
      {
        method: 'POST',
        url: '/session/send',
        headers: {
          authorization: 'Bearer secret-token',
          host: '127.0.0.1:3000',
          'content-type': 'application/json',
        },
      },
      { code: '2000' },
    );
    expect(requestLog.headers).not.toHaveProperty('authorization');
    expect(JSON.stringify(requestLog.headers)).not.toContain('secret-token');
    expect(requestLog.headers).toHaveProperty('host');
  });

  it('响应体 provider/query 形状：records[].apiKey 递归打码，非敏感字段保留', async () => {
    const { responseLog, responseBody } = await runOnce(
      { method: 'POST', url: '/provider/query', headers: {} },
      {
        code: '2000',
        success: true,
        data: {
          records: [
            { id: 1, name: 'openai', apiKey: 'sk-plain-secret' },
            { id: 2, name: 'ollama', apiKey: null },
          ],
          total: 2,
        },
      },
    );
    expect(responseLog.response).not.toContain('sk-plain-secret');
    expect(responseBody!.data.records[0].apiKey).toBe('***');
    expect(responseBody!.data.records[0].name).toBe('openai');
    // null 值原样保留（区别于“已打码”）
    expect(responseBody!.data.records[1].apiKey).toBeNull();
    expect(responseBody!.data.total).toBe(2);
  });

  it('响应体嵌套（data.records 一层）与 accessToken/refreshToken 键打码', async () => {
    const { responseLog, responseBody } = await runOnce(
      { method: 'POST', url: '/auth/login', headers: {} },
      {
        data: {
          accessToken: 'jwt-access-secret',
          refreshToken: 'jwt-refresh-secret',
          nested: { apiKey: 'deep-key', keep: 'ok' },
        },
      },
    );
    expect(responseLog.response).not.toContain('jwt-access-secret');
    expect(responseLog.response).not.toContain('jwt-refresh-secret');
    expect(responseLog.response).not.toContain('deep-key');
    expect(responseBody!.data.nested.keep).toBe('ok');
  });

  it('备份 claim 凭据打码（备份多用户批复审）：包装响应 data.clientToken 整值 ***，clientId 保留', async () => {
    // backup/claim 响应经 ResponseInterceptor 包装后 tap 侧看到的形状——
    // clientToken 为长期设备凭据（spec 2026-10-28「明文仅 claim 回显一次」
    // 不变量：日志面也不得落盘）
    const { responseLog, responseBody } = await runOnce(
      { method: 'POST', url: '/backup/claim', headers: {} },
      {
        code: '2000',
        success: true,
        data: { clientId: 'imac-1', clientToken: 'device-longterm-secret' },
      },
    );
    expect(responseLog.response).not.toContain('device-longterm-secret');
    expect(responseBody!.data.clientToken).toBe('***');
    expect(responseBody!.data.clientId).toBe('imac-1');
  });

  it('请求体 apiKey 打码（provider/save upsert 携带明文密钥）', async () => {
    const { requestLog } = await runOnce(
      {
        method: 'POST',
        url: '/provider/save',
        body: {
          providers: [
            { name: 'openai', apiKey: 'sk-plain-secret', baseUrl: 'https://x' },
          ],
        },
        headers: {},
      },
      { code: '2000' },
    );
    const logged = JSON.stringify(requestLog.body);
    expect(logged).not.toContain('sk-plain-secret');
    expect(requestLog.body.providers[0].apiKey).toBe('***');
    expect(requestLog.body.providers[0].baseUrl).toBe('https://x');
  });

  it('打码不改写原对象（响应体原值透传客户端，仅日志打码）', async () => {
    const responseData = { data: { records: [{ apiKey: 'sk-plain-secret' }] } };
    await runOnce(
      { method: 'POST', url: '/provider/query', headers: {} },
      responseData,
    );
    expect(responseData.data.records[0].apiKey).toBe('sk-plain-secret');
  });

  it('口令面打码（复审补）：login 请求体 password 与 user 响应 passwordHash/改密三键', async () => {
    // /auth/login 请求体 password
    const { requestLog } = await runOnce(
      {
        method: 'POST',
        url: '/auth/login',
        body: { username: 'admin', password: '123456-plain' },
        headers: {},
      },
      { code: '2000' },
    );
    expect(JSON.stringify(requestLog.body)).not.toContain('123456-plain');
    expect(requestLog.body.password).toBe('***');
    expect(requestLog.body.username).toBe('admin');

    // user query 响应 records[].passwordHash（bcrypt 摘要）
    const { responseLog, responseBody } = await runOnce(
      { method: 'POST', url: '/user/query', headers: {} },
      {
        data: {
          records: [
            { id: 1, username: 'admin', passwordHash: '$2b$10$hashvalue' },
          ],
        },
      },
    );
    expect(responseLog.response).not.toContain('$2b$10$hashvalue');
    expect(responseBody!.data.records[0].passwordHash).toBe('***');
    expect(responseBody!.data.records[0].username).toBe('admin');

    // 改密 DTO 三键（oldPassword/newPassword/confirmPassword）
    const change = await runOnce(
      {
        method: 'POST',
        url: '/auth/change-password',
        body: {
          oldPassword: 'old-plain',
          newPassword: 'new-plain',
          confirmPassword: 'new-plain',
        },
        headers: {},
      },
      { code: '2000' },
    );
    const loggedChange = JSON.stringify(change.requestLog.body);
    expect(loggedChange).not.toContain('old-plain');
    expect(loggedChange).not.toContain('new-plain');
    expect(change.requestLog.body).toEqual({
      oldPassword: '***',
      newPassword: '***',
      confirmPassword: '***',
    });
  });

  it('超长响应仍截断 4096 字符（打码后口径）', async () => {
    const big = { data: { blob: 'x'.repeat(9000) } };
    const { responseLog } = await runOnce(
      { method: 'POST', url: '/provider/query', headers: {} },
      big,
    );
    expect((responseLog.response as string).length).toBe(4096);
  });
});

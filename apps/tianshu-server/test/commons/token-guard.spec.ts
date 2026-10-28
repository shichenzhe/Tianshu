import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { StaticTokenGuard } from 'src/commons/auth/guard/token.guard';

describe('StaticTokenGuard', () => {
  let guard: StaticTokenGuard;
  const TOKEN_KEY = 'TIANSHU_TOKEN';
  let originalToken: string | undefined;

  /** 构造仅含 headers/query/url 的 mock ExecutionContext（guard 不读其它字段） */
  const buildContext = (
    headers: Record<string, string> = {},
    query: Record<string, string> = {},
    url?: string,
  ): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ headers, query, url }),
      }),
    }) as unknown as ExecutionContext;

  /** 仅 app.contextPath 生效的最小 ConfigService 替身 */
  const contextPathConfig = (contextPath: string): ConfigService =>
    ({
      get: (key: string) => (key === 'app' ? { contextPath } : undefined),
    }) as unknown as ConfigService;

  beforeEach(() => {
    guard = new StaticTokenGuard();
    originalToken = process.env[TOKEN_KEY];
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env[TOKEN_KEY];
    } else {
      process.env[TOKEN_KEY] = originalToken;
    }
  });

  it('TIANSHU_TOKEN 未设置时放行（dev 模式）', () => {
    delete process.env[TOKEN_KEY];
    expect(guard.canActivate(buildContext())).toBe(true);
  });

  it('Authorization: Bearer 正确时放行', () => {
    process.env[TOKEN_KEY] = 'secret-token';
    const context = buildContext({ authorization: 'Bearer secret-token' });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('?token= query 正确时放行（SSE EventSource 无法带 header）', () => {
    process.env[TOKEN_KEY] = 'secret-token';
    const context = buildContext({}, { token: 'secret-token' });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('TIANSHU_TOKEN 已设置但无任何凭证时 401', () => {
    process.env[TOKEN_KEY] = 'secret-token';
    expect(() => guard.canActivate(buildContext())).toThrow(
      UnauthorizedException,
    );
  });

  it('Bearer token 错误时 401', () => {
    process.env[TOKEN_KEY] = 'secret-token';
    const context = buildContext({ authorization: 'Bearer wrong-token' });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('authorization 缺少 Bearer scheme 时 401（裸 token 不接受）', () => {
    process.env[TOKEN_KEY] = 'secret-token';
    const context = buildContext({ authorization: 'secret-token' });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('query token 错误时 401', () => {
    process.env[TOKEN_KEY] = 'secret-token';
    const context = buildContext({}, { token: 'wrong-token' });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('webhook 前缀豁免（终审 F1）：/webhook/ 路径无凭证放行（含 jobs 子路径），每图 token 自鉴权兜底', () => {
    process.env[TOKEN_KEY] = 'secret-token';
    expect(guard.canActivate(buildContext({}, {}, '/webhook/abc123'))).toBe(
      true,
    );
    expect(
      guard.canActivate(buildContext({}, {}, '/webhook/abc123/jobs/9')),
    ).toBe(true);
  });

  it('豁免锚定路径起点：非 /webhook 前缀路径即使 query 含 /webhook/ 串仍 401', () => {
    process.env[TOKEN_KEY] = 'secret-token';
    expect(() =>
      guard.canActivate(
        buildContext({}, {}, '/graph/query?next=/webhook/abc123'),
      ),
    ).toThrow(UnauthorizedException);
  });

  it('豁免前缀含 contextPath 拼装：/api 前缀部署下 /api/webhook/ 通、裸 /webhook/ 仍 401', () => {
    process.env[TOKEN_KEY] = 'secret-token';
    const apiGuard = new StaticTokenGuard(contextPathConfig('/api'));
    expect(apiGuard.canActivate(buildContext({}, {}, '/api/webhook/abc'))).toBe(
      true,
    );
    expect(() =>
      apiGuard.canActivate(buildContext({}, {}, '/webhook/abc')),
    ).toThrow(UnauthorizedException);
  });

  it('backup 前缀豁免：/backup/ 路径无凭证放行（backup 面鉴权自成体系，BackupGuard 二层兜底）', () => {
    process.env[TOKEN_KEY] = 'secret-token';
    expect(guard.canActivate(buildContext({}, {}, '/backup/create'))).toBe(
      true,
    );
    expect(
      guard.canActivate(
        buildContext(
          {},
          {},
          '/backup/0a1b2c3d-e4f5-6789-0a1b-2c3d4e5f6789/chunk',
        ),
      ),
    ).toBe(true);
  });

  it('backup 豁免锚定路径起点：非 /backup 前缀路径即使 query 含 /backup/ 串仍 401', () => {
    process.env[TOKEN_KEY] = 'secret-token';
    expect(() =>
      guard.canActivate(
        buildContext({}, {}, '/session/query?next=/backup/create'),
      ),
    ).toThrow(UnauthorizedException);
  });

  it('backup 豁免前缀含 contextPath 拼装：/api 前缀部署下 /api/backup/ 通、裸 /backup/ 仍 401；webhook 豁免不回归', () => {
    process.env[TOKEN_KEY] = 'secret-token';
    const apiGuard = new StaticTokenGuard(contextPathConfig('/api'));
    expect(apiGuard.canActivate(buildContext({}, {}, '/api/backup/list'))).toBe(
      true,
    );
    expect(() =>
      apiGuard.canActivate(buildContext({}, {}, '/backup/list')),
    ).toThrow(UnauthorizedException);
    // webhook 豁免不回归（两豁免前缀互不影响）
    expect(apiGuard.canActivate(buildContext({}, {}, '/api/webhook/abc'))).toBe(
      true,
    );
  });
});

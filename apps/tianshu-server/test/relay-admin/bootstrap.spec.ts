// relay-admin 独立入口 bootstrap e2e（Task 9）：管理员 JWT 鉴权 + 统一包装
// + health——对 RaAppModule（src/relay-admin/app.module.ts）整树起 Test 模块，
// 真实 RA Prisma 临时库 + 真实守卫/拦截器/过滤器链。
//
// 导入真实 configuration.ts 需绕开 jest 路径坑（configuration-secret-chain.spec
// 同款）：其顶层按 __dirname 解析 <root>/config/config.yml（运行态为
// dist/config/config.yml，jest 直跑 src 下不存在）——mock fs 让 config.yml
// 探测命中内存假配置（磁盘/内存健康检查关闭，保持用例密闭）。
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  const fakeYaml = [
    'database:',
    "  url: 'file:./ra-bootstrap-test.db'",
    'app:',
    "  name: 'relay-admin-test'",
    'response:',
    '  excludePaths:',
    '    - /actuator/health',
    'auth:',
    '  jwt:',
    "    expiresIn: '30m'",
    "    refreshExpiresIn: '12h'",
    'log:',
    "  level: 'info'",
    "  dir: './logs'",
    '  maxSize: 50MB',
    '  maxFiles: 10',
    '  maxDays: 7',
    '  datePattern: YYYY-MM-DD',
    '  format: YYYY-MM-DD HH:mm:ss,SSS',
    'management:',
    '  health:',
    '    diskSpace:',
    '      enabled: false',
    '    memory:',
    '      enabled: false',
  ].join('\n');
  return {
    ...actual,
    existsSync: (path: unknown): boolean =>
      typeof path === 'string' && path.endsWith('/config.yml')
        ? true
        : actual.existsSync(path as Parameters<typeof actual.existsSync>[0]),
    readFileSync: (
      path: unknown,
      ...rest: Parameters<typeof actual.readFileSync>[1][]
    ): ReturnType<typeof actual.readFileSync> =>
      typeof path === 'string' && path.endsWith('/config.yml')
        ? fakeYaml
        : actual.readFileSync(
            path as Parameters<typeof actual.readFileSync>[0],
            ...rest,
          ),
  };
});

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { FastifyInstance } from 'fastify';
import * as http from 'node:http';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest'; // esModuleInterop 开启后 export= 不可命名空间直调
import * as bcrypt from 'bcrypt';
import { RaAppModule } from 'src/relay-admin/app.module';
import { PrismaClient } from 'src/relay-admin/generated/prisma';
import { JwtAuthService } from 'src/commons/auth/jwt-auth.service';

/** 测试管理员口令（seed 时写入 bcrypt 摘要；base64url 16+ 字符满足 DTO 校验） */
const TEST_ADMIN_PASSWORD = 'ra-bootstrap-test-pass';

describe('relay-admin bootstrap（Task 9：鉴权/统一包装/health）', () => {
  let app: INestApplication;
  let server: http.Server;
  let tmpRoot: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    // RA 库指向临时文件（client 构造期解析 env——须先于 Test 模块编译）
    tmpRoot = mkdtempSync(join(tmpdir(), 'relay-admin-bootstrap-'));
    const dbUrl = `file:${join(tmpRoot, 'relay-admin.db')}`;
    for (const key of [
      'RA_DATABASE_URL',
      'JWT_SECRET',
      'TIANSHU_LOG_DIR',
    ] as const) {
      savedEnv[key] = process.env[key];
    }
    process.env.RA_DATABASE_URL = dbUrl;
    process.env.JWT_SECRET = 'ra-bootstrap-test-secret';
    process.env.TIANSHU_LOG_DIR = join(tmpRoot, 'logs');

    // 建表：db push 直用 RA schema（datasource 已是 env("RA_DATABASE_URL")，
    // 无需 test-db.ts 的 schema 改写步骤）
    const projectRoot = join(__dirname, '..', '..');
    execSync(
      `node ${join(
        projectRoot,
        'node_modules',
        'prisma',
        'build',
        'index.js',
      )} db push --skip-generate --schema ${join(
        projectRoot,
        'prisma',
        'relay-admin',
        'schema.prisma',
      )}`,
      { env: { ...process.env, RA_DATABASE_URL: dbUrl }, stdio: 'pipe' },
    );

    // seed 已知口令管理员（脚本 seed 打印随机口令，测试改直插行）
    const seedClient = new PrismaClient();
    await seedClient.raAdminUser.create({
      data: {
        username: 'admin',
        passwordHash: await bcrypt.hash(TEST_ADMIN_PASSWORD, 10),
      },
    });
    await seedClient.$disconnect();

    const moduleRef = await Test.createTestingModule({
      imports: [RaAppModule],
    }).compile();
    app = moduleRef.createNestApplication(new FastifyAdapter());
    // 与 relay-admin/main.ts 同款全局管道：transform + 隐式类型转换
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    await (app.getHttpAdapter().getInstance() as FastifyInstance).ready();
    server = app.getHttpServer() as http.Server;
  });

  afterAll(async () => {
    await app.close();
    rmSync(tmpRoot, { recursive: true, force: true });
    for (const key of Object.keys(savedEnv) as (keyof typeof savedEnv)[]) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('未带 JWT 访问受保护业务路由（users 列表）→ 401', async () => {
    const response = await request(server).get('/relay-admin/users');
    expect(response.status).toBe(401);
  });

  it('login 换 token 后访问 users 列表 → 200 且 {code,message,data} 统一包装', async () => {
    const login = await request(server)
      .post('/relay-admin/auth/login')
      .send({ username: 'admin', password: TEST_ADMIN_PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.code).toBe('2000');
    const accessToken: string | undefined = login.body.data?.accessToken;
    expect(typeof accessToken).toBe('string');
    expect(typeof login.body.data?.refreshToken).toBe('string');

    // Task 10 起探针由真实路由顶替：空库列表返回 data: []
    const list = await request(server)
      .get('/relay-admin/users')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(list.status).toBe(200);
    expect(list.body).toEqual({
      code: '2000',
      success: true,
      data: [],
      message: 'success',
    });
  });

  it('错误口令 login → 401（不签发 token）', async () => {
    const response = await request(server)
      .post('/relay-admin/auth/login')
      .send({ username: 'admin', password: 'wrong-password' });
    expect(response.status).toBe(401);
    expect(response.body.data).toBeNull();
  });

  it('载荷 sub 非 ra_admin_user 行（幻影/跨域 token）→ users 列表 401', async () => {
    // 签名合法但 sub 不在管理员表：回查必须拒绝（操作者身份只认 ra_admin_user）
    const jwtAuthService = app.get(JwtAuthService);
    const { accessToken } = jwtAuthService.generateTokens({
      sub: 'not-an-ra-admin-id',
      username: 'ghost',
      name: 'ghost',
      roles: ['ra-admin'],
    });
    const response = await request(server)
      .get('/relay-admin/users')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(response.status).toBe(401);
  });

  it('/actuator/health → 200（excludePaths 直出 Terminus 体）', async () => {
    const response = await request(server).get('/actuator/health');
    expect(response.status).toBe(200);
    // 直出（无统一包装）：Terminus 体顶层 status=ok（up 是各指标项语义）
    expect(response.body).toEqual(
      expect.objectContaining({ status: 'ok' }),
    );
  });
});

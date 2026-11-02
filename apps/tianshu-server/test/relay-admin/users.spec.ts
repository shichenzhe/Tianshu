// relay-admin users API e2e（Task 10）：建户/列表/disable 级联/enable 不恢复
// AK/未鉴权 401/BusinessException 错误面——对 RaAppModule 整树起 Test 模块，
// 真实 RA Prisma 临时库 + 真实守卫/拦截器/过滤器链。
//
// 环境模式与 bootstrap.spec.ts 同款（fs mock 假 config.yml 必须 log.maxDays——
// file-stream-rotator 无兜底，缺它直接崩）；audit 断言用字面量 action 名
// （不用实现侧常量自比——跨段终验清单教训）。
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  const fakeYaml = [
    'database:',
    "  url: 'file:./ra-users-test.db'",
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
import { RaPrismaService } from 'src/relay-admin/prisma.service';

/** 测试管理员口令（seed 时写入 bcrypt 摘要；base64url 16+ 字符满足 DTO 校验） */
const TEST_ADMIN_PASSWORD = 'ra-users-test-pass';

describe('relay-admin users API（Task 10）', () => {
  let app: INestApplication;
  let server: http.Server;
  let raPrisma: RaPrismaService;
  let tmpRoot: string;
  let accessToken: string;
  const savedEnv: Record<string, string | undefined> = {};

  /** 管理员登录换取 accessToken（beforeAll 一次，套件内复用） */
  async function login(): Promise<string> {
    const login = await request(server)
      .post('/relay-admin/auth/login')
      .send({ username: 'admin', password: TEST_ADMIN_PASSWORD });
    expect(login.status).toBe(200);
    return login.body.data.accessToken as string;
  }

  /** 经 API 建户（返回 {userId, tenantId}） */
  async function createUserViaApi(name: string): Promise<{ userId: string; tenantId: string }> {
    const response = await request(server)
      .post('/relay-admin/users')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name });
    expect(response.status).toBe(200);
    expect(response.body.code).toBe('2000');
    return response.body.data;
  }

  beforeAll(async () => {
    // RA 库指向临时文件（client 构造期解析 env——须先于 Test 模块编译）
    tmpRoot = mkdtempSync(join(tmpdir(), 'relay-admin-users-'));
    const dbUrl = `file:${join(tmpRoot, 'relay-admin.db')}`;
    for (const key of [
      'RA_DATABASE_URL',
      'JWT_SECRET',
      'TIANSHU_LOG_DIR',
    ] as const) {
      savedEnv[key] = process.env[key];
    }
    process.env.RA_DATABASE_URL = dbUrl;
    process.env.JWT_SECRET = 'ra-users-test-secret';
    process.env.TIANSHU_LOG_DIR = join(tmpRoot, 'logs');

    // 建表：db push 直用 RA schema（datasource 已是 env("RA_DATABASE_URL")）
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
    raPrisma = app.get(RaPrismaService);

    accessToken = await login();
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

  it('POST /relay-admin/users → userId/tenantId 且落库；重复 name 允许、tenantId 唯一；audit user.create', async () => {
    const created = await createUserViaApi('alice');
    expect(created.userId).toEqual(expect.any(String));
    expect(created.tenantId).toEqual(expect.any(String));

    // 落库核验：plan 缺省 beta、status active、creator 记管理员
    const row = await raPrisma.raUser.findUniqueOrThrow({
      where: { id: created.userId },
    });
    expect(row.tenantId).toBe(created.tenantId);
    expect(row.name).toBe('alice');
    expect(row.plan).toBe('beta');
    expect(row.status).toBe('active');
    expect(row.creator).toBe('admin');

    // audit：user.create 一行，operator/target 落管理员/新户
    const createAudit = await raPrisma.raAuditLog.findFirst({
      where: { action: 'user.create', operator: 'admin', target: created.userId },
    });
    expect(createAudit).not.toBeNull();

    // 重复 name 允许（tenantId 唯一即可——brief 规定）：两户并存、标识互异
    const duplicate = await createUserViaApi('alice');
    expect(duplicate.userId).not.toBe(created.userId);
    expect(duplicate.tenantId).not.toBe(created.tenantId);
    const sameNameCount = await raPrisma.raUser.count({
      where: { name: 'alice' },
    });
    expect(sameNameCount).toBe(2);
  });

  it('GET /relay-admin/users → 列表含已建用户（userId/tenantId/name/plan/status）', async () => {
    const created = await createUserViaApi('carol');
    const response = await request(server)
      .get('/relay-admin/users')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(response.status).toBe(200);
    expect(response.body.code).toBe('2000');
    const list = response.body.data as Array<Record<string, unknown>>;
    const self = list.find((item) => item.userId === created.userId);
    expect(self).toEqual(
      expect.objectContaining({
        userId: created.userId,
        tenantId: created.tenantId,
        name: 'carol',
        plan: 'beta',
        status: 'active',
      }),
    );
  });

  it('disable → 用户 disabled + 该用户全部 AK 级联 disabled（不影响他人）+ audit 两行', async () => {
    const target = await createUserViaApi('bob');
    const bystander = await createUserViaApi('dave');

    // 种子 AK：目标用户 2 把（active + 已 disabled——级联必须覆盖全部），
    // 旁置用户 1 把（不受牵连）；secretHash/expireAt 为必填占位
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await raPrisma.raAccessKey.create({
      data: {
        secretHash: 'a'.repeat(64),
        role: 'server',
        userId: target.userId,
        status: 'active',
        expireAt: tomorrow,
      },
    });
    await raPrisma.raAccessKey.create({
      data: {
        secretHash: 'b'.repeat(64),
        role: 'client',
        userId: target.userId,
        status: 'disabled',
        expireAt: tomorrow,
      },
    });
    const bystanderAk = await raPrisma.raAccessKey.create({
      data: {
        secretHash: 'c'.repeat(64),
        role: 'server',
        userId: bystander.userId,
        status: 'active',
        expireAt: tomorrow,
      },
    });

    const response = await request(server)
      .post(`/relay-admin/users/${target.userId}/disable`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(response.status).toBe(200);
    expect(response.body.code).toBe('2000');

    // 用户态 + 目标 AK 全部级联（含先前已 disabled 的）
    const userRow = await raPrisma.raUser.findUniqueOrThrow({
      where: { id: target.userId },
    });
    expect(userRow.status).toBe('disabled');
    const targetAks = await raPrisma.raAccessKey.findMany({
      where: { userId: target.userId },
    });
    expect(targetAks).toHaveLength(2);
    expect(targetAks.every((ak) => ak.status === 'disabled')).toBe(true);

    // 旁置用户 AK 不受牵连
    const bystanderAkRow = await raPrisma.raAccessKey.findUniqueOrThrow({
      where: { id: bystanderAk.id },
    });
    expect(bystanderAkRow.status).toBe('active');

    // audit 两行：user.disable + ak 级联记录（operator 管理员、target 该用户）
    const audits = await raPrisma.raAuditLog.findMany({
      where: { target: target.userId },
      orderBy: { createdAt: 'asc' },
    });
    const actions = audits.map((row) => row.action);
    expect(actions).toContain('user.disable');
    expect(actions).toContain('ak.cascade-disable');
    const disableAudit = audits.find((row) => row.action === 'user.disable');
    expect(disableAudit?.operator).toBe('admin');
  });

  it('enable → 用户恢复 active，AK 不自动恢复（保持 disabled）+ audit user.enable', async () => {
    // 独立造户：disable 后 enable，AK 种子一把 active
    const target = await createUserViaApi('erin');
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await raPrisma.raAccessKey.create({
      data: {
        secretHash: 'd'.repeat(64),
        role: 'server',
        userId: target.userId,
        status: 'active',
        expireAt: tomorrow,
      },
    });
    await request(server)
      .post(`/relay-admin/users/${target.userId}/disable`)
      .set('Authorization', `Bearer ${accessToken}`);
    const akAfterDisable = await raPrisma.raAccessKey.findFirstOrThrow({
      where: { userId: target.userId },
    });
    expect(akAfterDisable.status).toBe('disabled');

    const response = await request(server)
      .post(`/relay-admin/users/${target.userId}/enable`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(response.status).toBe(200);
    expect(response.body.code).toBe('2000');

    const userRow = await raPrisma.raUser.findUniqueOrThrow({
      where: { id: target.userId },
    });
    expect(userRow.status).toBe('active');

    // AK 不自动恢复：操作员须逐个 enable（Task 11 per-AK 端点）
    const akRow = await raPrisma.raAccessKey.findFirstOrThrow({
      where: { userId: target.userId },
    });
    expect(akRow.status).toBe('disabled');

    const enableAudit = await raPrisma.raAuditLog.findFirst({
      where: { action: 'user.enable', target: target.userId },
    });
    expect(enableAudit).not.toBeNull();
  });

  it('DTO 校验：缺 name / 非法 plan → 校验失败信封（success:false）', async () => {
    const missingName = await request(server)
      .post('/relay-admin/users')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ plan: 'beta' });
    expect(missingName.body.success).toBe(false);
    expect(missingName.body.message).toContain('用户名不能为空');

    const badPlan = await request(server)
      .post('/relay-admin/users')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'frank', plan: 'pro' });
    expect(badPlan.body.success).toBe(false);
    expect(badPlan.body.message).toContain('套餐必须是 beta 之一');
  });

  it('disable/enable 不存在的用户 → BusinessException（code 4040）', async () => {
    const ghostId = '00000000-0000-4000-8000-000000000000';
    for (const action of ['disable', 'enable'] as const) {
      const response = await request(server)
        .post(`/relay-admin/users/${ghostId}/${action}`)
        .set('Authorization', `Bearer ${accessToken}`);
      // BusinessException 风格：HTTP 200 + {code:'4040',success:false,data:null}
      expect(response.status).toBe(200);
      expect(response.body.code).toBe('4040');
      expect(response.body.success).toBe(false);
      expect(response.body.data).toBeNull();
      expect(response.body.message).toBe('用户不存在');
    }
  });

  it('未鉴权访问 users 路由 → 401', async () => {
    const list = await request(server).get('/relay-admin/users');
    expect(list.status).toBe(401);

    const create = await request(server)
      .post('/relay-admin/users')
      .send({ name: 'noauth' });
    expect(create.status).toBe(401);

    const disable = await request(server).post(
      '/relay-admin/users/00000000-0000-4000-8000-000000000000/disable',
    );
    expect(disable.status).toBe(401);
  });
});

// relay-admin aks API e2e（Task 11）：签发（secret hash 落库、明文仅一次）/
// isAkUsable 四失败 reason + 成功 quota / disable→disabled / rotate 双向 /
// 过期 expired / 禁用用户拒签 / extend 只能延后——对 RaAppModule 整树起
// Test 模块，真实 RA Prisma 临时库 + 真实守卫/拦截器/过滤器链。
//
// 环境模式与 users.spec.ts 同款（fs mock 假 config.yml 必须 log.maxDays——
// file-stream-rotator 无兜底，缺它直接崩）；isAkUsable 是 Task 12 token
// 端点的服务面入口，测试经 app.get(AksService) 直调（Task 12 再经 HTTP 面
// 复验）；audit 断言用字面量 action 名（不用实现侧常量自比——跨段终验
// 清单教训）；期望 sha256 由测试侧 node:crypto 独立计算（不引实现函数）。
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  const fakeYaml = [
    'database:',
    "  url: 'file:./ra-aks-test.db'",
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
import { createHash } from 'node:crypto';
import request from 'supertest'; // esModuleInterop 开启后 export= 不可命名空间直调
import * as bcrypt from 'bcrypt';
import { RaAppModule } from 'src/relay-admin/app.module';
import { PrismaClient } from 'src/relay-admin/generated/prisma';
import { RaPrismaService } from 'src/relay-admin/prisma.service';
import { AksService } from 'src/relay-admin/aks/aks.service';

/** 测试管理员口令（seed 时写入 bcrypt 摘要；base64url 16+ 字符满足 DTO 校验） */
const TEST_ADMIN_PASSWORD = 'ra-aks-test-pass';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 测试侧独立计算 sha256 hex（不引实现函数——期望值不与实现自比） */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

describe('relay-admin aks API（Task 11）', () => {
  let app: INestApplication;
  let server: http.Server;
  let raPrisma: RaPrismaService;
  let aksService: AksService;
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
  async function createUserViaApi(
    name: string,
  ): Promise<{ userId: string; tenantId: string }> {
    const response = await request(server)
      .post('/relay-admin/users')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name });
    expect(response.status).toBe(200);
    expect(response.body.code).toBe('2000');
    return response.body.data;
  }

  /** 经 API 签发 AK（body 可指定 role/expireAt），返回响应体 data */
  async function issueAkViaApi(
    userId: string,
    body: Record<string, unknown> = {},
  ): Promise<{ akId: string; akSecret: string }> {
    const response = await request(server)
      .post('/relay-admin/aks')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ userId, role: 'server', ...body });
    expect(response.status).toBe(200);
    expect(response.body.code).toBe('2000');
    return response.body.data;
  }

  beforeAll(async () => {
    // RA 库指向临时文件（client 构造期解析 env——须先于 Test 模块编译）
    tmpRoot = mkdtempSync(join(tmpdir(), 'relay-admin-aks-'));
    const dbUrl = `file:${join(tmpRoot, 'relay-admin.db')}`;
    for (const key of [
      'RA_DATABASE_URL',
      'JWT_SECRET',
      'TIANSHU_LOG_DIR',
    ] as const) {
      savedEnv[key] = process.env[key];
    }
    process.env.RA_DATABASE_URL = dbUrl;
    process.env.JWT_SECRET = 'ra-aks-test-secret';
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
    aksService = app.get(AksService);

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

  it('POST /relay-admin/aks → akId/akSecret；库中 secretHash===sha256(明文)；expireAt 缺省 365d；audit ak.create', async () => {
    const user = await createUserViaApi('ak-owner');

    const issued = await issueAkViaApi(user.userId);
    // akId 为 UUID、akSecret 为 32B hex（64 字符）——spec §5.2
    expect(issued.akId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(issued.akSecret).toMatch(/^[0-9a-f]{64}$/);

    // 库中只存 sha256(明文)：期望值由测试侧独立计算
    const row = await raPrisma.raAccessKey.findUniqueOrThrow({
      where: { id: issued.akId },
    });
    expect(row.secretHash).toBe(sha256Hex(issued.akSecret));
    expect(row.secretHash).not.toBe(issued.akSecret);
    expect(row.role).toBe('server');
    expect(row.userId).toBe(user.userId);
    expect(row.status).toBe('active');
    expect(row.creator).toBe('admin');

    // expireAt 缺省 now+365d（容差 ±1d）
    expect(row.expireAt.getTime()).toBeGreaterThan(
      Date.now() + 364 * DAY_MS,
    );
    expect(row.expireAt.getTime()).toBeLessThan(Date.now() + 366 * DAY_MS);

    // audit：ak.create 一行（operator 管理员、target akId）
    const createAudit = await raPrisma.raAuditLog.findFirst({
      where: { action: 'ak.create', operator: 'admin', target: issued.akId },
    });
    expect(createAudit).not.toBeNull();
  });

  it('isAkUsable 成功路径 → ok:true、userId/role 回带、quota 为所属用户 plan（beta）配额', async () => {
    const user = await createUserViaApi('quota-owner');
    const issued = await issueAkViaApi(user.userId, { role: 'client' });

    const result = await aksService.isAkUsable(issued.akId, issued.akSecret);
    expect(result).toEqual({
      ok: true,
      userId: user.userId,
      role: 'client',
      quota: { maxServers: 5, maxClients: 10 },
    });
  });

  it('isAkUsable 四种失败 reason：not-found / bad-secret / disabled / expired', async () => {
    // not-found：幽灵 akId
    const ghost = await aksService.isAkUsable(
      '00000000-0000-4000-8000-000000000000',
      'whatever-secret',
    );
    expect(ghost).toEqual({ ok: false, reason: 'not-found' });

    // bad-secret：合法 AK + 错误 secret
    const user = await createUserViaApi('bad-secret-owner');
    const issued = await issueAkViaApi(user.userId);
    const wrongSecret = await aksService.isAkUsable(issued.akId, 'f'.repeat(64));
    expect(wrongSecret).toEqual({ ok: false, reason: 'bad-secret' });

    // disabled：禁用后正确 secret 也不可用
    const disabledUser = await createUserViaApi('disabled-ak-owner');
    const disabledAk = await issueAkViaApi(disabledUser.userId);
    await request(server)
      .post(`/relay-admin/aks/${disabledAk.akId}/disable`)
      .set('Authorization', `Bearer ${accessToken}`);
    const disabledResult = await aksService.isAkUsable(
      disabledAk.akId,
      disabledAk.akSecret,
    );
    expect(disabledResult).toEqual({ ok: false, reason: 'disabled' });

    // expired：过期后正确 secret 也不可用（种子行 expireAt 置过去）
    const expiredUser = await createUserViaApi('expired-ak-owner');
    const expiredSecret = 'e'.repeat(64);
    const expiredAk = await raPrisma.raAccessKey.create({
      data: {
        secretHash: sha256Hex(expiredSecret),
        role: 'server',
        userId: expiredUser.userId,
        status: 'active',
        expireAt: new Date(Date.now() - DAY_MS),
      },
    });
    const expiredResult = await aksService.isAkUsable(
      expiredAk.id,
      expiredSecret,
    );
    expect(expiredResult).toEqual({ ok: false, reason: 'expired' });
  });

  it('disable/enable 端点 → 状态翻转 + isAkUsable 随动 + audit ak.disable/ak.enable', async () => {
    const user = await createUserViaApi('flip-owner');
    const issued = await issueAkViaApi(user.userId);

    const disable = await request(server)
      .post(`/relay-admin/aks/${issued.akId}/disable`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(disable.status).toBe(200);
    expect(disable.body.code).toBe('2000');
    expect(
      await aksService.isAkUsable(issued.akId, issued.akSecret),
    ).toEqual({ ok: false, reason: 'disabled' });
    expect(
      await raPrisma.raAuditLog.findFirst({
        where: { action: 'ak.disable', operator: 'admin', target: issued.akId },
      }),
    ).not.toBeNull();

    const enable = await request(server)
      .post(`/relay-admin/aks/${issued.akId}/enable`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(enable.status).toBe(200);
    expect(enable.body.code).toBe('2000');
    expect(
      await aksService.isAkUsable(issued.akId, issued.akSecret),
    ).toEqual({ ok: true, userId: user.userId, role: 'server', quota: { maxServers: 5, maxClients: 10 } });
    expect(
      await raPrisma.raAuditLog.findFirst({
        where: { action: 'ak.enable', operator: 'admin', target: issued.akId },
      }),
    ).not.toBeNull();
  });

  it('rotate-secret → 新明文 ok、旧明文 bad-secret；库 hash 替换；audit ak.rotate-secret', async () => {
    const user = await createUserViaApi('rotate-owner');
    const first = await issueAkViaApi(user.userId);

    const rotate = await request(server)
      .post(`/relay-admin/aks/${first.akId}/rotate-secret`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(rotate.status).toBe(200);
    expect(rotate.body.code).toBe('2000');
    const second = rotate.body.data as { akId: string; akSecret: string };
    expect(second.akId).toBe(first.akId);
    expect(second.akSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(second.akSecret).not.toBe(first.akSecret);

    // 旧 secret 即刻失效、新 secret 可用
    expect(await aksService.isAkUsable(first.akId, first.akSecret)).toEqual({
      ok: false,
      reason: 'bad-secret',
    });
    expect(await aksService.isAkUsable(first.akId, second.akSecret)).toEqual({
      ok: true,
      userId: user.userId,
      role: 'server',
      quota: { maxServers: 5, maxClients: 10 },
    });

    // 库中 hash 已替换为新明文的摘要
    const row = await raPrisma.raAccessKey.findUniqueOrThrow({
      where: { id: first.akId },
    });
    expect(row.secretHash).toBe(sha256Hex(second.akSecret));

    expect(
      await raPrisma.raAuditLog.findFirst({
        where: {
          action: 'ak.rotate-secret',
          operator: 'admin',
          target: first.akId,
        },
      }),
    ).not.toBeNull();
  });

  it('extend → expireAt 延后成功 + audit ak.extend；提前（早于现有 expireAt）→ BusinessException 拒绝', async () => {
    const user = await createUserViaApi('extend-owner');
    const issued = await issueAkViaApi(user.userId, {
      expireAt: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    });
    const initial = await raPrisma.raAccessKey.findUniqueOrThrow({
      where: { id: issued.akId },
    });
    expect(initial.expireAt.getTime()).toBeGreaterThan(
      Date.now() + 29 * DAY_MS,
    );

    // 延后：+30d → +60d
    const laterIso = new Date(Date.now() + 60 * DAY_MS).toISOString();
    const extend = await request(server)
      .post(`/relay-admin/aks/${issued.akId}/extend`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ expireAt: laterIso });
    expect(extend.status).toBe(200);
    expect(extend.body.code).toBe('2000');
    const extended = await raPrisma.raAccessKey.findUniqueOrThrow({
      where: { id: issued.akId },
    });
    expect(extended.expireAt.getTime()).toBeGreaterThan(
      Date.now() + 59 * DAY_MS,
    );
    expect(
      await raPrisma.raAuditLog.findFirst({
        where: { action: 'ak.extend', operator: 'admin', target: issued.akId },
      }),
    ).not.toBeNull();

    // 提前：现 +60d → 尝试 +10d，拒绝且库值不变
    const earlierIso = new Date(Date.now() + 10 * DAY_MS).toISOString();
    const reject = await request(server)
      .post(`/relay-admin/aks/${issued.akId}/extend`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ expireAt: earlierIso });
    expect(reject.status).toBe(200); // BusinessException 风格：HTTP 200 + success:false
    expect(reject.body.success).toBe(false);
    expect(reject.body.data).toBeNull();
    expect(reject.body.message).toContain('只能延后');
    const afterReject = await raPrisma.raAccessKey.findUniqueOrThrow({
      where: { id: issued.akId },
    });
    expect(afterReject.expireAt.getTime()).toBe(extended.expireAt.getTime());
  });

  it('对不存在/已禁用用户签发 AK → BusinessException 拒绝', async () => {
    const ghost = await request(server)
      .post('/relay-admin/aks')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ userId: '00000000-0000-4000-8000-000000000000', role: 'server' });
    expect(ghost.status).toBe(200);
    expect(ghost.body.code).toBe('4040');
    expect(ghost.body.success).toBe(false);
    expect(ghost.body.data).toBeNull();
    expect(ghost.body.message).toBe('用户不存在');

    const user = await createUserViaApi('frozen-owner');
    await request(server)
      .post(`/relay-admin/users/${user.userId}/disable`)
      .set('Authorization', `Bearer ${accessToken}`);
    const frozen = await request(server)
      .post('/relay-admin/aks')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ userId: user.userId, role: 'client' });
    expect(frozen.status).toBe(200);
    expect(frozen.body.success).toBe(false);
    expect(frozen.body.data).toBeNull();
    expect(frozen.body.message).toContain('禁用');

    // 库中无 AK 落行（拒绝路径零写入）
    expect(
      await raPrisma.raAccessKey.count({ where: { userId: user.userId } }),
    ).toBe(0);
  });

  it('GET /relay-admin/aks?userId= → 该用户 AK 列表（akId/role/status/expireAt、无 secret 泄露面）；不混入他人 AK', async () => {
    const owner = await createUserViaApi('list-owner');
    const other = await createUserViaApi('list-bystander');
    const serverAk = await issueAkViaApi(owner.userId, { role: 'server' });
    await issueAkViaApi(owner.userId, { role: 'client' });
    await issueAkViaApi(other.userId, { role: 'server' });

    const response = await request(server)
      .get(`/relay-admin/aks?userId=${owner.userId}`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(response.status).toBe(200);
    expect(response.body.code).toBe('2000');
    const list = response.body.data as Array<Record<string, unknown>>;
    expect(list).toHaveLength(2);
    const ids = list.map((item) => item.akId);
    expect(ids).toContain(serverAk.akId);
    expect(list.every((item) => item.userId === owner.userId)).toBe(true);

    const item = list.find((row) => row.akId === serverAk.akId);
    expect(item).toEqual(
      expect.objectContaining({
        akId: serverAk.akId,
        role: 'server',
        userId: owner.userId,
        status: 'active',
      }),
    );
    // 列表不透出 secretHash/明文（字段白名单式 DTO）
    expect(item).not.toHaveProperty('secretHash');
    expect(item).not.toHaveProperty('akSecret');

    // userId 查询参数缺省 → 校验失败信封
    const missing = await request(server)
      .get('/relay-admin/aks')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(missing.body.success).toBe(false);
  });

  it('DTO 校验：非法 role / 非法 expireAt → 校验失败信封（success:false）', async () => {
    const user = await createUserViaApi('dto-owner');

    const badRole = await request(server)
      .post('/relay-admin/aks')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ userId: user.userId, role: 'admin' });
    expect(badRole.body.success).toBe(false);
    expect(badRole.body.message).toContain('角色必须是 server/client 之一');

    const badExpire = await request(server)
      .post('/relay-admin/aks')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        userId: user.userId,
        role: 'server',
        expireAt: 'not-a-date',
      });
    expect(badExpire.body.success).toBe(false);
    expect(badExpire.body.message).toContain('合法日期');
  });

  it('disable/enable/rotate/extend 幽灵 akId → BusinessException（code 4040）', async () => {
    const ghostId = '00000000-0000-4000-8000-000000000000';
    for (const action of [
      'disable',
      'enable',
      'rotate-secret',
      'extend',
    ] as const) {
      const response = await request(server)
        .post(`/relay-admin/aks/${ghostId}/${action}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send(action === 'extend' ? { expireAt: new Date().toISOString() } : {});
      expect(response.status).toBe(200);
      expect(response.body.code).toBe('4040');
      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('AK 不存在');
    }
  });

  it('未鉴权访问 aks 路由 → 401', async () => {
    const list = await request(server).get('/relay-admin/aks?userId=any');
    expect(list.status).toBe(401);

    const create = await request(server)
      .post('/relay-admin/aks')
      .send({ userId: 'any', role: 'server' });
    expect(create.status).toBe(401);

    const disable = await request(server).post(
      '/relay-admin/aks/00000000-0000-4000-8000-000000000000/disable',
    );
    expect(disable.status).toBe(401);
  });
});

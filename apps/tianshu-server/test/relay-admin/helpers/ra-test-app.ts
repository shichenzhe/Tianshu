/**
 * relay-admin e2e 套件共享测试装配（Task 12 收编：此前 users/bootstrap/aks
 * 三套件内联同款三份——T11 复审 concern #4 还账）。提供：临时 RA 库 +
 * 管理员 seed + RaAppModule 整树起 Test 模块（真实守卫/拦截器/过滤器链）
 * + env 存取恢复。使用方须先 `import './helpers/ra-fs-mock'`（见该文件
 * 头注释的导入次序约束），再导入本文件。
 */
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
import { setupRaSwagger } from 'src/relay-admin/swagger';
import { PrismaClient } from 'src/relay-admin/generated/prisma';
import { RaPrismaService } from 'src/relay-admin/prisma.service';

// @fastify/static 在 jest 沙箱内不可加载：@nestjs/swagger v11 挂载 UI 资产
// 经 FastifyAdapter.useStaticAssets 惰性 require 该包，其嵌套依赖
// content-disposition 为 ESM-only，jest29 的 CJS 沙箱首个 require 即抛
// Unexpected token 'export'（Nest PackageLoader 误报「包缺失」后炸
// worker）。生产不受影响——node>=20.19 靠 require(esm) 正常加载（主应用
// Swagger 同链路）。withSwagger 测试只断言 UI HTML / -json 端点（内存
// 生成，不经静态资产），登记 no-op 插件 mock 即可；该包仅 useStaticAssets
// 惰性 require（无 import 期加载方），本语句虽在 import 提升后执行，
// 仍先于一切真实 require 生效
jest.mock('@fastify/static', () => async () => {});

/** 测试管理员口令（seed 时写入 bcrypt 摘要；base64url 16+ 字符满足 DTO 校验） */
export const RA_TEST_ADMIN_USERNAME = 'admin';
export const RA_TEST_ADMIN_PASSWORD = 'ra-e2e-admin-pass';

/** 装配期统一管理的 env 键（extraEnv 额外键亦入存取恢复登记） */
const MANAGED_ENV_KEYS = [
  'RA_DATABASE_URL',
  'JWT_SECRET',
  'TIANSHU_LOG_DIR',
] as const;

/** 装配产物：server 供 supertest、raPrisma 直查库、adminToken 管理面调用；
 *  restoreEnv 还原装配期改写的 env（destroyRaTestApp 内部调用） */
export interface RaTestApp {
  app: INestApplication;
  server: http.Server;
  raPrisma: RaPrismaService;
  adminToken: string;
  tmpRoot: string;
  restoreEnv: () => void;
}

/**
 * 起一套 relay-admin 应用：临时目录 + RA 库 db push + 已知口令管理员
 * seed + RaAppModule 整树 + 与 src/relay-admin/main.ts 同款全局管道
 * （transform + 隐式类型转换）。extraEnv 在模块编译前生效（client 构造
 * 期解析 env 的时序与生产一致），销毁时统一还原。withSwagger 时按生产
 * 入口同款挂载 Swagger 操作台（app.init 前注册路由——fastify ready 后
 * 不再受理新路由）。
 */
export async function createRaTestApp(opts: {
  tmpPrefix: string;
  extraEnv?: (tmpRoot: string) => Record<string, string | undefined>;
  withSwagger?: boolean;
}): Promise<RaTestApp> {
  // RA 库指向临时文件（client 构造期解析 env——须先于 Test 模块编译）
  const tmpRoot = mkdtempSync(join(tmpdir(), opts.tmpPrefix));
  const dbUrl = `file:${join(tmpRoot, 'relay-admin.db')}`;
  const extraEnv = opts.extraEnv?.(tmpRoot) ?? {};
  const savedEnv: Record<string, string | undefined> = {};
  for (const key of [...MANAGED_ENV_KEYS, ...Object.keys(extraEnv)]) {
    savedEnv[key] = process.env[key];
  }
  process.env.RA_DATABASE_URL = dbUrl;
  process.env.JWT_SECRET = 'ra-e2e-jwt-secret';
  process.env.TIANSHU_LOG_DIR = join(tmpRoot, 'logs');
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    // 建表：db push 直用 RA schema（datasource 已是 env("RA_DATABASE_URL")）
    const projectRoot = join(__dirname, '..', '..', '..');
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
        username: RA_TEST_ADMIN_USERNAME,
        passwordHash: await bcrypt.hash(RA_TEST_ADMIN_PASSWORD, 10),
      },
    });
    await seedClient.$disconnect();

    const moduleRef = await Test.createTestingModule({
      imports: [RaAppModule],
    }).compile();
    const app = moduleRef.createNestApplication(new FastifyAdapter());
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    if (opts.withSwagger) setupRaSwagger(app);
    await app.init();
    await (app.getHttpAdapter().getInstance() as FastifyInstance).ready();

    const server = app.getHttpServer() as http.Server;
    const adminToken = await loginAdmin(server);
    return {
      app,
      server,
      raPrisma: app.get(RaPrismaService),
      adminToken,
      tmpRoot,
      restoreEnv: () => restoreEnv(savedEnv),
    };
  } catch (error) {
    // 装配半途失败也要还原 env/清目录（否则进程级泄漏影响后续套件）
    restoreEnv(savedEnv);
    rmSync(tmpRoot, { recursive: true, force: true });
    throw error;
  }
}

/** 销毁：关应用（RaPrismaService $disconnect）→ 删临时目录 → 还原 env */
export async function destroyRaTestApp(ra: RaTestApp): Promise<void> {
  await ra.app.close();
  rmSync(ra.tmpRoot, { recursive: true, force: true });
  ra.restoreEnv();
}

/** 管理员登录换 accessToken（装配期一次，套件内复用） */
export async function loginAdmin(server: http.Server): Promise<string> {
  const login = await request(server)
    .post('/relay-admin/auth/login')
    .send({ username: RA_TEST_ADMIN_USERNAME, password: RA_TEST_ADMIN_PASSWORD });
  expect(login.status).toBe(200);
  expect(login.body.code).toBe('2000');
  return login.body.data.accessToken as string;
}

/** 经 API 建户（返回 {userId, tenantId}） */
export async function createUserViaApi(
  server: http.Server,
  adminToken: string,
  name: string,
): Promise<{ userId: string; tenantId: string }> {
  const response = await request(server)
    .post('/relay-admin/users')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name });
  expect(response.status).toBe(200);
  expect(response.body.code).toBe('2000');
  return response.body.data;
}

/** 经 API 签发 AK（body 可指定 role/expireAt），返回响应体 data */
export async function issueAkViaApi(
  server: http.Server,
  adminToken: string,
  userId: string,
  body: Record<string, unknown> = {},
): Promise<{ akId: string; akSecret: string }> {
  const response = await request(server)
    .post('/relay-admin/aks')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ userId, role: 'server', ...body });
  expect(response.status).toBe(200);
  expect(response.body.code).toBe('2000');
  return response.body.data;
}

/** 还原 env：登记时 undefined 的键删除（不留空串伪值） */
function restoreEnv(savedEnv: Record<string, string | undefined>): void {
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
}

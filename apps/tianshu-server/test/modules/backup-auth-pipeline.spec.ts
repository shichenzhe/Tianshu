// 终审 C1 回归钉：BackupController 缺 @Public 时出厂 auth.global=true 的
// 全局 JwtAuthGuard 把整个 backup 面拦死（静态 token/clientToken 全 401
// 「登录已过期」）。本组装配真实 AuthModule（forRoot global）+ BackupModule
// + StaticTokenGuard 的 AppModule 同构链（createTestApp），PrismaService 以
// option stub 覆写（registry 两账本读写走 option 表；备份根指临时目录）。
// 链路实况：JwtAuthGuard（类级 @Public 豁免）→ StaticTokenGuard（backup
// 前缀豁免）→ BackupGuard（claim 路径豁免/双身份识别 fail-closed）。
// 探针控制器（无 @Public）坐实 JWT 层在本管线确已武装——三景的 200 才
// 非空洞通过（缺 @Public 时将同形 401）。
import { Controller, HttpStatus, Module, Post, HttpCode } from '@nestjs/common';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupModule } from 'src/modules/backup/backup.module';
import { PrismaModule } from 'src/commons/database/prisma.module';
import { createTestApp, type WrappedBody } from '../support/test-app';

/** JWT 层武装探针：无 @Public 的对照组路由——持合法静态 token 仍被
 *  JwtAuthGuard 401（证全局 JWT 守卫在场，backup 三景非空洞通过） */
@Controller('jwt-probe')
class JwtProbeController {
  @Post('ping')
  @HttpCode(HttpStatus.OK)
  ping(): { pong: boolean } {
    return { pong: true };
  }
}
@Module({ controllers: [JwtProbeController] })
class JwtProbeModule {}

/** option 表内存替身（registry 两账本 + service maxKeep 全走 findUnique/
 *  upsert；key=option.name，值=JSON 字符串） */
interface OptionRow {
  type: string;
  name: string;
  value: string;
}
const rows = new Map<string, string>();
const prismaStub = {
  option: {
    findUnique: jest.fn(({ where }: { where: { type_name: { name: string } } }) =>
      Promise.resolve(
        rows.has(where.type_name.name)
          ? ({ type: 'app', name: where.type_name.name, value: rows.get(where.type_name.name)! } as OptionRow)
          : null,
      ),
    ),
    upsert: jest.fn(
      ({
        where,
        update,
        create,
      }: {
        where: { type_name: { name: string } };
        update: { value: string };
        create: { value: string };
      }) => {
        rows.set(where.type_name.name, update.value ?? create.value);
        return Promise.resolve({});
      },
    ),
  },
  $disconnect: jest.fn(),
};

const sha256hex = (v: string) => createHash('sha256').update(v).digest('hex');

describe('backup 鉴权管线（终审 C1：@Public 三层贯通）', () => {
  let app: INestApplication;
  let server: http.Server;
  const GATE_TOKEN = 'gate-tok';
  const ORIG_TOKEN = process.env.TIANSHU_TOKEN;
  const ORIG_BACKUP_TOKEN = process.env.TIANSHU_BACKUP_TOKEN;
  const ORIG_BACKUP_DIR = process.env.TIANSHU_BACKUP_DIR;
  let backupDir: string;

  beforeAll(async () => {
    // 备份根指临时目录（BackupService.list 读盘面隔离）
    backupDir = mkdtempSync(join(tmpdir(), 'backup-auth-pipeline-'));
    process.env.TIANSHU_BACKUP_DIR = backupDir;
    delete process.env.TIANSHU_BACKUP_TOKEN;
    // 未用邀请码一枚（claim 景核销用）
    rows.set(
      'backupInvites',
      JSON.stringify([
        { code: 'TS-AB2XYZ9H', note: null, createdAt: '2026-10-28T00:00:00.000Z' },
      ]),
    );
    const built = await createTestApp(prismaStub as never, [
      // PrismaModule 显式引入（生产由 AppModule 全局供给；BackupModule 自身
      // 不 import——不引入则 override 的 PrismaService token 无处落位）
      PrismaModule,
      BackupModule,
      JwtProbeModule,
    ]);
    app = built.app;
    server = built.server;
    // 大门 token 部署态（出厂默认）：createTestApp 构建期会删 TIANSHU_TOKEN，
    // 请求期守卫现读 env——构建后再置
    process.env.TIANSHU_TOKEN = GATE_TOKEN;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    if (ORIG_TOKEN === undefined) delete process.env.TIANSHU_TOKEN;
    else process.env.TIANSHU_TOKEN = ORIG_TOKEN;
    if (ORIG_BACKUP_TOKEN === undefined) delete process.env.TIANSHU_BACKUP_TOKEN;
    else process.env.TIANSHU_BACKUP_TOKEN = ORIG_BACKUP_TOKEN;
    if (ORIG_BACKUP_DIR === undefined) delete process.env.TIANSHU_BACKUP_DIR;
    else process.env.TIANSHU_BACKUP_DIR = ORIG_BACKUP_DIR;
    rmSync(backupDir, { recursive: true, force: true });
  });

  it('对照探针：无 @Public 路由持合法静态 token 仍被 JWT 层 401（守卫确已武装）', async () => {
    const res = await request(server)
      .post('/jwt-probe/ping')
      .set('Authorization', `Bearer ${GATE_TOKEN}`)
      .send({});
    expect(res.status).toBe(401);
    // 「登录已过期」= JwtAuthGuard.handleRequest 文案（非 BackupGuard 的
    // 「无效的备份 token」）——钉住拒者为 JWT 层
    expect((res.body as { message?: string }).message).toContain('登录已过期');
  });

  it('静态 bearer（TIANSHU_TOKEN）可达 backup/list——不被 JWT 层拦，admin 视角', async () => {
    const res = await request(server)
      .post('/backup/list')
      .set('Authorization', `Bearer ${GATE_TOKEN}`)
      .send({});
    expect(res.status).toBe(200);
    const body = res.body as WrappedBody<{
      backups: unknown[];
      viewer: { kind: string };
    }>;
    expect(body.code).toBe('2000');
    expect(body.data.viewer).toEqual({ kind: 'admin' });
  });

  it('claim 无凭据可达（JWT @Public + 静态 token backup 前缀两层豁免）', async () => {
    const res = await request(server)
      .post('/backup/claim')
      .send({ inviteCode: 'TS-AB2XYZ9H', deviceName: 'reimac' });
    expect(res.status).toBe(200);
    const body = res.body as WrappedBody<{
      clientId: string;
      clientToken: string;
    }>;
    expect(body.code).toBe('2000');
    expect(body.data.clientId).toBe('reimac');
    expect(body.data.clientToken).toMatch(/^[0-9a-f]{32}$/);
    // 核销留痕：两账本均经 upsert 落盘（clients 新增 + invites 置 usedAt）
    expect(prismaStub.option.upsert).toHaveBeenCalled();
    const invites = JSON.parse(rows.get('backupInvites')!);
    expect(invites[0].usedBy).toBe('reimac');
  });

  it('clientToken 可达 backup/list（registry 命中——client 视角 owner 隔离链）', async () => {
    const clientToken = 'client-tok-123';
    rows.set(
      'backupClients',
      JSON.stringify([
        {
          clientId: 'imac-1',
          tokenHash: sha256hex(clientToken),
          createdAt: '2026-10-28T00:00:00.000Z',
        },
      ]),
    );
    const res = await request(server)
      .post('/backup/list')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({});
    expect(res.status).toBe(200);
    const body = res.body as WrappedBody<{
      backups: unknown[];
      viewer: { kind: string; clientId?: string };
    }>;
    expect(body.code).toBe('2000');
    expect(body.data.viewer).toEqual({ kind: 'client', clientId: 'imac-1' });
    expect(body.data.backups).toEqual([]);
  });
});

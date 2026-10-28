import { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { FastifyInstance } from 'fastify';
import * as http from 'node:http';
import request from 'supertest'; // esModuleInterop 开启后 export= 不可命名空间直调
import { AuthModule } from 'src/commons/auth/auth.module';
import { StaticTokenGuard } from 'src/commons/auth/guard/token.guard';
import { ResponseInterceptor } from 'src/commons/web/interceptor/response.interceptor';
import { InfoModule } from 'src/modules/info/info.module';
import { instanceId } from 'src/modules/info/info.controller';

/** /info 经 starter 统一包装后的响应体形状 */
interface InfoResponseBody {
  success: boolean;
  data: {
    name: string;
    version: string;
    instanceId: string;
    capabilities: string[];
  };
}

/**
 * /info 端点 e2e：capability 协商入口。
 * 组装与 AppModule 同构的最小链路——真实 JWT 守卫链（AuthModule.forRoot）
 * + 静态 token 守卫 + 统一响应包装拦截器，避免拉起 Prisma/日志等重型依赖。
 */
describe('InfoController (e2e)', () => {
  let app: INestApplication;
  let server: http.Server;
  const TOKEN_KEY = 'TIANSHU_TOKEN';
  let originalToken: string | undefined;

  /** 发起一次 GET /info，返回统一包装后的 data 段 */
  const getInfo = async () => {
    const response = await request(server).get('/info').expect(200);
    return (response.body as InfoResponseBody).data;
  };

  beforeAll(async () => {
    // dev 模式：无 TIANSHU_TOKEN 时静态 token 守卫放行
    originalToken = process.env[TOKEN_KEY];
    delete process.env[TOKEN_KEY];

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [
            () => ({
              // 与 config.yml 同构的最小 auth 段（JwtStrategy 构造需 jwt.secret）
              auth: {
                global: true,
                defaultStrategy: 'jwt',
                jwt: { secret: 'test-jwt-secret', expiresIn: '30m' },
              },
            }),
          ],
        }),
        AuthModule.forRoot({ global: true }),
        InfoModule,
      ],
      providers: [
        { provide: APP_GUARD, useClass: StaticTokenGuard },
        { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
      ],
    }).compile();

    app = moduleRef.createNestApplication(new FastifyAdapter());
    await app.init();
    const fastifyInstance = app
      .getHttpAdapter()
      .getInstance() as FastifyInstance;
    await fastifyInstance.ready();
    server = app.getHttpServer() as http.Server;
  });

  afterAll(async () => {
    await app.close();
    if (originalToken === undefined) {
      delete process.env[TOKEN_KEY];
    } else {
      process.env[TOKEN_KEY] = originalToken;
    }
  });

  describe('GET /info', () => {
    it('无任何凭证可访问（@Public 豁免 JWT 守卫），返回统一包装的 capability 信息', async () => {
      const response = await request(server).get('/info').expect(200);
      const body = response.body as InfoResponseBody;

      expect(body.success).toBe(true);
      expect(body.data.name).toBe('tianshu-server');
      expect(typeof body.data.version).toBe('string');
      expect(body.data.version).not.toBe('');
      expect(body.data.capabilities).toContain('chat');
      // GA-T6：无头端能力域增 graph（编排/自动化归并，spec §4.2）；FA-T1
      // 增 files（远程文件三端点，spec 2026-10-20 §3.1）；library 批增
      // library（资料库十七端点管理面，spec 2026-10-26）；MO 批增
      // monitor（用量统计只读聚合面，spec 2026-10-27）
      expect(body.data.capabilities).toEqual([
        'chat',
        'provider',
        'graph',
        'files',
        'library',
        'monitor',
      ]);
      // UD-T1：ui-drive 为桌面被控端专属能力（DESKTOP_CAPABILITIES），无头
      // 端不报——防协议包常量扩充后 capability 泄漏回归（ui/* 三端点本端
      // 不实现，控制端据 capability 门控不可达，直连调用返回 404）
      expect(body.data.capabilities).not.toContain('ui-drive');
    });

    it('instanceId 为进程级单例：与导出常量一致、两次请求相同、UUID 格式', async () => {
      const first = await getInfo();
      const second = await getInfo();

      expect(first.instanceId).toBe(instanceId);
      expect(second.instanceId).toBe(first.instanceId);
      expect(first.instanceId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it('TIANSHU_TOKEN 已设置时静态 token 守卫仍拦 /info（@Public 不豁免）', async () => {
      process.env[TOKEN_KEY] = 'secret-token';
      try {
        await request(server).get('/info').expect(401);
        await request(server)
          .get('/info')
          .set('Authorization', 'Bearer secret-token')
          .expect(200);
      } finally {
        delete process.env[TOKEN_KEY];
      }
    });
  });
});

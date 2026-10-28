import { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import compression from 'compression';
import { AuthModule } from 'src/commons/auth/auth.module';
import { EventBusModule } from 'src/commons/event-bus/event-bus.module';
import { EventModule } from 'src/modules/event/event.module';

/**
 * GET /event SSE 流（含压缩豁免回归）：
 * 真实 listen 端口 + 与 main.ts 同款 compression 中间件装配（supertest/
 * inject 收敛整响应，SSE 无限流不适用——裸 http.get 读首块）。
 *
 * 回归锚（T19 E2E 直连链路实测发现）：压缩中间件对 hijack 直写的 SSE 流
 * 套 gzip 且小帧缓冲不刷出（content-encoding: gzip、15s 无字节）。控制器
 * 以 Cache-Control: no-cache, no-transform 豁免——compression 的 on-headers
 * 钩子经 getHeader 查该头，故必须 setHeader 预置而非 writeHead 内联。
 */
describe('EventController /event (e2e)', () => {
  let app: INestApplication;
  let port: number;
  let server: http.Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [
            () => ({
              auth: {
                global: true,
                defaultStrategy: 'jwt',
                jwt: { secret: 'test-jwt-secret', expiresIn: '30m' },
              },
            }),
          ],
        }),
        AuthModule.forRoot({ global: true }),
        EventBusModule,
        EventModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication(new FastifyAdapter());
    // 与 main.ts 默认装配同款压缩（enabled/threshold 取 config.yml 缺省值）
    app.use(compression({ threshold: 2048, level: 1, memLevel: 8 }));
    await app.init();
    await app.listen(0, '127.0.0.1');
    server = app.getHttpServer() as http.Server;
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
  });

  /** 裸 http GET /event 读首个数据块（超时 reject——被压缩缓冲时即此形态） */
  function readFirstChunk(
    headers: Record<string, string>,
    timeoutMs = 3000,
  ): Promise<{ headers: http.IncomingHttpHeaders; chunk: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error(`首块 ${timeoutMs}ms 未达（疑似被压缩缓冲）`));
      }, timeoutMs);
      const req = http.get(
        { host: '127.0.0.1', port, path: '/event', headers },
        (res) => {
          res.setEncoding('utf8');
          res.once('data', (chunk: string) => {
            clearTimeout(timer);
            req.destroy();
            resolve({ headers: res.headers, chunk });
          });
        },
      );
      req.on('error', () => {
        /* destroy 自身的预期噪声 */
      });
    });
  }

  it('压缩中间件在链：SSE 响应携带 no-transform 豁免压缩，首帧直达不被 gzip 缓冲', async () => {
    const { headers, chunk } = await readFirstChunk({
      'accept-encoding': 'gzip, deflate',
    });
    expect(headers['content-encoding']).toBeUndefined();
    expect(String(headers['cache-control'])).toContain('no-transform');
    expect(chunk).toContain('event: server.connected');
  });

  it('不带 accept-encoding：SSE 首帧 server.connected 正常送达', async () => {
    const { headers, chunk } = await readFirstChunk({});
    expect(headers['content-encoding']).toBeUndefined();
    expect(chunk).toContain('event: server.connected');
  });
});

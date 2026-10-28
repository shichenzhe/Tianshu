import { INestApplication, Type, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { FastifyInstance } from 'fastify';
import * as http from 'node:http';
import { AuthModule } from 'src/commons/auth/auth.module';
import { StaticTokenGuard } from 'src/commons/auth/guard/token.guard';
import { HttpExceptionFilter } from 'src/commons/web/filter/http-exception.filter';
import { ResponseInterceptor } from 'src/commons/web/interceptor/response.interceptor';
import { JsonSerializerInterceptor } from 'src/commons/web/interceptor/json-serializer.interceptor';
import { PrismaService } from 'src/commons/database/prisma.service';

/**
 * 组装与 AppModule 同构的最小 e2e 链路（info.spec 同款）：
 * 真实 JWT 守卫链 + 静态 token 守卫 + 统一包装/JSON 序列化拦截器 + 异常过滤器
 * + main.ts 同款 ValidationPipe；PrismaService 用临时库实例覆盖。
 * 业务模块经 modules 传入；configure 可在编译前追加 provider 覆盖
 * （如 CHAT_RUNNER_DEPS 假模型注入）。
 */
export async function createTestApp(
  prisma: PrismaService,
  modules: Type<any>[],
  configure?: (builder: TestingModuleBuilder) => TestingModuleBuilder,
): Promise<{ app: INestApplication; server: http.Server }> {
  // dev 模式：无 TIANSHU_TOKEN 时静态 token 守卫放行（本组用例不测 token 语义）
  delete process.env.TIANSHU_TOKEN;

  let builder = Test.createTestingModule({
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
      ...modules,
    ],
    providers: [
      { provide: APP_GUARD, useClass: StaticTokenGuard },
      { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
      { provide: APP_INTERCEPTOR, useClass: JsonSerializerInterceptor },
      { provide: APP_FILTER, useClass: HttpExceptionFilter },
    ],
  });
  if (configure) {
    builder = configure(builder);
  }
  const moduleRef = await builder
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .compile();

  const app = moduleRef.createNestApplication(new FastifyAdapter());
  // 与 main.ts 同款全局管道：transform + 隐式类型转换（DTO 数字字段依赖）
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  await app.init();
  await (app.getHttpAdapter().getInstance() as FastifyInstance).ready();
  return { app, server: app.getHttpServer() as http.Server };
}

/** starter 统一包装后的响应体形状 */
export interface WrappedBody<T> {
  code: string;
  success: boolean;
  data: T;
  message: string;
}

/** starter QueryResult 分页体形状 */
export interface QueryResultBody<T> {
  page: number;
  pageSize: number;
  records: T[];
  total: number;
}

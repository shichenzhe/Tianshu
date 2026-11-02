import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ClsModule } from 'nestjs-cls';
import { ConfigModule } from '@nestjs/config';
import { v4 as uuidv4 } from 'uuid';
import { FastifyRequest } from 'fastify';
import configuration from '../commons/config/configuration';
import { LogModule } from '../commons/log/log.module';
import { JwtAuthGuard } from '../commons/auth/guard/jwt-auth.guard';
import { ResponseInterceptor } from '../commons/web/interceptor/response.interceptor';
import { JsonSerializerInterceptor } from '../commons/web/interceptor/json-serializer.interceptor';
import { RequestLoggerInterceptor } from '../commons/web/interceptor/request-logger.interceptor';
import { HttpExceptionFilter } from '../commons/web/filter/http-exception.filter';
import { HealthModule } from '../commons/web/management/health/health.module';
import { RaPrismaModule } from './prisma.module';
import { RaAuthModule } from './auth/ra-auth.module';
import { RaAuditModule } from './audit/audit.module';
import { RaUsersModule } from './users/users.module';
import { AksModule } from './aks/aks.module';

/**
 * relay-admin 运营控制平面独立 AppModule（Task 9）
 *
 * 与主应用 src/app.module.ts 完全隔离：仅被 src/relay-admin/main.ts
 * 引用，主入口模块树不含任何 relay-admin 节点——主应用 dist/src/main.js
 * 运行态不注册本树控制器（Nest 只装配入口 import 的模块）。全局管道
 * 与主应用同构：全局 JwtAuthGuard（余路由默认鉴权）+ 请求日志 +
 * {code,message,data} 统一包装 + JSON 序列化 + 异常过滤器；
 * /actuator/health 复用 commons HealthModule。
 * 不引入主应用的 StaticTokenGuard（TIANSHU_TOKEN 是业务面 spawn 语义）
 * 与 OperationLog/Metrics 拦截器（业务库表依赖）。
 * Task 10 起：RaAuditModule（审计 @Global）+ RaUsersModule（用户管理
 * API），Task 9 的临时探针控制器已随真实路由上线删除。Task 11 起：
 * AksModule（AK 生命周期——签发/禁用/轮换/续期 + isAkUsable 服务面）。
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration], // 与主应用同源：config.yml + JWT_SECRET env 约定
    }) as any,
    ClsModule.forRoot({
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: (req: FastifyRequest) => {
          return (req.headers['trace_id'] as string) || uuidv4();
        },
      },
    }),
    LogModule,
    RaPrismaModule,
    RaAuditModule,
    RaAuthModule,
    RaUsersModule,
    AksModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_INTERCEPTOR, useClass: RequestLoggerInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_INTERCEPTOR, useClass: JsonSerializerInterceptor },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class RaAppModule {}

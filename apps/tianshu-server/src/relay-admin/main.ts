import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import * as qs from 'qs';
import { ConfigService } from '@nestjs/config';
import { RaAppModule } from './app.module';
import { AppConfig } from '../commons/config/app-config.entity';
import { jwtSecretSource } from '../commons/config/env-secret';
import {
  isWildcardAddress,
  resolveListenHostname,
} from '../commons/web/listen-host';
import { shutdownAndExit } from '../commons/web/shutdown';
import { setupRaSwagger } from './swagger';

/** 缺省监听端口（spec 2026-11-03：relay 面板 8410 / 控制面 8412） */
export const RA_DEFAULT_PORT = 8412;

/**
 * relay-admin 独立入口（Task 9）：运营控制平面——与主应用 dist/src/main.js
 * 平行的第二 HTTP 入口（start:relay 同款多入口形态）。全局管道与主应用
 * main.ts 同构：ValidationPipe（transform + 隐式转换）+ 统一包装拦截器 +
 * 异常过滤器（在 RaAppModule 经 APP_* 装配）；鉴权为全局 JWT 守卫。
 * Swagger 操作台已挂载（spec §6：/api-docs 即 beta 操作台，终审 fix——
 * 独立标题不读主应用 swagger 配置段，见 swagger.ts）；主应用特有的
 * 握手/compression/relay 客户端不进入本入口。
 */
async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    RaAppModule,
    new FastifyAdapter({
      querystringParser: (str: string) => qs.parse(str),
    }),
  );

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.enableCors();
  // Swagger beta 操作台（spec §6）：listen 前挂载（与主应用 initSwagger
  // 同一时序）；@Public 端点（login/token/revocations）在 UI 内可直试，
  // 受保护端点经 Authorize 填管理员 JWT
  setupRaSwagger(app);

  const configService = app.get(ConfigService);
  const appConfig = configService.get<AppConfig>('app', AppConfig.getDefault());
  // JWT 密钥告警口径与主应用 main.ts 一致：未走 .env 的 JWT_SECRET 即告警
  //（fallback 随机垫底——管理员登录跨重启不可用；yml 遗留值建议迁移）
  if (jwtSecretSource.current !== 'env') {
    console.warn(
      '[安全告警][relay-admin] JWT 密钥未走 .env 的 JWT_SECRET（未配置或 yml 遗留值），请执行 npm run init（或手工写入 .env）后再用于生产环境！未配置时管理员登录跨重启不可用',
    );
  }

  // 监听地址与主应用同源解析（config.yml app.hostname，缺省 0.0.0.0）；
  // 不复用 emitListenSecurityWarnings 的 TIANSHU_TOKEN fail-closed——那是
  // 业务面 StaticTokenGuard 的放行面语义，本入口全路由 JWT 守卫（除
  // login/health），通配绑定只告警不拒绝
  const listenHostname = resolveListenHostname(appConfig.hostname);
  if (isWildcardAddress(listenHostname)) {
    console.warn(
      '[安全告警][relay-admin] HTTP 服务绑定 0.0.0.0/::（监听所有网卡），局域网/公网可达：控制平面请确认防火墙/反代收口，或将 config.yml app.hostname 指定为内网/回环地址',
    );
  }
  const port = process.env.RA_PORT || RA_DEFAULT_PORT;
  await app.listen(port, listenHostname);
  console.log(
    `[relay-admin] listening on http://${listenHostname}:${port} (RA_PORT 可覆盖)`,
  );

  // 优雅关闭（主应用 shutdown.ts 同款收口：RaPrismaService $disconnect 等）
  app.enableShutdownHooks();
  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) {
      process.exit(1); // 二次信号：优雅关闭耗住时的强退逃生门
    }
    closing = true;
    console.log(`[relay-admin] 收到 ${signal} 信号，开始优雅关闭...`);
    return shutdownAndExit(app);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGBREAK', () => void shutdown('SIGBREAK'));
}
bootstrap();

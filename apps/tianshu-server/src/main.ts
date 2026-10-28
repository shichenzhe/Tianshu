/* eslint-disable */
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import * as qs from 'qs';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import { buildOpenApiDocument } from './commons/swagger-document';

import { ConfigService } from '@nestjs/config';
import { instanceId } from './modules/info/info.controller';
import {
  resolveRelayLaunch,
  startHeadlessRelay,
  stopRelayAndExit,
} from './relay/relay-client';
import { TianshuConfig } from './commons/config/tianshu-config.entity';
import { AppConfig } from './commons/config/app-config.entity';
import { SwaggerConfig } from './commons/config/swagger-config.entity';
import { jwtSecretSource } from './commons/config/env-secret';
import {
  emitListenSecurityWarnings,
  resolveListenHostname,
} from './commons/web/listen-host';
import compression from 'compression';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      querystringParser: (str: string) => qs.parse(str),
      // 16MB：files/uploadImage 的 base64 载荷（3MB 图 ≈ 4MB+ JSON）——
      // Fastify 默认 1MB bodyLimit 正好卡死常规图片上传（真机实测
      // 「上传失败」根因；relay 链路另受 4MiB 帧上限约束）
      bodyLimit: 16 * 1024 * 1024,
    }),
  );

  // 启用全局验证管道，开启transform选项以支持class-transformer
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true, // 启用自动转换
      transformOptions: {
        enableImplicitConversion: true, // 启用隐式类型转换
      },
    }),
  );

  //加载应用配置
  const configService = app.get(ConfigService);
  const appConfig = configService.get<AppConfig>('app', AppConfig.getDefault());
  // JWT 密钥缺配/仍为模板默认值时给出告警（spec §13 项 6：密钥外移 .env 的
  // JWT_SECRET）。source 非 env = 未走 .env（fallback 随机垫底或 yml 遗留值
  // 建议迁移）；占位符字面量用拼接构造，避免被 init 的全文替换波及本文件
  const authConfig = configService.get<any>('auth');
  const jwtSecretPlaceholder = '{{' + 'JWT_SECRET' + '}}';
  const jwtSecret = authConfig?.jwt?.secret;
  if (
    jwtSecretSource.current !== 'env' ||
    jwtSecret === jwtSecretPlaceholder ||
    jwtSecret === '3C4F4BD192D0489FE0632F0C11ACBF35'
  ) {
    console.warn(
      '[安全告警] JWT 密钥未走 .env 的 JWT_SECRET（未配置或 yml 遗留值），请执行 npm run init（或手工写入 .env）后再用于生产环境！未配置时 JWT 登录跨重启不可用；天枢远控面走 TIANSHU_TOKEN 不受影响',
    );
  }
  //设置全局路径前缀
  app.setGlobalPrefix(appConfig.contextPath);
  // 初始化Swagger
  initSwagger(app);
  //优雅关闭应用
  gracefullShutdown(app);
  //允许跨域访问
  app.enableCors();
  //启用gzip压缩
  if (appConfig.compression?.enabled) {
    app.use(
      compression({
        threshold: appConfig.compression.threshold,
        level: appConfig.compression.level,
        memLevel: appConfig.compression.memLevel,
      }),
    );
  }
  //设置监听地址与端口号（终审必修 3：通配绑定/无 token 非 loopback 启动告警）
  const listenHostname = resolveListenHostname(appConfig.hostname);
  emitListenSecurityWarnings(
    listenHostname,
    process.env.TIANSHU_TOKEN,
    (message) => console.warn(message),
  );
  await app.listen(appConfig.port, listenHostname);

  //天枢桌面端启动握手：stdout 单行 JSON（tianshu.handshake 配置可关，默认开）
  //桌面端 spawn 本进程后扫 stdout 中 TIANSHU_HANDSHAKE 前缀行获取连接信息
  const tianshuConfig = configService.get<TianshuConfig>(
    'tianshu',
    TianshuConfig.getDefault(),
  );
  if (tianshuConfig.handshake) {
    console.log(
      `TIANSHU_HANDSHAKE ${JSON.stringify({
        port: appConfig.port,
        token: process.env.TIANSHU_TOKEN ?? '',
        instanceId,
      })}`,
    );
  }

  // 无头端 relay 客户端（CLI --relay-url/--relay-token 或 TIANSHU_RELAY_URL/
  // TIANSHU_RELAY_TOKEN；缺任一不启动——relay 接入必须鉴权）：register 后
  // req 帧 → inject 内部派发、EventBus → event 帧（见 relay/relay-client.ts）
  const relayLaunch = resolveRelayLaunch(process.argv.slice(2));
  if (relayLaunch) {
    await startHeadlessRelay({
      app,
      ...relayLaunch,
      // E2E 模式（config tianshu.relay.e2e，缺省 auto；E2E-T2）
      e2eMode: tianshuConfig.relay?.e2e ?? 'auto',
    }).catch((error: unknown) => {
        console.error('[relay-client] 启动失败（HTTP 面不受影响）:', error);
      },
    );
    // 信号收口：停 relay → app.close() → 进程退出（只停 relay 的话 fastify
    // 仍监听，首个 Ctrl-C 后进程不退出）
    const stopRelay = () => void stopRelayAndExit(app);
    process.once('SIGINT', stopRelay);
    process.once('SIGTERM', stopRelay);
  }
}

function initSwagger(app: NestFastifyApplication) {
  const configService = app.get(ConfigService);
  // 加载Swagger配置
  const swaggerConfig = configService.get<SwaggerConfig>(
    'swagger',
    SwaggerConfig.getDefault(),
  );

  // 根据配置决定是否启用Swagger（文档构建已抽 buildOpenApiDocument 单份，
  // 与 SDK 导出管线共用——SK-1）
  if (swaggerConfig.enabled) {
    const document = buildOpenApiDocument(app);
    // 使用配置的路径设置Swagger访问地址
    SwaggerModule.setup(swaggerConfig.path.replace('/', ''), app, document);
  }
}

/**
 * 优雅关闭应用
 * @param app NestFastifyApplication 实例
 */

function gracefullShutdown(app: NestFastifyApplication) {
  const gracefulShutdown = async (signal: string) => {
    console.log(`收到 ${signal} 信号，开始优雅关闭...`);

    // 监听进程信号
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    // 监听Windows下的关闭信号
    process.on('SIGBREAK', () => gracefulShutdown('SIGBREAK'));
  };
}
bootstrap();

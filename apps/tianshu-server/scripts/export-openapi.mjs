#!/usr/bin/env node
/**
 * OpenAPI 导出（SK-1，spec §2.1）：加载编译产物 dist/src/app.module.js，
 * NestFactory 创建不监听端口的 app（与 main.ts 同序：create → 全局前缀 →
 * 文档构建；不 init/listen——SwaggerModule 为元数据扫描，Prisma 连接、
 * session 默认空间兜底等生命周期钩子均不触发，无需数据库就位），产物写
 * openapi.json（gitignore，npm run sdk:export/generate 按需重生）。
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import * as qs from 'qs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(scriptDir, '..');
const outputPath = join(rootDir, 'openapi.json');
const outputUrl = (p) => pathToFileURL(p).href;

const { AppModule } = await import(outputUrl(join(rootDir, 'dist/src/app.module.js')));
const { buildOpenApiDocument } = await import(
  outputUrl(join(rootDir, 'dist/src/commons/swagger-document.js'))
);
const { NestFactory } = await import('@nestjs/core');
const { FastifyAdapter } = await import('@nestjs/platform-fastify');
const { ConfigService } = await import('@nestjs/config');
const { AppConfig } = await import(
  outputUrl(join(rootDir, 'dist/src/commons/config/app-config.entity.js'))
);

// main.ts 同款装配（querystring 解析器 + 不监听；logger 静默——脚本无交互面）
const app = await NestFactory.create(
  AppModule,
  new FastifyAdapter({
    querystringParser: (str) => qs.parse(str),
  }),
  { logger: false },
);
try {
  const configService = app.get(ConfigService);
  const appConfig = configService.get('app', AppConfig.getDefault());
  // 与 main.ts 同款全局前缀（缺省 '/'）：文档路径与线上服务面保持一致
  app.setGlobalPrefix(appConfig.contextPath);

  const document = buildOpenApiDocument(app);
  await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  console.log(
    `openapi.json 已导出（${Object.keys(document.paths).length} 个路径）→ ${outputPath}`,
  );
} finally {
  await app.close();
}

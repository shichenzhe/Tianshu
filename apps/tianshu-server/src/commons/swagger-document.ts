import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { SwaggerConfig } from './config/swagger-config.entity';

/**
 * OpenAPI 文档构建（SK-1，spec §2.1）：DocumentBuilder 配置自 main.ts
 * initSwagger 抽出单份——运行时 Swagger UI 与 scripts/export-openapi.mjs
 * 导出管线共用，避免双写漂移（标题/描述/版本取 swagger 配置段，
 * Basic+Bearer 双安全方案保持）。
 *
 * main.ts 仍自持 enabled 判定与 SwaggerModule.setup 挂载路径；本函数只管
 * 文档本体（不依赖 app.init——SwaggerModule 为元数据扫描，导出脚本据此
 * 创建不监听、不触发生命周期钩子的 app）。
 */
export function buildOpenApiDocument(app: INestApplication) {
  const configService = app.get(ConfigService);
  // 加载Swagger配置
  const swaggerConfig = configService.get<SwaggerConfig>(
    'swagger',
    SwaggerConfig.getDefault(),
  );

  const config = new DocumentBuilder()
    .setTitle(swaggerConfig.title)
    .setDescription(swaggerConfig.description)
    .setVersion(swaggerConfig.version)
    .addBasicAuth() //添加Basic认证
    .addBearerAuth() //添加JWT认证
    .build();
  return SwaggerModule.createDocument(app, config);
}

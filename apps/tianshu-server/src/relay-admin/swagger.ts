import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/** Swagger 操作台挂载路径（spec §6：beta 操作台即 Swagger，不做前端页面；
 *  README-relay 同款口径 http://localhost:8412/api-docs） */
export const RA_SWAGGER_PATH = 'api-docs';

/**
 * relay-admin Swagger 操作台挂载（spec §6，终审 fix）：与主应用 main.ts
 * initSwagger 同构（DocumentBuilder → createDocument → SwaggerModule.setup），
 * 差异两处——
 *
 * 1. 标题/描述独立（「tianshu relay-admin」），不读主应用 swagger 配置段：
 *    该段的 enabled 开关是业务面文档语义（缺省 false），控制平面操作台是
 *    spec 承诺面，恒挂载；标题区分避免与主应用文档混淆；
 * 2. 控制器仅 @ApiTags 级分组（beta 够用，不追求完整 DTO 文档）。
 *
 * 抽独立模块（不内联 main.ts）：main.ts 顶层无条件 bootstrap() 不可被
 * 测试导入，test/relay-admin 经本函数走与生产入口同一挂载路径。
 */
export function setupRaSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('tianshu relay-admin')
    .setDescription(
      'relay 运营控制平面 beta 操作台（管理员 JWT 登录态调用 / AK Basic 换 token / internal secret 协议端点）',
    )
    .setVersion('1.0.0')
    .addBearerAuth() // 管理员 JWT（/relay-admin/users、/relay-admin/aks 等）
    .addBasicAuth() // AK 凭证面（/relay-admin/token）
    .build();
  SwaggerModule.setup(
    RA_SWAGGER_PATH,
    app,
    SwaggerModule.createDocument(app, config),
  );
}

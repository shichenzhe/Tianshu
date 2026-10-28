/**
 * webhook 模块（GA-T7）：@Public 触发端点 + 注册管理 service（语义对照
 * 见 webhook.service.ts 头注释）。
 * GraphModule import 本模块：deleteGraph 的 unregisterWebhook 钩子接线
 * （GA-T3 改造点 4 的 no-op 缺省替换为真实实现）+ executor 运行时共驻
 * ——webhook 触发链依赖 GA-T4 运行时安装（graphExecutorRuntime）。
 */
import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/commons/database/prisma.module';
import { PrismaService } from 'src/commons/database/prisma.service';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';

@Module({
  imports: [PrismaModule],
  controllers: [WebhookController],
  providers: [
    // 工厂形态承载可选 deps 入口（产线缺省值；测试经 overrideProvider
    // 注入缩短超时/固定 token）
    {
      provide: WebhookService,
      useFactory: (prisma: PrismaService) => new WebhookService(prisma),
      inject: [PrismaService],
    },
  ],
  exports: [WebhookService],
})
export class WebhookModule {}

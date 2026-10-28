/**
 * 无头 chat 核心模块：注册 ChatRunnerService（T7 send 端点消费）。
 * config.yml tianshu 段 → ChatRunnerDeps.config 工厂装配（dataRoot 经
 * TIANSHU_DATA_ROOT 环境变量可覆盖，与桌面端测试隔离约定同构）。
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaModule } from 'src/commons/database/prisma.module';
import type { TianshuConfig } from 'src/commons/config/tianshu-config.entity';
import { TianshuConfig as TianshuConfigEntity } from 'src/commons/config/tianshu-config.entity';
import {
  ChatRunnerService,
  CHAT_RUNNER_DEPS,
  resolveDataRoot,
} from './chat-runner.service';

@Module({
  imports: [PrismaModule],
  providers: [
    {
      provide: CHAT_RUNNER_DEPS,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        config: () => {
          const tianshu = configService.get<TianshuConfig>(
            'tianshu',
            TianshuConfigEntity.getDefault(),
          );
          return {
            dataRoot: resolveDataRoot(tianshu.dataRoot),
            allowDangerousTools: tianshu.chat?.allowDangerousTools ?? false,
            // T6 复审 M3 / T7 审批裁定：删除保护与审批模式自 config 注入
            deleteProtection: tianshu.chat?.deleteProtection ?? true,
            accessMode: tianshu.chat?.accessMode ?? 'default',
            // manual 模式审批挂起上限（缺省 5 分钟，agent 装配处兜底同值）
            approvalTimeoutMs: tianshu.chat?.approvalTimeoutMs ?? 300_000,
          };
        },
      }),
    },
    ChatRunnerService,
  ],
  exports: [ChatRunnerService],
})
export class ChatCoreModule {}

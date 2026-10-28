import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/commons/database/prisma.module';
import { ChatCoreModule } from 'src/core/chat-core.module';
import { PermissionController } from './permission.controller';
import { PermissionService } from './permission.service';

/** 审批记忆模块（A10 批）：PrismaModule 全局供给；ChatCoreModule 供 full
 *  面运行态（ChatRunnerService 同源 PermissionStore）消费 */
@Module({
  imports: [PrismaModule, ChatCoreModule],
  controllers: [PermissionController],
  providers: [PermissionService],
})
export class PermissionModule {}

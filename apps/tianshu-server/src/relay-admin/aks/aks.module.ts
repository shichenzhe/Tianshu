import { Module } from '@nestjs/common';
import { AksController } from './aks.controller';
import { AksService } from './aks.service';

/** relay-admin AK 管理模块（Task 11）：RaPrismaService/RaAuditService 均
 * @Global 提供，无需显式 import（RaUsersModule 同款形态）。Task 12 起
 * exports AksService（token 模块消费 isAkUsable 凭证判定） */
@Module({
  controllers: [AksController],
  providers: [AksService],
  exports: [AksService],
})
export class AksModule {}

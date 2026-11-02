import { Module } from '@nestjs/common';
import { AksController } from './aks.controller';
import { AksService } from './aks.service';

/** relay-admin AK 管理模块（Task 11）：RaPrismaService/RaAuditService 均
 * @Global 提供，无需显式 import（RaUsersModule 同款形态） */
@Module({
  controllers: [AksController],
  providers: [AksService],
})
export class AksModule {}

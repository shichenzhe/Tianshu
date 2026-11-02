import { Module } from '@nestjs/common';
import { RaStatsController } from './ra-stats.controller';

/** relay-admin 在线视图模块（Task 13）：RelayLinkService 经 @Global
 *  RelayLinkModule 免 import 注入（RaAuditModule 同款形态） */
@Module({
  controllers: [RaStatsController],
})
export class StatsModule {}

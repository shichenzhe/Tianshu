import { Module } from '@nestjs/common';
import { InfoController } from './info.controller';

/**
 * 服务信息模块：GET /info capability 协商端点
 */
@Module({
  controllers: [InfoController],
})
export class InfoModule {}

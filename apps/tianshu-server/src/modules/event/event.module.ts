import { Module } from '@nestjs/common';
import { EventController } from './event.controller';

/**
 * 协议事件模块：GET /event SSE 承载（EventBusService 为全局模块直接注入）
 */
@Module({
  controllers: [EventController],
})
export class EventModule {}

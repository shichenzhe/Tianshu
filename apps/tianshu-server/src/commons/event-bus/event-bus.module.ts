import { Global, Module } from '@nestjs/common';
import { EventBusService } from './event-bus.service';

/**
 * 协议事件总线模块（全局）
 *
 * 全局导出 EventBusService，任意业务模块可直接注入发布协议事件，
 * /event SSE 层统一订阅转发。
 */
@Global()
@Module({
  providers: [EventBusService],
  exports: [EventBusService],
})
export class EventBusModule {}

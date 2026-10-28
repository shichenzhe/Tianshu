/**
 * 工具桥模块（TB-T1）：respond 端点 + 桥运行时装配（executor-runtime
 * 先例——工具注册表为模块级静态装配无 DI 缝，EventBus 出口/订阅者计数/
 * 超时配置经本模块工厂 installBridgeRuntime 注入）。
 * 进程关闭（onModuleDestroy）全量收敛挂起请求——respond 等待方拿到可读
 * 失败而非悬挂（spec §3）。
 * 桥工具定义经 tool-registry 静态注册（graph LLM 节点工具集消费）；
 * 本模块与 graph 模块无装配耦合——运行时在应用 bootstrap 期统一就位。
 */
import { Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventBusService } from 'src/commons/event-bus/event-bus.service';
import type { TianshuConfig } from 'src/commons/config/tianshu-config.entity';
import { TianshuConfig as TianshuConfigEntity } from 'src/commons/config/tianshu-config.entity';
import {
  abortAllBridgeRequests,
  installBridgeRuntime,
  resetBridgeRuntime,
  toolRequestEvent,
} from 'src/core/tools/bridge/bridge-registry';
import { ToolController } from './tool.controller';

/** 运行时安装 provider token（无消费面——Nest 启动期实例化工厂即安装） */
export const BRIDGE_RUNTIME = Symbol('BRIDGE_RUNTIME');

@Module({
  controllers: [ToolController],
  providers: [
    {
      provide: BRIDGE_RUNTIME,
      inject: [EventBusService, ConfigService],
      useFactory: (
        bus: EventBusService,
        configService: ConfigService,
      ): void => {
        const tianshu = configService.get<TianshuConfig>(
          'tianshu',
          TianshuConfigEntity.getDefault(),
        );
        installBridgeRuntime({
          publishToolRequest: (payload) =>
            bus.publish(toolRequestEvent(payload)),
          subscriberCount: () => bus.subscriberCount(),
          timeoutMs: () => tianshu?.bridge?.timeoutMs ?? 30_000,
          onSubscribersChanged: (handler) => bus.onSubscribersChanged(handler),
        });
      },
    },
  ],
})
export class ToolModule implements OnModuleDestroy {
  onModuleDestroy(): void {
    abortAllBridgeRequests('服务进程关闭（tool bridge shutdown）');
    resetBridgeRuntime();
  }
}

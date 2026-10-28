/**
 * 编排图模块（GA-T6 装配）：CRUD/试运行端点 + GA-T4 executor 进程级运行时
 * 安装（db=PrismaService、run 原语=GA-T3 仓储、事件出口=EventBus
 * graph.run.updated——executor 投影零 cast 直发）。EventBusModule 为全局
 * 模块（EventBusService 直接注入）。automation 模块 import 本模块以保证
 * 运行时先于其 scheduler/runner 消费就位。
 */
import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/commons/database/prisma.module';
import { PrismaService } from 'src/commons/database/prisma.service';
import { EventBusService } from 'src/commons/event-bus/event-bus.service';
import { WebhookModule } from 'src/modules/webhook/webhook.module';
import { WebhookService } from 'src/modules/webhook/webhook.service';
import {
  installGraphExecutorRuntime,
  type GraphExecutorRuntime,
} from 'src/core/graph/executor-runtime';
// installGraphExecutorRuntime 返回 void（安装即副作用）——工厂装完回
// runtime 本体作 provider 值（token 无消费面，Nest 启动期实例化即安装）
import { GraphRepository } from './graph.repository';
import { recordGraphMonitorEvents } from '@tianshu/core';
import { GraphService } from './graph.service';
import { GraphController } from './graph.controller';

/** 运行时安装 provider token（无消费面——Nest 启动期实例化工厂即安装） */
export const GRAPH_EXECUTOR_RUNTIME = Symbol('GRAPH_EXECUTOR_RUNTIME');

@Module({
  // WebhookModule（GA-T7）：deleteGraph 钩子接线依赖 WebhookService + 触发
  // 链依赖本模块安装的 executor 运行时（共驻保证）
  imports: [PrismaModule, WebhookModule],
  controllers: [GraphController],
  providers: [
    // GA-T3 改造点 4 钩子接线（GA-T7）：deleteGraph 的 webhook 注册清理
    // no-op 缺省替换为真实实现（mirror graph.repo 动态 import
    // webhook-server 的无头端等价）
    {
      provide: GraphRepository,
      useFactory: (prisma: PrismaService, webhook: WebhookService) =>
        new GraphRepository(prisma, (graphId: number) =>
          webhook.unregisterWebhook(graphId),
        ),
      inject: [PrismaService, WebhookService],
    },
    {
      provide: GRAPH_EXECUTOR_RUNTIME,
      inject: [PrismaService, GraphRepository, EventBusService],
      useFactory: (
        prisma: PrismaService,
        repository: GraphRepository,
        bus: EventBusService,
      ): GraphExecutorRuntime => {
        const runtime: GraphExecutorRuntime = {
          db: prisma,
          runs: repository,
          // 授权面 2/7（GA-T4 头注释）：db/run 原语 + 事件出口注入化
          publishRunUpdated: (payload) =>
            bus.publish({ type: 'graph.run.updated', payload }),
          // 授权面 5（MO 批兑现）：trace 收尾 → 监控事件（fire-and-forget
          // 吞错在 core recordGraphMonitorEvents 内）
          recordMonitorEvents: (params) =>
            void recordGraphMonitorEvents(prisma, params),
        };
        installGraphExecutorRuntime(runtime);
        return runtime;
      },
    },
    GraphService,
  ],
  exports: [GraphRepository],
})
export class GraphModule {}

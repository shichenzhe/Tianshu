/**
 * 自动化模块（GA-T6 装配，T5 待收口面 2）：
 * - AutomationScheduler：deps 事件钩子接 EventBus（automation.changed）；
 *   config 未注入走 ConfigService tianshu 段 > 实体缺省三级回退；
 *   onApplicationBootstrap 即自动启 tick（随模块生命周期）
 * - AutomationRepository：runNow 收尾事件 + 无人值守 safety 值面
 *   （config tianshu.chat 段，与 scheduler 同源）经 deps 注入
 * - import GraphModule：GA-T4 executor 运行时先于此模块的消费面
 *   （runner 经 graphExecutorRuntime() 取库）就位——模块依赖序保证
 * - publishAutomationEvent（链式事件总线）已接线（EB 批 2026-10-27）：
 *   createAutomationEventBus 单实例注入 scheduler/repo 两 deps——
 *   appStarted（scheduler.start）+ launch/runNow 收官三发布点生效
 * - disabledTools 未注入（SP6 裁定 2 缺省不滤；安全配置面后续按需）
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { join } from 'node:path';
import { PrismaModule } from 'src/commons/database/prisma.module';
import { PrismaService } from 'src/commons/database/prisma.service';
import { EventBusService } from 'src/commons/event-bus/event-bus.service';
import type { AutomationChangedPayload } from '@tianshu/protocol';
import { resolveDataRoot } from 'src/core/chat-runner.service';
import {
  TianshuConfig as TianshuConfigEntity,
  type TianshuConfig,
} from 'src/commons/config/tianshu-config.entity';
import { GraphModule } from 'src/modules/graph/graph.module';
import { AutomationScheduler } from './automation-scheduler';
import {
  AutomationRepository,
  AUTOMATION_REPO_DEPS,
} from './automation.repository';
import { AUTOMATION_SCHEDULER_DEPS } from './automation-scheduler';
import { AutomationService } from './automation.service';
import { AutomationController } from './automation.controller';
import {
  AUTOMATION_EVENT_BUS,
  createAutomationEventBus,
  type AutomationEventBus,
} from './automation-event-bus';

/** 无人值守安全装配（config tianshu.chat 段，spec §6；scheduler/repo
 * deps 与事件总线同源同款——三触发路径安全口径一致） */
function automationSafety(configService: ConfigService) {
  const tianshu = configService.get<TianshuConfig>(
    'tianshu',
    TianshuConfigEntity.getDefault(),
  );
  return {
    allowDangerousTools: tianshu.chat?.allowDangerousTools ?? false,
    deleteProtection: tianshu.chat?.deleteProtection ?? true,
    trashRoot: join(resolveDataRoot(tianshu.dataRoot), 'trash'),
  };
}

@Module({
  imports: [PrismaModule, GraphModule],
  controllers: [AutomationController],
  providers: [
    {
      // 链式事件总线单实例（EB 批）：appStarted（scheduler.start）+
      // launch/runNow 收官三发布点同源；automation.changed 广播自补
      provide: AUTOMATION_EVENT_BUS,
      inject: [EventBusService, PrismaService, ConfigService],
      useFactory: (
        bus: EventBusService,
        prisma: PrismaService,
        configService: ConfigService,
      ) =>
        createAutomationEventBus({
          prisma,
          publishAutomationChanged: (payload: AutomationChangedPayload) =>
            bus.publish({ type: 'automation.changed', payload }),
          safety: () => automationSafety(configService),
        }),
    },
    {
      provide: AUTOMATION_SCHEDULER_DEPS,
      inject: [EventBusService, AUTOMATION_EVENT_BUS],
      useFactory: (
        bus: EventBusService,
        publishAutomationEvent: AutomationEventBus,
      ) => ({
        // 任务级刷新信号（GA-T6 协议收口；scheduler 调度/执行路径只带 taskId）
        publishAutomationChanged: (payload: AutomationChangedPayload) =>
          bus.publish({ type: 'automation.changed', payload }),
        // 链式事件发布（改造点 7）：EB 批接真身（此前缺省 no-op）
        publishAutomationEvent,
      }),
    },
    {
      provide: AUTOMATION_REPO_DEPS,
      inject: [EventBusService, ConfigService, AUTOMATION_EVENT_BUS],
      useFactory: (
        bus: EventBusService,
        configService: ConfigService,
        publishAutomationEvent: AutomationEventBus,
      ) => ({
        publishAutomationChanged: (payload: AutomationChangedPayload) =>
          bus.publish({ type: 'automation.changed', payload }),
        // runNow 无人值守安全值面（spec §6 联动 config tianshu.chat 段，
        // scheduler.safety() 同源同款）
        safety: () => automationSafety(configService),
        // runNow 收官链式事件（repository:342 缝，此前缺省 no-op）
        publishAutomationEvent,
      }),
    },
    AutomationRepository,
    AutomationScheduler,
    AutomationService,
  ],
})
export class AutomationModule {}

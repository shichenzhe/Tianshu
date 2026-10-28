/**
 * 事件触发总线（EB 批 2026-10-27；mirror electron/domains/ai/automation/
 * automation-event-bus.ts 副本，spec §5 语义逐段对齐）：publish → 匹配
 * enabled+active 任务 → launch。防环：链深 >MAX_CHAIN_DEPTH 落
 * skipped(chain_depth_exceeded)；互斥复用 inflight。
 * 发布方（scheduler.launch / repository runNow 收官、scheduler.start 的
 * appStarted）经 deps.publishAutomationEvent 钩子调本模块——依赖单向：
 * event-bus → runner，不 import 发布方。
 *
 * ================= server 环境适配点登记（其余逐段保持 mirror） =================
 * 1. prisma → deps 注入（PrismaService 最小投影）；commons/Log → Nest Logger
 * 2. mirror BrowserWindow notifyChanged() 全窗口广播 → deps.
 *    publishAutomationChanged({taskId})（automation.changed 协议事件，
 *    EventBusService 承担——Ruling 10；事件路径不经 scheduler.launch 的
 *    finally，这里自补，与 scheduler notifyChanged 同语义）
 * 3. executeTask 透传 deps.safety?.()（与 runNow 手动触发同源安全口径，
 *    repository deps 同款装配）；disabledTools 不引入——SP6 裁定 2 缺省
 *    不滤（server 无全局禁用配置面，后续按需）
 * 4. 模块级函数 → createAutomationEventBus(deps) 工厂（module 工厂装配
 *    单实例注入两 deps token；直连单测免 Nest 容器）
 * 5. AutomationChainEvent/taskFinishedEvent/executeTask/inflight 引自本仓
 *    伴生副本（automation-runner / automation-inflight，GA 批已摘）
 * ============================================================================
 */
import { Logger } from '@nestjs/common';
import { eventJsonSchema, type EventTriggerConfig } from '@tianshu/core';
import type { AutomationChangedPayload } from '@tianshu/protocol';
import type { PrismaService } from 'src/commons/database/prisma.service';
import {
  executeTask,
  taskFinishedEvent,
  type AutomationChainEvent,
  type AutomationSafetyOptions,
} from './automation-runner';
import type { AutomationTaskRow } from 'src/core/graph/graph-executor';
import { inflight } from './automation-inflight';

export const MAX_CHAIN_DEPTH = 5;

/** 工厂依赖（module 工厂装配；测试直连构造） */
export interface AutomationEventBusDeps {
  prisma: Pick<PrismaService, 'automationTask' | 'automationRun'>;
  /** 任务级刷新信号出口（automation.changed；未注入不发——纯函数面测试） */
  publishAutomationChanged?: (payload: AutomationChangedPayload) => void;
  /** 无人值守安全装配（与 runNow 手动触发同源；未注入走 executeTask
   *   safety 可选缺省——安全侧缺省值） */
  safety?: () => AutomationSafetyOptions | undefined;
}

/** 事件匹配视图：publish 查询行的最小投影（纯函数单测主体） */
export type EventMatchableTask = Pick<
  AutomationTaskRow,
  'id' | 'eventJson' | 'enabled' | 'status'
>;

export interface EventTaskMatch {
  task: EventMatchableTask;
  inputs: Record<string, string>;
}

/** 事件 → 任务匹配纯函数（spec §5）：eventJson 经 schema 解析（坏行静默
 * 跳过）；taskFinished 按 targetType/targetId/on 过滤并注入 {outcome} 输入
 * 变量；enabled/status 双保险（findMany where 已滤，函数再容错） */
export function matchEventTasks(
  tasks: EventMatchableTask[],
  event: AutomationChainEvent,
): EventTaskMatch[] {
  const hits: EventTaskMatch[] = [];
  for (const t of tasks) {
    if (!t.enabled || t.status !== 'active' || !t.eventJson) {
      continue;
    }
    let ev: EventTriggerConfig;
    try {
      ev = eventJsonSchema.parse(JSON.parse(t.eventJson));
    } catch {
      continue;
    }
    if (ev.source !== event.source) {
      continue;
    }
    if (event.source === 'taskFinished' && ev.source === 'taskFinished') {
      if (
        ev.targetType !== event.targetType ||
        ev.targetId !== event.targetId
      ) {
        continue;
      }
      if (ev.on !== 'any' && ev.on !== event.outcome) {
        continue;
      }
      hits.push({ task: t, inputs: { outcome: event.outcome } });
    } else if (event.source === 'appStarted') {
      hits.push({ task: t, inputs: {} });
    }
  }
  return hits;
}

/** 事件触发未执行留痕：skipped run 行（链深超限/在途互斥两种错误码） */
async function recordSkippedRun(
  prisma: AutomationEventBusDeps['prisma'],
  taskId: number,
  errorCode: string,
): Promise<void> {
  const now = new Date();
  await prisma.automationRun.create({
    data: {
      taskId,
      triggerType: 'event',
      status: 'skipped',
      error: errorCode,
      startedAt: now,
      finishedAt: now,
    },
  });
}

/** 事件总线实例（publishAutomationEvent 单函数面） */
export type AutomationEventBus = (
  event: AutomationChainEvent,
  chainDepth?: number,
) => Promise<void>;

/** Nest 注入 token（module 单实例装配——scheduler/repo 两 deps 共用，
 * appStarted + launch + runNow 三发布点同源；缺席时 deps 钩子缺省 no-op） */
export const AUTOMATION_EVENT_BUS = Symbol('AUTOMATION_EVENT_BUS');

/**
 * 事件发布（spec §5）：查 enabled+active+eventJson 任务 → 匹配 → 逐个
 * 执行（互斥复用 inflight）。链式：event 触发的 run 完成同样成为
 * taskFinished 源（chainDepth+1 透传），深度 >MAX_CHAIN_DEPTH 落
 * skipped(chain_depth_exceeded) 终止传播。异常全吞（绝不向发布方抛）。
 */
export function createAutomationEventBus(
  deps: AutomationEventBusDeps,
): AutomationEventBus {
  const logger = new Logger('AutomationEventBus');
  return async function publishAutomationEvent(
    event: AutomationChainEvent,
    chainDepth = 1,
  ): Promise<void> {
    try {
      const tasks = await deps.prisma.automationTask.findMany({
        where: { enabled: true, status: 'active', eventJson: { not: null } },
      });
      for (const { task, inputs } of matchEventTasks(tasks, event)) {
        if (chainDepth > MAX_CHAIN_DEPTH) {
          await recordSkippedRun(deps.prisma, task.id, 'chain_depth_exceeded');
          continue;
        }
        if (inflight.has(task.id)) {
          await recordSkippedRun(deps.prisma, task.id, 'event_skipped_running');
          continue;
        }
        const abort = new AbortController();
        inflight.set(task.id, abort);
        // findMany 全行，Pick 仅为匹配视图——此处还原全行
        const full = task as AutomationTaskRow;
        const outcome = await executeTask(full, {
          triggerType: 'event',
          attempt: 1,
          abort: abort.signal,
          safety: deps.safety?.(),
          inputs,
        }).catch((): 'failed' => 'failed');
        inflight.delete(task.id);
        // 收官广播（spec §5 继承 scheduler.notifyChanged）：事件路径不经
        // scheduler.launch 的 finally，这里自补——控制端列表/面板即时刷新
        deps.publishAutomationChanged?.({ taskId: task.id });
        // 链式发布：event 触发的 run 完成同样成为 taskFinished 源（spec §5）
        await publishAutomationEvent(
          taskFinishedEvent(full, outcome),
          chainDepth + 1,
        );
      }
    } catch (e) {
      logger.error(
        `自动化事件触发异常: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };
}

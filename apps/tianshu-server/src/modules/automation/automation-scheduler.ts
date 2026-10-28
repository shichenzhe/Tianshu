/**
 * 调度器（自 mirror
 * electron/domains/ai/automation/automation-scheduler.ts 摘取，GA-T5）：
 * tick（缺省 30s，可配）+ 决策树 + 重试扫描。
 * 互斥：进程级 inflight 注册表（automation-inflight，与 repo runNow 手动
 * 触发共享，taskId → AbortController）；退出 abort 全部在途。
 * 推送：执行/过期/异常后经任务级事件出口通知（mirror 全窗口
 * AUTOMATION_CHANGED_EVENT 广播 → automation.changed，T6 协议收口）。
 *
 * ================= GA-T5 server 副本改造点登记（其余逐行保持） =================
 * 1. Electron BrowserWindow 推送 → deps.publishAutomationChanged 钩子
 *    （GA-T6 协议收口：载荷 = 协议包 AutomationChangedPayload {taskId,
 *    enabled?, nextRunAt?}——调度/执行路径只带 taskId（刷新信号语义，
 *    消费端重拉列表为准）；未注入不发（纯落库模式）
 * 2. NestJS lifecycle（绑定）：onApplicationBootstrap 启 tick /
 *    onApplicationDestroy 停 + abort 全部在途（mirror Application 手动
 *    start/stop 语义等价，start/stop 公开面保留）
 * 3. tick 间隔可配：mirror 常量 TICK_MS=30_000 → config
 *    tianshu.automation.tickMs（tianshu-config.entity 增段，缺省 30_000，
 *    E2E/测试可缩短）；deps.config 显式注入优先
 * 4. prisma 模块单例 → 构造注入 PrismaService（NestJS DI）
 * 5. ./schedule computeNextRun/ScheduleConfig → @tianshu/core（GA-T2 收编）
 * 6. automation-runner 符号 → 本目录 runner 副本；AutomationTaskRow 单向引
 *    executor 副本尾段（ruling 8）
 * 7. automation-event-bus publishAutomationEvent/taskFinishedEvent 未随摘
 *    （事件总线副本不在 T5 摘取面）→ deps.publishAutomationEvent 钩子 +
 *    runner 副本 taskFinishedEvent（改造点 11）；缺省 no-op，总线副本落地
 *    后接线
 * 8. commons/Log → Nest Logger
 * 9. 无人值守安全装配（spec §6）：launch 透传 safety（config
 *    tianshu.chat.allowDangerousTools/deleteProtection/dataRoot 联动，
 *    runner 改造点 8 消费）
 * ============================================================================
 */
/* lint 并检适配（GA-T5 备案，GA-T4 整文件豁免先例）：await-thenable 系
 * mirror 原文即有的 await this.launch(...)（launch 返回 void，fire 语义）
 * 形态——逐行保持优先，豁免不改运行时行为 */
/* eslint-disable @typescript-eslint/await-thenable */
import {
  Injectable,
  Logger,
  Optional,
  Inject,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { join } from 'node:path';
import { computeNextRun, type ScheduleConfig } from '@tianshu/core';
import type { AutomationChangedPayload } from '@tianshu/protocol';
import { PrismaService } from 'src/commons/database/prisma.service';
import {
  TianshuConfig as TianshuConfigEntity,
  type TianshuConfig,
} from 'src/commons/config/tianshu-config.entity';
import { resolveDataRoot } from 'src/core/chat-runner.service';
import {
  executeTask,
  taskFinishedEvent,
  type AutomationChainEvent,
  type AutomationSafetyOptions,
} from './automation-runner';
import type { AutomationTaskRow } from '../../core/graph/graph-executor';
import { inflight } from './automation-inflight';
import { maybeTrimAutomationRuns } from './automation-retention';

/** tick 间隔缺省（mirror TICK_MS；config tianshu.automation.tickMs 可配） */
const DEFAULT_TICK_MS = 30_000;
const RETRY_DELAY_MS = 60_000;
const MAX_ATTEMPT = 3;

/** 运行配置（config.yml tianshu 段消费集） */
export interface AutomationSchedulerConfig {
  /** tick 间隔（automation 段；E2E/测试可缩短） */
  tickMs: number;
  /** 危险工具开关（chat 段，spec §6 联动）：透传 executeTask safety */
  allowDangerousTools: boolean;
  /** 删除保护（chat 段）：透传 executeTask safety */
  deleteProtection: boolean;
  /** 数据根（trash 派生） */
  dataRoot: string;
}

/** 可注入依赖（测试替身注入面；生产走 automation.module 工厂装配 T6） */
export interface AutomationSchedulerDeps {
  /** 配置读取（缺省读 ConfigService tianshu 段 > 实体缺省值） */
  config?: () => AutomationSchedulerConfig;
  /** 工具禁用清单闭包（SP6 裁定 2）：缺省不滤；调度执行与 runNow 手动
   * 触发同一过滤 */
  disabledTools?: () => string[];
  /** 任务级事件出口（改造点 1，GA-T6 协议收口）：未注入不发 */
  publishAutomationChanged?: (payload: AutomationChangedPayload) => void;
  /** 链式事件发布（改造点 7）：未注入 no-op */
  publishAutomationEvent?: (event: AutomationChainEvent) => void;
}

/** Nest 注入 token（缺席时构造缺省依赖，直连单测无需装配） */
export const AUTOMATION_SCHEDULER_DEPS = Symbol('AUTOMATION_SCHEDULER_DEPS');

export type TickDecision =
  'execute' | 'catchUp' | 'skip' | 'advance' | 'expire' | 'noop';

/** periodic once 判定（JSON 容错：坏配置按非 once 走 advance 常规推进） */
function isOnceSchedule(scheduleJson: string): boolean {
  try {
    const cfg = JSON.parse(scheduleJson) as ScheduleConfig;
    return cfg.mode === 'periodic' && cfg.kind === 'once';
  } catch {
    return false;
  }
}

/** 决策树纯函数（spec §4；once 已跑过 = expire） */
export function decideTick(
  task: AutomationTaskRow,
  now: Date,
  processStartTime: Date,
): TickDecision {
  if (task.startAt && now < task.startAt) {
    return 'noop';
  }
  if (task.endAt && now > task.endAt) {
    return 'expire';
  }
  if (!task.nextRunAt) {
    // once:从未跑过且 runAt 已过也走 expire 由 runner 不再触发;此处仅到期回收
    return 'expire';
  }
  if (now < task.nextRunAt) {
    return 'noop';
  }
  if (task.lastRunAt && task.lastRunAt >= task.nextRunAt) {
    // once 已跑过(runAt 过期)无下个触发点,computeNextRun 只会返回 null——
    // 与其 advance 落 NULL 再等下个 tick 回收,直接终态 expire(用例:once → expire)
    return isOnceSchedule(task.scheduleJson) ? 'expire' : 'advance';
  }
  return task.nextRunAt < processStartTime
    ? task.missedPolicy === 'catchUpOnce'
      ? 'catchUp'
      : 'skip'
    : 'execute';
}

/** 重试扫描纯函数：failed && attempt<3 && finishedAt 早于 now-60s */
export function pickRetryTaskIds(
  latestRunByTask: Map<
    number,
    { status: string; attempt: number; finishedAt?: Date }
  >,
  now: Date,
  delayMs = RETRY_DELAY_MS,
): number[] {
  const ids: number[] = [];
  for (const [taskId, run] of latestRunByTask) {
    if (
      run.status === 'failed' &&
      run.attempt < MAX_ATTEMPT &&
      run.finishedAt &&
      now.getTime() - run.finishedAt.getTime() >= delayMs
    ) {
      ids.push(taskId);
    }
  }
  return ids;
}

/** 缺省配置（改造点 3：config tianshu 段 > 实体缺省值；chat-core.module
 * 工厂装配同款模式） */
function defaultSchedulerConfig(
  cs?: ConfigService,
): () => AutomationSchedulerConfig {
  return () => {
    const tianshu =
      cs?.get<TianshuConfig | undefined>('tianshu') ??
      TianshuConfigEntity.getDefault();
    return {
      tickMs: tianshu.automation?.tickMs ?? DEFAULT_TICK_MS,
      allowDangerousTools: tianshu.chat?.allowDangerousTools ?? false,
      deleteProtection: tianshu.chat?.deleteProtection ?? true,
      dataRoot: resolveDataRoot(tianshu.dataRoot),
    };
  };
}

@Injectable()
export class AutomationScheduler
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private timer?: NodeJS.Timeout;
  private processStartTime = new Date();
  // 工具禁用清单闭包（SP6 裁定 2）：装配层注入（实时读配置）；缺省不滤
  // （测试），调度执行与 runNow 手动触发同一过滤
  private disabledTools: () => string[] = () => [];
  private readonly logger = new Logger(AutomationScheduler.name);
  private readonly deps: { config: () => AutomationSchedulerConfig } & Omit<
    AutomationSchedulerDeps,
    'config'
  >;

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(AUTOMATION_SCHEDULER_DEPS)
    deps: AutomationSchedulerDeps = {},
    @Optional() configService?: ConfigService,
  ) {
    this.deps = {
      ...deps,
      config: deps.config ?? defaultSchedulerConfig(configService),
    };
    if (deps.disabledTools) {
      this.disabledTools = deps.disabledTools;
    }
  }

  /** NestJS lifecycle（改造点 2）：应用就绪即启 tick */
  onApplicationBootstrap(): void {
    // 执行历史保留裁剪：启动即裁一次（对齐 mirror scheduler start() 挂点）
    void maybeTrimAutomationRuns(this.prisma);
    // automationStat 90 天裁剪：对齐 mirror commons ensureEventStatMaintenance
    // 语义（mirror 在启动链 prisma-client.ts:115；server 端此前完全无裁剪）。
    // server 不写 llm/toolCallEvent（2026-10-22 复核），无需处理。
    const statCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    void this.prisma.automationStat
      .deleteMany({ where: { createdAt: { lt: statCutoff } } })
      .catch((e) => this.logger.warn('automationStat 裁剪失败', e));
    this.start(this.deps.disabledTools);
  }

  /** NestJS lifecycle（改造点 2）：停 tick + abort 全部在途（应用关闭时，
   * onModuleDestroy 即 mirror Application 退场 stop 语义） */
  onModuleDestroy(): void {
    this.stop();
  }

  start(disabledTools?: () => string[]): void {
    if (disabledTools) {
      this.disabledTools = disabledTools;
    }
    // 崩溃残留：running 的 run 全部置 failed(interrupted)(spec §7)。
    // catch 收敛防 unhandledRejection（首 DB 触点抖动即崩进程——终审 F2，
    // GA-T6 fix 同款）
    void this.recoverInterruptedRuns().catch((e): void => {
      this.logger.error(`自动化中断恢复失败 ${String(e)}`);
    });
    this.timer = setInterval(() => {
      void this.tick();
    }, this.deps.config().tickMs);
    this.logger.log('自动化调度器已启动');
    // 启动事件(spec §5)：appStarted 触发的任务在本次发布中拉起
    this.deps.publishAutomationEvent?.({ source: 'appStarted' });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const abort of inflight.values()) {
      abort.abort();
    }
    inflight.clear();
  }

  private async recoverInterruptedRuns(): Promise<void> {
    const result = await this.prisma.automationRun.updateMany({
      where: { status: 'running' },
      data: { status: 'failed', error: 'interrupted', finishedAt: new Date() },
    });
    if (result.count > 0) {
      this.logger.log(`回收中断运行记录 ${result.count} 条`);
    }
  }

  private async tick(): Promise<void> {
    try {
      // 只调度 enabled+active：once 到期后 runner 的 advanceTask 置
      // status="expired" 但不动 enabled，不滤 status 会让 expire 分支每 30s
      // 重写该行(updatedAt 抖动)并向全窗口广播，前端无谓 invalidate 重拉；
      // error 任务已被 enabled=false 滤掉，重新启用时 repo toggle 置回
      // active——故 active+enabled 是唯一应参与调度的集合(applyDecision
      // 的 expire 分支保留，首次到期仍生效)
      const tasks = await this.prisma.automationTask.findMany({
        where: { enabled: true, status: 'active' },
      });
      const latestRun = await this.loadLatestRuns();
      // 重试预算集(最新 run failed 且 attempt<3;delayMs=0 不看 60s 冷却，
      // 冷却期内同样不许 expire)：once 非系统失败后 nextRunAt=null、status 仍
      // active，若决策树 !nextRunAt 先行 expire，任务会被上面的 active 过滤
      // 出局、永远等不到 scanRetries——故 expire 让路；attempt 耗尽后不再
      // 入选，由 !nextRunAt 分支兜底置 expired 收尾(spec §7 闭环)
      const retryPending = new Set(pickRetryTaskIds(latestRun, new Date(), 0));
      // GA-T6：批量 tick 的任务级事件逐 id 发布（载荷 taskId 必带——
      // mirror 单次全窗口广播语义等价为「每任务一个刷新信号」）
      const changedIds: number[] = [];
      for (const task of tasks) {
        // 在途执行不决策(含 runNow 手动触发)：防重试运行中被过期快照误
        // expire/重复触发
        if (inflight.has(task.id)) {
          continue;
        }
        const decision = decideTick(task, new Date(), this.processStartTime);
        if (decision === 'noop') {
          continue;
        }
        if (decision === 'expire' && retryPending.has(task.id)) {
          continue;
        }
        changedIds.push(task.id);
        await this.applyDecision(task, decision);
      }
      await this.scanRetries(latestRun);
      for (const id of changedIds) {
        this.notifyChanged(id);
      }
    } catch (e) {
      this.logger.error(`自动化调度 tick 异常 ${String(e)}`);
    }
    // 6h 节流，命中时开销仅一次时间比较（mirror 同款挂点）
    void maybeTrimAutomationRuns(this.prisma);
  }

  private async applyDecision(
    task: AutomationTaskRow,
    decision: TickDecision,
  ): Promise<void> {
    const now = new Date();
    const schedule = JSON.parse(task.scheduleJson) as ScheduleConfig;
    switch (decision) {
      case 'expire':
        await this.prisma.automationTask.update({
          where: { id: task.id },
          data: { status: 'expired' },
        });
        return;
      case 'advance': {
        const next = computeNextRun(schedule, now, task.lastRunAt ?? undefined);
        await this.prisma.automationTask.update({
          where: { id: task.id },
          data: { nextRunAt: next },
        });
        return;
      }
      case 'skip':
        await this.prisma.automationRun.create({
          data: {
            taskId: task.id,
            triggerType: 'schedule',
            status: 'skipped',
            startedAt: now,
            finishedAt: now,
          },
        });
        await this.prisma.automationTask.update({
          where: { id: task.id },
          data: {
            nextRunAt: computeNextRun(
              schedule,
              now,
              task.lastRunAt ?? undefined,
            ),
          },
        });
        return;
      case 'execute':
        await this.launch(task, 'schedule', 1);
        return;
      case 'catchUp':
        await this.launch(task, 'catchUp', 1);
        return;
    }
  }

  /** 每 taskId 取最新一条 run(id 倒序取 500 条内首个) */
  private async loadLatestRuns(): Promise<
    Map<number, { status: string; attempt: number; finishedAt?: Date }>
  > {
    const runs = await this.prisma.automationRun.findMany({
      orderBy: { id: 'desc' },
      take: 500,
      // 30s 轮询热路径只取决策四列：graphTrace（节点级轨迹大 JSON）
      // 单条可达数十 KB，500 行全列读回纯属搬运
      select: {
        taskId: true,
        status: true,
        attempt: true,
        finishedAt: true,
      },
    });
    const latest = new Map<
      number,
      { status: string; attempt: number; finishedAt?: Date }
    >();
    for (const run of runs) {
      // 图试运行 run(taskId=null)不挂任务，不参与任务重试决策
      if (run.taskId === null) {
        continue;
      }
      if (!latest.has(run.taskId)) {
        latest.set(run.taskId, {
          status: run.status,
          attempt: run.attempt,
          finishedAt: run.finishedAt ?? undefined,
        });
      }
    }
    return latest;
  }

  /** 重试扫描：按 run 反查 taskId 独立取任务行(不复用 tick 调度快照——once
   * 失败任务 nextRunAt 已被推进，仍需可重试) */
  private async scanRetries(
    latestRun: Map<
      number,
      { status: string; attempt: number; finishedAt?: Date }
    >,
  ): Promise<void> {
    const retryIds = pickRetryTaskIds(latestRun, new Date());
    if (retryIds.length === 0) {
      return;
    }
    // 独立查询同样限 active+enabled：once 失败任务 status 未置 expired 所以
    // 能入选;attempt 耗尽(=3)后 pickRetryTaskIds 不再给出，交由决策树收尾
    const tasks = await this.prisma.automationTask.findMany({
      where: { id: { in: retryIds }, enabled: true, status: 'active' },
    });
    const byId = new Map(tasks.map((t) => [t.id, t]));
    for (const taskId of retryIds) {
      const task = byId.get(taskId);
      const attempt = (latestRun.get(taskId)?.attempt ?? 0) + 1;
      if (task) {
        await this.launch(task, 'retry', attempt);
      }
    }
  }

  /** 无人值守安全装配（改造点 9）：config 联动值面 → executeTask safety */
  private safety(): AutomationSafetyOptions {
    const config = this.deps.config();
    return {
      allowDangerousTools: config.allowDangerousTools,
      deleteProtection: config.deleteProtection,
      trashRoot: join(config.dataRoot, 'trash'),
    };
  }

  /** fire：不 await 完成，互斥已有则跳过（共享 inflight，含 runNow 手动
   * 触发）。收口发布 taskFinished(spec §5 链式事件源)：outcome 在 finally
   * 前取得，.catch 兜异常按 failed 发布；finally 保持 inflight 清理 +
   * notifyChanged。triggerType 不含 event：事件触发由 event-bus 直调
   * executeTask(chainDepth 防环在彼处)，误经此处会以链深 1 重置防环 */
  private launch(
    task: AutomationTaskRow,
    triggerType: 'schedule' | 'catchUp' | 'retry',
    attempt: number,
    inputs?: Record<string, string>,
  ): void {
    if (inflight.has(task.id)) {
      return;
    }
    const abort = new AbortController();
    inflight.set(task.id, abort);
    void executeTask(task, {
      triggerType,
      attempt,
      abort: abort.signal,
      disabledTools: this.disabledTools,
      safety: this.safety(),
      inputs,
    })
      .catch((e): 'failed' => {
        this.logger.error(`自动化执行失败 ${task.id} ${String(e)}`);
        return 'failed';
      })
      .then((outcome) => {
        this.deps.publishAutomationEvent?.(taskFinishedEvent(task, outcome));
      })
      .finally(() => {
        inflight.delete(task.id);
        this.notifyChanged(task.id);
      });
  }

  private notifyChanged(taskId: number): void {
    // 改造点 1（GA-T6 收口）：mirror 全窗口 AUTOMATION_CHANGED_EVENT 广播
    // → 任务级事件出口（EventBus automation.changed，载荷见协议包）；未注入不发
    this.deps.publishAutomationChanged?.({ taskId });
  }
}

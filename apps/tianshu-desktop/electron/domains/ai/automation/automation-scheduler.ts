/**
 * 调度器(spec §4):30s tick + 决策树 + 重试扫描。
 * 互斥:进程级 inflight 注册表(automation-inflight,与 repo runNow 手动
 * 触发共享,taskId → AbortController);退出 abort 全部在途。
 * 推送:执行/过期/异常后向全部窗口发 AUTOMATION_CHANGED_EVENT。
 * 批3A(spec §6-1/4/6):重试指数退避(60/180/540s,按 classifyError 分类
 * 区分可重试面)+ 错过补跑上限 catchUpLimit(缺省 1)+ 每日统计 rollup
 * (tick 收尾节流写,automation-stat.ts)。
 */
import prisma from "../../../commons/prisma-client";
import Log from "../../../commons/Log";
// computeNextRun 与批3A 退避/可重试面纯函数均单源 @tianshu/core(schedule.ts
// re-export 兼容层透传)
import { computeNextRun, isRetryableRunError, nextRetryDelay } from "./schedule";
import { executeTask, type AutomationTaskRow } from "./automation-runner";
import { inflight } from "./automation-inflight";
import {
  publishAutomationEvent,
  taskFinishedEvent,
} from "./automation-event-bus";
import { maybeTrimAutomationRuns } from "./automation-retention";
import { maybeRollupAutomationStats } from "./automation-stat";
import { emitAutomationChanged } from "./automation-change-bus";
import type { ScheduleConfig } from "../../../../src-react/domains/ai/automation/api/schedule.schema";

const TICK_MS = 30_000;
const MAX_ATTEMPT = 3;
/** 补跑上限缺口回退(=既有 catchUpOnce 行为)与 clamp 顶(防补跑风暴) */
const DEFAULT_CATCH_UP_LIMIT = 1;
export const MAX_CATCH_UP_LIMIT = 10;

export type TickDecision =
  "execute" | "catchUp" | "skip" | "advance" | "expire" | "noop";

/** periodic once 判定(JSON 容错:坏配置按非 once 走 advance 常规推进) */
function isOnceSchedule(scheduleJson: string): boolean {
  try {
    const cfg = JSON.parse(scheduleJson) as ScheduleConfig;
    return cfg.mode === "periodic" && cfg.kind === "once";
  } catch {
    return false;
  }
}

/** 补跑上限读取:行缺列/脏数据回退 1(=既有 catchUpOnce 只补一次行为) */
function catchUpLimitOf(task: { catchUpLimit?: number | null }): number {
  return typeof task.catchUpLimit === "number" &&
    Number.isFinite(task.catchUpLimit)
    ? Math.min(
        Math.max(Math.round(task.catchUpLimit), DEFAULT_CATCH_UP_LIMIT),
        MAX_CATCH_UP_LIMIT,
      )
    : DEFAULT_CATCH_UP_LIMIT;
}

/** 决策树纯函数(spec §4;once 已跑过 = expire;missedCatchUps = 本进程
 * 已按 catchUp 补跑的次数——错过窗口多轮触发按 catchUpLimit 上限依次补,
 * 预算耗尽走 advance 跳到未来触发点) */
export function decideTick(
  task: AutomationTaskRow,
  now: Date,
  processStartTime: Date,
  missedCatchUps = 0,
): TickDecision {
  if (task.startAt && now < task.startAt) {
    return "noop";
  }
  if (task.endAt && now > task.endAt) {
    return "expire";
  }
  if (!task.nextRunAt) {
    // once:从未跑过且 runAt 已过也走 expire 由 runner 不再触发;此处仅到期回收
    return "expire";
  }
  if (now < task.nextRunAt) {
    return "noop";
  }
  if (task.lastRunAt && task.lastRunAt >= task.nextRunAt) {
    // once 已跑过(runAt 过期)无下个触发点,computeNextRun 只会返回 null——
    // 与其 advance 落 NULL 再等下个 tick 回收,直接终态 expire(用例:once → expire)
    return isOnceSchedule(task.scheduleJson) ? "expire" : "advance";
  }
  return task.nextRunAt < processStartTime
    ? task.missedPolicy === "catchUpOnce"
      ? missedCatchUps < catchUpLimitOf(task)
        ? "catchUp"
        : "advance"
      : "skip"
    : "execute";
}

/** 重试扫描纯函数:failed && attempt<3 && 冷却到期 && 错误可重试。
 * 冷却按 attempt 指数退避(nextRetryDelay 60/180/540s,批3A §6-4);
 * AUTH_FAILED/MODEL_NOT_FOUND/IMAGE_UNSUPPORTED 配置类不重试(重试无益);
 * delayMs 覆盖:undefined=退避缺省,0=不看冷却(tick 预算集) */
export function pickRetryTaskIds(
  latestRunByTask: Map<
    number,
    { status: string; attempt: number; finishedAt?: Date; error?: string | null }
  >,
  now: Date,
  delayMs?: number,
): number[] {
  const ids: number[] = [];
  for (const [taskId, run] of latestRunByTask) {
    if (run.status !== "failed" || run.attempt >= MAX_ATTEMPT || !run.finishedAt) {
      continue;
    }
    if (!isRetryableRunError(run.error)) {
      continue;
    }
    const cooldown = delayMs !== undefined ? delayMs : nextRetryDelay(run.attempt);
    if (now.getTime() - run.finishedAt.getTime() < cooldown) {
      continue;
    }
    ids.push(taskId);
  }
  return ids;
}

export default class AutomationScheduler {
  private timer?: NodeJS.Timeout;
  private processStartTime = new Date();
  // 工具禁用清单闭包（SP6 裁定 2）：Application 在 start 时注入（scheduler
  // 类字段初始化早于 registerServices 建 securityService，构造注入不可行）；
  // 缺省不滤（测试），调度执行与 runNow 手动触发同一过滤
  private disabledTools: () => string[] = () => [];

  start(disabledTools?: () => string[]): void {
    if (disabledTools) {
      this.disabledTools = disabledTools;
    }
    // 崩溃残留:running 的 run 全部置 failed(interrupted)(spec §7)。
    // catch 兜底（2026-11-01 审查快修，server 同款）：启动期 DB 抖动时
    // 不产生 unhandled rejection
    void this.recoverInterruptedRuns().catch((e) =>
      Log.error("启动中断恢复失败:", e),
    );
    // 执行历史保留裁剪：启动即裁一次（option 配置实时读，改配置无需重启）
    void maybeTrimAutomationRuns(prisma);
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_MS);
    Log.info("自动化调度器已启动");
    // 启动事件(spec §5):appStarted 触发的任务在本次发布中拉起
    void publishAutomationEvent({ source: "appStarted" });
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
    const result = await prisma.automationRun.updateMany({
      where: { status: "running" },
      data: { status: "failed", error: "interrupted", finishedAt: new Date() },
    });
    if (result.count > 0) {
      Log.info(`回收中断运行记录 ${result.count} 条`);
    }
  }

  private async tick(): Promise<void> {
    try {
      // 只调度 enabled+active:once 到期后 runner 的 advanceTask 置
      // status="expired" 但不动 enabled,不滤 status 会让 expire 分支每 30s
      // 重写该行(updatedAt 抖动)并向全窗口广播,前端无谓 invalidate 重拉;
      // error 任务已被 enabled=false 滤掉,重新启用时 repo toggle 置回
      // active——故 active+enabled 是唯一应参与调度的集合(applyDecision
      // 的 expire 分支保留,首次到期仍生效)
      const tasks = await prisma.automationTask.findMany({
        where: { enabled: true, status: "active" },
      });
      const { latestByTask, catchUpCounts } = await this.loadRunSnapshots();
      // 重试预算集(最新 run failed 且 attempt<3 可重试;delayMs=0 不看冷却,
      // 冷却期内同样不许 expire):once 非系统失败后 nextRunAt=null、status 仍
      // active,若决策树 !nextRunAt 先行 expire,任务会被上面的 active 过滤
      // 出局、永远等不到 scanRetries——故 expire 让路;attempt 耗尽后不再
      // 入选,由 !nextRunAt 分支兜底置 expired 收尾(spec §7 闭环)
      const retryPending = new Set(pickRetryTaskIds(latestByTask, new Date(), 0));
      let changed = false;
      for (const task of tasks) {
        // 在途执行不决策(含 runNow 手动触发):防重试运行中被过期快照误
        // expire/重复触发
        if (inflight.has(task.id)) {
          continue;
        }
        // 补跑计数:本进程内已按 catchUp 触发的 run 数(错过窗口补跑上限
        // catchUpLimit 判定依据,批3A §6-1)
        const decision = decideTick(
          task,
          new Date(),
          this.processStartTime,
          catchUpCounts.get(task.id) ?? 0,
        );
        if (decision === "noop") {
          continue;
        }
        if (decision === "expire" && retryPending.has(task.id)) {
          continue;
        }
        changed = true;
        await this.applyDecision(task, decision);
      }
      await this.scanRetries(latestByTask);
      if (changed) {
        // CRUD 批：tick 聚合多任务变更无单一 taskId——0 = 列表级刷新信号
        emitAutomationChanged();
      }
    } catch (e) {
      Log.error("自动化调度 tick 异常", e);
    }
    // 6h 节流，命中时开销仅一次时间比较
    void maybeTrimAutomationRuns(prisma);
    // 每日统计 rollup(批3A §6-6):1h 节流,吞错不阻塞调度
    void maybeRollupAutomationStats(prisma);
  }

  private async applyDecision(
    task: AutomationTaskRow,
    decision: TickDecision,
  ): Promise<void> {
    const now = new Date();
    const schedule = JSON.parse(task.scheduleJson) as ScheduleConfig;
    switch (decision) {
      case "expire":
        await prisma.automationTask.update({
          where: { id: task.id },
          data: { status: "expired" },
        });
        return;
      case "advance": {
        const next = computeNextRun(schedule, now, task.lastRunAt ?? undefined);
        await prisma.automationTask.update({
          where: { id: task.id },
          data: { nextRunAt: next },
        });
        return;
      }
      case "skip":
        await prisma.automationRun.create({
          data: {
            taskId: task.id,
            triggerType: "schedule",
            status: "skipped",
            startedAt: now,
            finishedAt: now,
          },
        });
        await prisma.automationTask.update({
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
      case "execute":
        await this.launch(task, "schedule", 1);
        return;
      case "catchUp":
        // 补跑重放(批3A):以错过的触发点为调度相位基点——advanceTask 按
        // replayAt 推进 lastRunAt/nextRunAt,多轮错过窗口继续按触发点依次
        // 补(上限 catchUpLimit,决策树计数判定)。catchUp 决策必经
        // nextRunAt 非空分支(decideTick !nextRunAt 先行 expire),null 仅
        // 类型面兜底
        await this.launch(
          task,
          "catchUp",
          1,
          undefined,
          task.nextRunAt ?? undefined,
        );
        return;
    }
  }

  /** 每 taskId 取最新一条 run(id 倒序取 500 条内首个)+ 本进程 catchUp 补跑
   * 计数(批3A:决策七列——error 供可重试面判定,triggerType/startedAt 供
   * 补跑计数;graphTrace 大 JSON 仍不搬) */
  private async loadRunSnapshots(): Promise<{
    latestByTask: Map<
      number,
      { status: string; attempt: number; finishedAt?: Date; error?: string | null }
    >;
    catchUpCounts: Map<number, number>;
  }> {
    const runs = await prisma.automationRun.findMany({
      orderBy: { id: "desc" },
      take: 500,
      select: {
        taskId: true,
        status: true,
        attempt: true,
        finishedAt: true,
        error: true,
        triggerType: true,
        startedAt: true,
      },
    });
    const latest = new Map<
      number,
      { status: string; attempt: number; finishedAt?: Date; error?: string | null }
    >();
    const catchUpCounts = new Map<number, number>();
    for (const run of runs) {
      // 图试运行 run(taskId=null)不挂任务,不参与任务重试决策
      if (run.taskId === null) {
        continue;
      }
      if (!latest.has(run.taskId)) {
        latest.set(run.taskId, {
          status: run.status,
          attempt: run.attempt,
          finishedAt: run.finishedAt ?? undefined,
          error: run.error,
        });
      }
      // 仅本进程(≥ processStartTime)的 catchUp run 计入补跑预算;上一
      // 进程的补跑不占本窗口预算(重启即新窗口)
      if (
        run.triggerType === "catchUp" &&
        run.startedAt >= this.processStartTime
      ) {
        catchUpCounts.set(
          run.taskId,
          (catchUpCounts.get(run.taskId) ?? 0) + 1,
        );
      }
    }
    return { latestByTask: latest, catchUpCounts };
  }

  /** 重试扫描:按 run 反查 taskId 独立取任务行(不复用 tick 调度快照——once 失败任务 nextRunAt 已推进,仍需可重试) */
  private async scanRetries(
    latestRun: Map<
      number,
      { status: string; attempt: number; finishedAt?: Date; error?: string | null }
    >,
  ): Promise<void> {
    const retryIds = pickRetryTaskIds(latestRun, new Date());
    if (retryIds.length === 0) {
      return;
    }
    // 独立查询同样限 active+enabled:once 失败任务 status 未置 expired 所以
    // 能入选;attempt 耗尽(=3)后 pickRetryTaskIds 不再给出,交由决策树收尾
    const tasks = await prisma.automationTask.findMany({
      where: { id: { in: retryIds }, enabled: true, status: "active" },
    });
    const byId = new Map(tasks.map((t) => [t.id, t]));
    for (const taskId of retryIds) {
      const task = byId.get(taskId);
      const attempt = (latestRun.get(taskId)?.attempt ?? 0) + 1;
      if (task) {
        // 错过窗口内的重试同样按触发点重放(补跑失败重试成功后继续补余量,
        // 批3A);正常触发点的重试 replayAt 缺省 = advanceTask 按 now 推进
        const replayAt =
          task.nextRunAt && task.nextRunAt < this.processStartTime
            ? task.nextRunAt
            : undefined;
        await this.launch(task, "retry", attempt, undefined, replayAt);
      }
    }
  }

  /** fire:不 await 完成,互斥已有则跳过(共享 inflight,含 runNow 手动触发)。
   * 收口发布 taskFinished(spec §5 链式事件源):outcome 在 finally 前取得,
   * .catch 兜异常按 failed 发布;finally 保持 inflight 清理 + notifyChanged。
   * triggerType 不含 event:事件触发由 event-bus 直调 executeTask(chainDepth
   * 防环在彼处),误经此处会以链深 1 重置防环。
   * replayAt(批3A):调度相位重放基点(错过补跑)——advanceTask 按「仿佛在
   * 该触发点跑过」推进 lastRunAt/nextRunAt,缺省按 now 常规推进 */
  private launch(
    task: AutomationTaskRow,
    triggerType: "schedule" | "catchUp" | "retry",
    attempt: number,
    inputs?: Record<string, string>,
    replayAt?: Date,
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
      inputs,
      replayAt,
    })
      .catch((e): "failed" => {
        Log.error("自动化执行失败", task.id, e);
        return "failed";
      })
      .then((outcome) => {
        void publishAutomationEvent(taskFinishedEvent(task, outcome));
      })
      .finally(() => {
        inflight.delete(task.id);
        emitAutomationChanged(task.id);
      });
  }
}

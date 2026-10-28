/**
 * 调度器(spec §4):30s tick + 决策树 + 重试扫描。
 * 互斥:进程级 inflight 注册表(automation-inflight,与 repo runNow 手动
 * 触发共享,taskId → AbortController);退出 abort 全部在途。
 * 推送:执行/过期/异常后向全部窗口发 AUTOMATION_CHANGED_EVENT。
 */
import prisma from "../../../commons/prisma-client";
import Log from "../../../commons/Log";
import { computeNextRun } from "./schedule";
import { executeTask, type AutomationTaskRow } from "./automation-runner";
import { inflight } from "./automation-inflight";
import {
  publishAutomationEvent,
  taskFinishedEvent,
} from "./automation-event-bus";
import { maybeTrimAutomationRuns } from "./automation-retention";
import { emitAutomationChanged } from "./automation-change-bus";
import type { ScheduleConfig } from "../../../../src-react/domains/ai/automation/api/schedule.schema";

const TICK_MS = 30_000;
const RETRY_DELAY_MS = 60_000;
const MAX_ATTEMPT = 3;

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

/** 决策树纯函数(spec §4;once 已跑过 = expire) */
export function decideTick(
  task: AutomationTaskRow,
  now: Date,
  processStartTime: Date,
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
      ? "catchUp"
      : "skip"
    : "execute";
}

/** 重试扫描纯函数:failed && attempt<3 && finishedAt 早于 now-60s */
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
      run.status === "failed" &&
      run.attempt < MAX_ATTEMPT &&
      run.finishedAt &&
      now.getTime() - run.finishedAt.getTime() >= delayMs
    ) {
      ids.push(taskId);
    }
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
    // 崩溃残留:running 的 run 全部置 failed(interrupted)(spec §7)
    void this.recoverInterruptedRuns();
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
      const latestRun = await this.loadLatestRuns();
      // 重试预算集(最新 run failed 且 attempt<3;delayMs=0 不看 60s 冷却,
      // 冷却期内同样不许 expire):once 非系统失败后 nextRunAt=null、status 仍
      // active,若决策树 !nextRunAt 先行 expire,任务会被上面的 active 过滤
      // 出局、永远等不到 scanRetries——故 expire 让路;attempt 耗尽后不再
      // 入选,由 !nextRunAt 分支兜底置 expired 收尾(spec §7 闭环)
      const retryPending = new Set(pickRetryTaskIds(latestRun, new Date(), 0));
      let changed = false;
      for (const task of tasks) {
        // 在途执行不决策(含 runNow 手动触发):防重试运行中被过期快照误
        // expire/重复触发
        if (inflight.has(task.id)) {
          continue;
        }
        const decision = decideTick(task, new Date(), this.processStartTime);
        if (decision === "noop") {
          continue;
        }
        if (decision === "expire" && retryPending.has(task.id)) {
          continue;
        }
        changed = true;
        await this.applyDecision(task, decision);
      }
      await this.scanRetries(latestRun);
      if (changed) {
        // CRUD 批：tick 聚合多任务变更无单一 taskId——0 = 列表级刷新信号
        emitAutomationChanged();
      }
    } catch (e) {
      Log.error("自动化调度 tick 异常", e);
    }
    // 6h 节流，命中时开销仅一次时间比较
    void maybeTrimAutomationRuns(prisma);
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
        await this.launch(task, "catchUp", 1);
        return;
    }
  }

  /** 每 taskId 取最新一条 run(id 倒序取 500 条内首个) */
  private async loadLatestRuns(): Promise<
    Map<number, { status: string; attempt: number; finishedAt?: Date }>
  > {
    const runs = await prisma.automationRun.findMany({
      orderBy: { id: "desc" },
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
      // 图试运行 run(taskId=null)不挂任务,不参与任务重试决策
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

  /** 重试扫描:按 run 反查 taskId 独立取任务行(不复用 tick 调度快照——once 失败任务 nextRunAt 已被推进,仍需可重试) */
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
        await this.launch(task, "retry", attempt);
      }
    }
  }

  /** fire:不 await 完成,互斥已有则跳过(共享 inflight,含 runNow 手动触发)。
   * 收口发布 taskFinished(spec §5 链式事件源):outcome 在 finally 前取得,
   * .catch 兜异常按 failed 发布;finally 保持 inflight 清理 + notifyChanged。
   * triggerType 不含 event:事件触发由 event-bus 直调 executeTask(chainDepth
   * 防环在彼处),误经此处会以链深 1 重置防环 */
  private launch(
    task: AutomationTaskRow,
    triggerType: "schedule" | "catchUp" | "retry",
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
      inputs,
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

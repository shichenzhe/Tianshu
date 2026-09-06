/**
 * 调度器(spec §4):30s tick + 决策树 + 重试扫描。
 * 互斥:内存 Map<taskId, AbortController>;退出 abort 全部在途。
 * 推送:执行/过期/异常后向全部窗口发 automation:tasks-changed。
 */
import { BrowserWindow } from "electron";
import prisma from "../../../commons/prisma-client";
import Log from "../../../commons/Log";
import { computeNextRun } from "./schedule";
import { executeTask, type AutomationTaskRow } from "./automation-runner";
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
  private aborts = new Map<number, AbortController>();
  private processStartTime = new Date();

  start(): void {
    // 崩溃残留:running 的 run 全部置 failed(interrupted)(spec §7)
    void this.recoverInterruptedRuns();
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_MS);
    Log.info("自动化调度器已启动");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const abort of this.aborts.values()) {
      abort.abort();
    }
    this.aborts.clear();
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
      const tasks = await prisma.automationTask.findMany({
        where: { enabled: true },
      });
      let changed = false;
      for (const task of tasks) {
        const decision = decideTick(task, new Date(), this.processStartTime);
        if (decision === "noop") {
          continue;
        }
        changed = true;
        await this.applyDecision(task, decision);
      }
      await this.scanRetries(tasks);
      if (changed) {
        this.notifyChanged();
      }
    } catch (e) {
      Log.error("自动化调度 tick 异常", e);
    }
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

  private async scanRetries(tasks: AutomationTaskRow[]): Promise<void> {
    const runs = await prisma.automationRun.findMany({
      orderBy: { id: "desc" },
      take: 500,
    });
    const latest = new Map<
      number,
      { status: string; attempt: number; finishedAt?: Date }
    >();
    for (const run of runs) {
      if (!latest.has(run.taskId)) {
        latest.set(run.taskId, {
          status: run.status,
          attempt: run.attempt,
          finishedAt: run.finishedAt ?? undefined,
        });
      }
    }
    const byId = new Map(tasks.map((t) => [t.id, t]));
    for (const taskId of pickRetryTaskIds(latest, new Date())) {
      const task = byId.get(taskId);
      const attempt = (latest.get(taskId)?.attempt ?? 0) + 1;
      if (task && task.enabled) {
        await this.launch(task, "retry", attempt);
      }
    }
  }

  /** fire:不 await 完成,互斥已有则跳过 */
  private launch(
    task: AutomationTaskRow,
    triggerType: "schedule" | "catchUp" | "retry",
    attempt: number,
  ): void {
    if (this.aborts.has(task.id)) {
      return;
    }
    const abort = new AbortController();
    this.aborts.set(task.id, abort);
    void executeTask(task, { triggerType, attempt, abort: abort.signal })
      .catch((e) => Log.error("自动化执行失败", task.id, e))
      .finally(() => {
        this.aborts.delete(task.id);
        this.notifyChanged();
      });
  }

  private notifyChanged(): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("automation:tasks-changed");
    }
  }
}

/**
 * 事件触发总线（spec §5）：publish → 匹配 enabled+active 任务 → launch。
 * 防环：链深 >MAX_CHAIN_DEPTH 落 skipped(chain_depth_exceeded)；互斥复用 inflight。
 * 发布方（scheduler.launch / repo runNow）在 executeTask resolve 后调
 * publish，本模块不 import 它们——依赖单向：event-bus → runner。
 */
import prisma from "../../../commons/prisma-client";
import Log from "../../../commons/Log";
import { executeTask, type AutomationTaskRow } from "./automation-runner";
import { inflight } from "./automation-inflight";
import { emitAutomationChanged } from "./automation-change-bus";
import {
  eventJsonSchema,
  type EventTriggerConfig,
} from "../../../../src-react/domains/ai/orchestration/api/graph.schema";

export const MAX_CHAIN_DEPTH = 5;

/** 工具禁用清单闭包（SP6 裁定 2）：Application 注入（实时读安全配置），
 * 缺省不滤（测试）；事件触发的运行与调度/手动触发同一注入层过滤口径 */
let readDisabledTools: () => string[] = () => [];

/** 注入工具禁用闭包（scheduler.start 同款签名）：依赖保持单向
 * event-bus → runner，不反向 import Application/security */
export function setEventBusDisabledTools(fn: () => string[]): void {
  readDisabledTools = fn;
}

export type AutomationEvent =
  | { source: "appStarted" }
  | {
      source: "taskFinished";
      targetType: "task" | "graph";
      targetId: number;
      outcome: "success" | "failed";
    };

/** 事件匹配视图：publish 查询行的最小投影（纯函数单测主体） */
export type EventMatchableTask = Pick<
  AutomationTaskRow,
  "id" | "eventJson" | "enabled" | "status"
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
  event: AutomationEvent,
): EventTaskMatch[] {
  const hits: EventTaskMatch[] = [];
  for (const t of tasks) {
    if (!t.enabled || t.status !== "active" || !t.eventJson) {
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
    if (event.source === "taskFinished" && ev.source === "taskFinished") {
      if (
        ev.targetType !== event.targetType ||
        ev.targetId !== event.targetId
      ) {
        continue;
      }
      if (ev.on !== "any" && ev.on !== event.outcome) {
        continue;
      }
      hits.push({ task: t, inputs: { outcome: event.outcome } });
    } else if (event.source === "appStarted") {
      hits.push({ task: t, inputs: {} });
    }
  }
  return hits;
}

/** 事件触发未执行留痕：skipped run 行（链深超限/在途互斥两种错误码） */
async function recordSkippedRun(
  taskId: number,
  errorCode: string,
): Promise<void> {
  const now = new Date();
  await prisma.automationRun.create({
    data: {
      taskId,
      triggerType: "event",
      status: "skipped",
      error: errorCode,
      startedAt: now,
      finishedAt: now,
    },
  });
}

/** run 收官事件源：graph 任务以图为目标（targetId=graphId），prompt 任务以
 * 任务自身为目标（targetId=taskId）——scheduler.launch / repo runNow 同口径 */
export function taskFinishedEvent(
  task: AutomationTaskRow,
  outcome: "success" | "failed",
): AutomationEvent {
  return task.targetKind === "graph"
    ? {
        source: "taskFinished",
        targetType: "graph",
        targetId: task.graphId ?? 0,
        outcome,
      }
    : {
        source: "taskFinished",
        targetType: "task",
        targetId: task.id,
        outcome,
      };
}

/**
 * 事件发布（spec §5）：查 enabled+active+eventJson 任务 → 匹配 → 逐个
 * 执行（互斥复用 inflight）。链式：event 触发的 run 完成同样成为
 * taskFinished 源（chainDepth+1 透传），深度 >MAX_CHAIN_DEPTH 落
 * skipped(chain_depth_exceeded) 终止传播。异常全吞（绝不向发布方抛）。
 */
export async function publishAutomationEvent(
  event: AutomationEvent,
  chainDepth = 1,
): Promise<void> {
  try {
    const tasks = await prisma.automationTask.findMany({
      where: { enabled: true, status: "active", eventJson: { not: null } },
    });
    for (const { task, inputs } of matchEventTasks(tasks, event)) {
      if (chainDepth > MAX_CHAIN_DEPTH) {
        await recordSkippedRun(task.id, "chain_depth_exceeded");
        continue;
      }
      if (inflight.has(task.id)) {
        await recordSkippedRun(task.id, "event_skipped_running");
        continue;
      }
      const abort = new AbortController();
      inflight.set(task.id, abort);
      // findMany 全行，Pick 仅为匹配视图——此处还原全行
      const full = task as AutomationTaskRow;
      const outcome = await executeTask(full, {
        triggerType: "event",
        attempt: 1,
        abort: abort.signal,
        disabledTools: readDisabledTools,
        inputs,
      }).catch(() => "failed" as const);
      inflight.delete(task.id);
      // 收官广播（spec §5 继承 scheduler 收官口径）：事件路径不经
      // scheduler.launch 的 finally，这里自补——渲染层列表/面板即时刷新
      // + 进程级订阅扇出（CRUD 批：face 桥 → automation.changed 远程端）
      emitAutomationChanged(task.id);
      // 链式发布：event 触发的 run 完成同样成为 taskFinished 源（spec §5）
      await publishAutomationEvent(
        taskFinishedEvent(full, outcome),
        chainDepth + 1,
      );
    }
  } catch (e) {
    Log.error("自动化事件触发异常", e);
  }
}

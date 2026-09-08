/**
 * 自动化任务在途互斥注册表(spec §4 互斥):taskId → 本次执行的
 * AbortController。scheduler 调度触发与 repo runNow 手动触发共用,
 * 同一任务任意时刻至多一个在途执行(防重复会话/full 模式重复写盘);
 * 执行收口(.finally)删除条目,退出由 scheduler.stop 统一 abort 清空。
 */
export const inflight = new Map<number, AbortController>();

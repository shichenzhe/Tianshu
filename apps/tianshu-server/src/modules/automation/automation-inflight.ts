/**
 * 自动化任务在途互斥注册表（自 mirror
 * electron/domains/ai/automation/automation-inflight.ts 逐行摘取，GA-T5）：
 * taskId → 本次执行的 AbortController。scheduler 调度触发与 repo runNow
 * 手动触发共用，同一任务任意时刻至多一个在途执行（防重复会话/full 模式
 * 重复写盘）；执行收口（.finally）删除条目，退出由 scheduler.stop 统一
 * abort 清空。零逻辑改动（无 Electron/prisma 依赖，直摘）。
 */
export const inflight = new Map<number, AbortController>();

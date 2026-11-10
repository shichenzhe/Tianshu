/**
 * 自动化健康度总览聚合（spec §6）——2026-11-10 收编 @tianshu/core 单源
 * （automation-stats.ts），本文件为薄壳 re-export：桌面主进程 IPC
 * automation:stats 聚合（automation.repo 消费）与渲染层远程态适配器
 * （remote-catalog 消费 automation/stats 原始行端点）同源同口径。
 */
export {
  computeStats,
  type AutomationStats,
  type StatsRunRow,
  type StatsErrorTask,
  type StatsRollupDay,
  type StatsRunStatus,
} from "@tianshu/core/automation-stats";

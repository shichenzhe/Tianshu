// src-react/domains/ai/monitor/api/monitor.api.ts
/**
 * 监控页 API（IPC 封装）+ 统计类型（主进程 monitor-stats 经此 import，
 * automation-stats 先例：类型以前端 api 文件为单一事实源）。
 */
import { invoke } from "@/lib/ipc";
import type { MonitorScene, MonitorStats } from "@tianshu/protocol";

export type { MonitorScene, MonitorStats };

export const MonitorApi = {
  stats: (scene?: MonitorScene) => invoke<MonitorStats>("monitor:stats", scene),
};

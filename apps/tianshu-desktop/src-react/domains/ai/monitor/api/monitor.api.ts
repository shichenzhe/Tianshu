// src-react/domains/ai/monitor/api/monitor.api.ts
/**
 * 监控页 API + 统计类型（协议包 @tianshu/protocol 单源 re-export，
 * automation-stats 先例：前端 api 文件为类型出口）。
 * P0-1（2026-11-05，spec monitoring.md §6）：stats 已主机路由化——本地
 * invoke monitor:stats 参数逐字零行为变化；远程走 ServerApi.monitorStats
 * （server:monitorStats 透传 POST monitor/stats，被控面端点与 capability
 * 位两侧均齐备）。UI 组件对路由透明（MonitorApi 形状不变）。
 */
import { invoke } from "@/lib/ipc";
import { routeInvoke } from "@/domains/ai/data-source/host-route";
import ServerApi from "@/domains/ai/server/api/server.api";
import type { MonitorScene, MonitorStats } from "@tianshu/protocol";

export type { MonitorScene, MonitorStats };

export const MonitorApi = {
  stats: (scene?: MonitorScene) =>
    routeInvoke<MonitorStats>(
      { ch: "monitor:stats", args: [scene] },
      (connId) => ServerApi.monitorStats(scene, connId),
    ),
};

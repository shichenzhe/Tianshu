/**
 * 技能管理 API(IPC 封装)。类型由后端 SkillRepository 反向复用。
 * HD-P2b 主机路由化：list/readSkill/setEnabled 本地 invoke 原通道
 * 参数逐字；远程走 skillsQuery/skillsRead/skillsSetEnabled（形状转换
 * 见 data-source/remote-catalog）。其余方法（安装/卸载/打标/导入/
 * 文件选择/统计）为文件系统面，本地专属——管理页远程态整页门控。
 */
import { invoke } from "@/lib/ipc";
import { routeInvoke } from "@/domains/ai/data-source/host-route";
import * as remote from "@/domains/ai/data-source/remote-catalog";
import ServerApi from "@/domains/ai/server/api/server.api";
import type { InstallResult, InspectResult } from "./skillhub-types";

export interface SkillRecord {
  id: number;
  name: string;
  slug: string | null;
  version: string | null;
  source: string;
  dir: string;
  description: string | null;
  enabled: boolean;
  installedAt: string;
  /** 场景打标(JSON 反序列化产物;null=未打标),Task 10 胶囊混排消费 */
  scenarios: string[] | null;
}

export interface BatchUninstallResult {
  succeeded: string[];
  failed: Array<{ name: string; reason: string }>;
}

/** 文件选择器结果:取消/未选 → canceled:true */
export type PickImportResult =
  { canceled: true } | { canceled: false; path: string };

/**
 * 技能埋点聚合项(与 electron/domains/ai/skill/skill-stats.ts 的
 * SkillStatItem 保持同步;独立声明避免渲染进程 import 主进程模块)
 */
export interface SkillStatItem {
  name: string;
  installs: number;
  creates: number;
  enables: number;
  disables: number;
  uninstalls: number;
  batchOps: number;
  lastActiveAt: string;
}

export interface SkillStatsResult {
  items: SkillStatItem[];
}

export const SkillApi = {
  list: () =>
    routeInvoke({ ch: "skill:list", args: [] }, (connId) =>
      remote.remoteSkillList(connId),
    ),
  setEnabled: (name: string, enabled: boolean) =>
    routeInvoke(
      { ch: "skill:setEnabled", args: [{ name, enabled }] },
      (connId) => ServerApi.skillsSetEnabled(name, enabled, connId),
    ),
  setScenarios: (name: string, scenarios: string[]) =>
    invoke<null>("skill:setScenarios", { name, scenarios }),
  batchSetEnabled: (names: string[], enabled: boolean) =>
    invoke<null>("skill:batchSetEnabled", { names, enabled }),
  uninstall: (name: string) => invoke<null>("skill:uninstall", { name }),
  batchUninstall: (names: string[]) =>
    invoke<BatchUninstallResult>("skill:batchUninstall", { names }),
  /** 本地导入(zip 文件或技能目录);dryRun 只做校验/冲突预检,不落盘不写库;
   *  scenarios=导入弹窗当场打标(空数组=显式不打标,未传=保持已有标不覆盖) */
  importSkill: (params: {
    path: string;
    overwrite?: boolean;
    dryRun?: boolean;
    scenarios?: string[];
  }) => invoke<InstallResult | InspectResult>("skill:import", params),
  /** 拉起系统文件选择器选 zip 文件或目录 */
  pickImport: () => invoke<PickImportResult>("skill:pickImport"),
  /** 埋点聚合查询(P-E:name 升序;暂无 UI 消费,api 层备好) */
  stats: () => invoke<SkillStatsResult>("skill:stats"),
  /** @ 引用读取:按名读 SKILL.md 正文(≤256KB 截断) */
  readSkill: (name: string) =>
    routeInvoke(
      { ch: "skill:readSkill", args: [{ name }] },
      (connId) =>
        ServerApi.skillsRead(name, connId) as Promise<{ content: string }>,
    ),
};

export default SkillApi;

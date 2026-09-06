/**
 * 技能管理 API(IPC 封装)。类型由后端 SkillRepository 反向复用
 */
import { invoke } from "@/lib/ipc";
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

const SkillApi = {
  list: () => invoke<SkillRecord[]>("skill:list"),
  setEnabled: (name: string, enabled: boolean) =>
    invoke<null>("skill:setEnabled", { name, enabled }),
  batchSetEnabled: (names: string[], enabled: boolean) =>
    invoke<null>("skill:batchSetEnabled", { names, enabled }),
  uninstall: (name: string) => invoke<null>("skill:uninstall", { name }),
  batchUninstall: (names: string[]) =>
    invoke<BatchUninstallResult>("skill:batchUninstall", { names }),
  /** 本地导入(zip 文件或技能目录);dryRun 只做校验/冲突预检,不落盘不写库 */
  importSkill: (params: {
    path: string;
    overwrite?: boolean;
    dryRun?: boolean;
  }) => invoke<InstallResult | InspectResult>("skill:import", params),
  /** 拉起系统文件选择器选 zip 文件或目录 */
  pickImport: () => invoke<PickImportResult>("skill:pickImport"),
  /** 埋点聚合查询(P-E:name 升序;暂无 UI 消费,api 层备好) */
  stats: () => invoke<SkillStatsResult>("skill:stats"),
  /** @ 引用读取:按名读 SKILL.md 正文(≤256KB 截断) */
  readSkill: (name: string) =>
    invoke<{ content: string }>("skill:readSkill", { name }),
};

export default SkillApi;

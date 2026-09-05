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
};

export default SkillApi;

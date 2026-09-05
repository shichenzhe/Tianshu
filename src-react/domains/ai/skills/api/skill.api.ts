/**
 * 技能管理 API(IPC 封装)。类型由后端 SkillRepository 反向复用
 */
import { invoke } from "@/lib/ipc";

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

const SkillApi = {
  list: () => invoke<SkillRecord[]>("skill:list"),
  setEnabled: (name: string, enabled: boolean) =>
    invoke<null>("skill:setEnabled", { name, enabled }),
  batchSetEnabled: (names: string[], enabled: boolean) =>
    invoke<null>("skill:batchSetEnabled", { names, enabled }),
  uninstall: (name: string) => invoke<null>("skill:uninstall", { name }),
  batchUninstall: (names: string[]) =>
    invoke<BatchUninstallResult>("skill:batchUninstall", { names }),
};

export default SkillApi;

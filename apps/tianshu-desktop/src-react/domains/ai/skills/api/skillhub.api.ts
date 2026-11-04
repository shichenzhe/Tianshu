/**
 * SkillHub 市场 API(IPC 封装)
 */
import { invoke } from "@/lib/ipc";
import type {
  InstallResult,
  SkillHubCategory,
  SkillHubListParams,
  SkillHubPage,
  SkillHubSkill,
} from "./skillhub-types";

const SkillHubApi = {
  list: (params: SkillHubListParams) =>
    invoke<SkillHubPage>("skillhub:list", params),
  top: () => invoke<SkillHubSkill[]>("skillhub:top"),
  categories: () => invoke<SkillHubCategory[]>("skillhub:categories"),
  /** 市场下载安装(主进程取版本 + 下载 zip + 落盘入库) */
  install: (params: { slug: string; overwrite?: boolean }) =>
    invoke<InstallResult>("skillhub:install", params),
};

export default SkillHubApi;

export type {
  InstallResult,
  SkillHubCategory,
  SkillHubListParams,
  SkillHubPage,
  SkillHubSkill,
};

/**
 * SkillHub 市场 API(IPC 封装)
 */
import { invoke } from "@/lib/ipc";
import type {
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
};

export default SkillHubApi;

export type {
  SkillHubCategory,
  SkillHubListParams,
  SkillHubPage,
  SkillHubSkill,
};

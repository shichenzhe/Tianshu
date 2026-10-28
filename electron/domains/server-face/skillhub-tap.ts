// A3 技能市场批（spec 2026-10-26 §1.3）：skillhub 四端点桥——走
// SkillRepository 持有的 SkillHubClient/SkillInstaller（宿主侧下载 zip
// 落盘，手机零流量；client 构造零 GUI 依赖——node:crypto/os + Constants）。
// 远端不可用/安装失败统一收 SKILLHUB_UNAVAILABLE 稳定码。skillhub 能力位
// 走 DESKTOP_CAPABILITIES 广告——无头端不报，移动端市场区降级隐藏。
import type {
  SkillHubCategoryDto,
  SkillHubDetailDto,
  SkillHubListPayload,
  SkillHubPageDto,
  SkillHubSkillDto,
  SkillInstallResultDto,
  SkillErrorCode,
} from "@tianshu/protocol";
import type { SkillRepository } from "../ai/skill/skill.repo";
import type { ServerFaceSkillHub } from "./deps";

/** skillhub 面业务错（code 稳定——routes 侧转 bizError 信封） */
export class FaceSkillHubError extends Error {
  readonly code: SkillErrorCode;
  constructor(code: SkillErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** 桥接的仓储方法子集（SkillRepository 满足——hub/installer 经其持有） */
export type SkillHubRepoSubset = Pick<
  SkillRepository,
  | "listHubSkills"
  | "listHubTop"
  | "listHubCategories"
  | "installFromHub"
  | "getHubSkillDetail"
>;

export function createSkillHubFace(
  repo: SkillHubRepoSubset,
): ServerFaceSkillHub {
  const wrap = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new FaceSkillHubError("SKILLHUB_UNAVAILABLE", message);
    }
  };
  return {
    list: (params: SkillHubListPayload) =>
      wrap<SkillHubPageDto>(() => repo.listHubSkills(params)),
    top: () => wrap<SkillHubSkillDto[]>(() => repo.listHubTop()),
    categories: () =>
      wrap<SkillHubCategoryDto[]>(() => repo.listHubCategories()),
    install: (slug: string, overwrite: boolean) =>
      wrap<SkillInstallResultDto>(() => repo.installFromHub(slug, overwrite)),
    detail: (slug: string) =>
      wrap<SkillHubDetailDto>(() => repo.getHubSkillDetail(slug)),
  };
}

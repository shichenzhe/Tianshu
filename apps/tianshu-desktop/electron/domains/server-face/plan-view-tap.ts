// A7 项目批（spec 2026-10-26 §2.2）：桌面被控面 planView 只读桥——
// PlanViewRepository 历史裸暴露（ipcMain.handle 无 userId 参数），远程化
// 前提起见逐方法补可见性守卫：先经 ProjectRepository.assertProjectVisible
// （owner 或成员，否则 PROJECT_NOT_FOUND 同桌面「不可见与不存在统一」口径），
// 再调 repo.list（懒播种语义沿用）。守卫集中在 tap 层单测全覆盖（spec §4）。
import type PlanViewRepository from "../project/plan-view.repo";
import type ProjectRepository from "../project/project.repo";
import type { ServerFacePlanView } from "./deps";
import { toFaceProjectError } from "./project-tap";

/** 可见性守卫来源（ProjectRepository.assertProjectVisible 子集） */
type ProjectGuard = Pick<ProjectRepository, "assertProjectVisible">;
type PlanViewRepoSubset = Pick<PlanViewRepository, "list">;

export function createPlanViewFace(
  projectRepo: ProjectGuard,
  viewRepo: PlanViewRepoSubset,
): ServerFacePlanView {
  return {
    list: async (userId, projectId) => {
      await projectRepo
        .assertProjectVisible(projectId, userId)
        .catch(toFaceProjectError);
      return viewRepo.list(projectId).catch(toFaceProjectError);
    },
  };
}

// A7 项目批（spec 2026-10-26 §2.2）：桌面被控面 planView 桥——
// PlanViewRepository 历史裸暴露（ipcMain.handle 无 userId 参数），远程化
// 前提起见逐方法补可见性守卫：先经 ProjectRepository.assertProjectVisible
// （owner 或成员，否则 PROJECT_NOT_FOUND 同桌面「不可见与不存在统一」口径）
// 再调 repo。list 懒播种语义沿用；写面四方法（2026-11-05 批）中
// update/remove/reorder 按 id 操作——先经 repo.getViewById 解析归属项目
// 再守卫（视图不存在 PLAN_VIEW_NOT_FOUND，不泄露存在性）。
import type PlanViewRepository from "../project/plan-view.repo";
import type ProjectRepository from "../project/project.repo";
import type {
  PlanViewCreatePayload,
  PlanViewReorderPayload,
  PlanViewUpdatePayload,
} from "@tianshu/protocol";
import type { ServerFacePlanView } from "./deps";
import { FaceProjectError, toFaceProjectError } from "./project-tap";

/** 可见性守卫来源（ProjectRepository.assertProjectVisible 子集） */
type ProjectGuard = Pick<ProjectRepository, "assertProjectVisible">;
type PlanViewRepoSubset = Pick<
  PlanViewRepository,
  "list" | "getViewById" | "create" | "update" | "remove" | "reorder"
>;

/** 视图 id → 归属项目守卫（不存在/不可见统一码，不泄露存在性） */
async function assertViewVisible(
  projectRepo: ProjectGuard,
  viewRepo: Pick<PlanViewRepository, "getViewById">,
  userId: number,
  viewId: number,
): Promise<void> {
  const view = await viewRepo.getViewById(viewId);
  if (view === null) {
    throw new FaceProjectError("PLAN_VIEW_NOT_FOUND", "视图不存在");
  }
  await projectRepo
    .assertProjectVisible(view.projectId, userId)
    .catch(toFaceProjectError);
}

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
    create: async (userId, projectId, params) => {
      await projectRepo
        .assertProjectVisible(projectId, userId)
        .catch(toFaceProjectError);
      return viewRepo
        .create({ ...params, projectId })
        .catch(toFaceProjectError);
    },
    update: async (userId, params: PlanViewUpdatePayload) => {
      await assertViewVisible(projectRepo, viewRepo, userId, params.id);
      await viewRepo.update(params).catch(toFaceProjectError);
    },
    remove: async (userId, id) => {
      await assertViewVisible(projectRepo, viewRepo, userId, id);
      await viewRepo.remove(id).catch(toFaceProjectError);
    },
    reorder: async (userId, items: PlanViewReorderPayload["items"]) => {
      for (const item of items) {
        await assertViewVisible(projectRepo, viewRepo, userId, item.id);
      }
      await viewRepo.reorder(items).catch(toFaceProjectError);
    },
  };
}

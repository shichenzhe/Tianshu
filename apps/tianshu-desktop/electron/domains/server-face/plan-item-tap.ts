// A7 项目批（spec 2026-10-26 §2.2）：桌面被控面 planItem 十端点桥——
// 复用 PlanItemRepository 单实例（userId 校验/枚举校验/成员资格校验
// repo 自带，tap 只做 userId 前置序适配 + 稳定码转 FaceProjectError；
// DTO 与桌面记录同形直传——日期 repo 侧已 ISO 串行化）。
import type PlanItemRepository from "../project/plan-item.repo";
import type { ServerFacePlanItem } from "./deps";
import { toFaceProjectError } from "./project-tap";

/** 桥接的仓储方法子集（PlanItemRepository 满足） */
type PlanItemRepoSubset = Pick<
  PlanItemRepository,
  | "list"
  | "listMine"
  | "create"
  | "update"
  | "remove"
  | "move"
  | "listFields"
  | "listAttachments"
  | "createAttachment"
  | "removeAttachment"
>;

export function createPlanItemFace(
  repo: PlanItemRepoSubset,
): ServerFacePlanItem {
  return {
    list: (userId, projectId) =>
      repo.list(projectId, userId).catch(toFaceProjectError),
    listMine: (userId) => repo.listMine(userId).catch(toFaceProjectError),
    create: (userId, payload) =>
      repo.create(payload, userId).catch(toFaceProjectError),
    update: (userId, payload) =>
      repo.update(payload, userId).catch(toFaceProjectError),
    remove: (userId, id) => repo.remove(id, userId).catch(toFaceProjectError),
    move: (userId, payload) =>
      repo.move(payload, userId).catch(toFaceProjectError),
    listFields: (userId, projectId) =>
      repo.listFields(projectId, userId).catch(toFaceProjectError),
    listAttachments: (userId, planItemId) =>
      repo.listAttachments(planItemId, userId).catch(toFaceProjectError),
    createAttachment: (userId, planItemId, input) =>
      repo
        .createAttachment(planItemId, input, userId)
        .catch(toFaceProjectError),
    removeAttachment: (userId, id) =>
      repo.removeAttachment(id, userId).catch(toFaceProjectError),
  };
}

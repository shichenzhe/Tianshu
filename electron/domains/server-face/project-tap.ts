// A7 项目批（spec 2026-10-26 §2.2）：桌面被控面 project 六端点桥——
// 复用 ProjectRepository 单实例（Application 注入，严禁 face 侧二次构造
// ——构造函数注册全部 IPC handler）；getDetail 只回传 sessionId（不泄完整
// SessionRecord，聊天形状不耦合）；repo 抛出的稳定码（Error.message 即码）
// 转 FaceProjectError 透传（routes bizError 信封，控制端按码提示）。
import { PROJECT_ERROR_CODES } from "@tianshu/protocol";
import type { ProjectErrorCode } from "@tianshu/protocol";
import type ProjectRepository from "../project/project.repo";
import type { ServerFaceProject } from "./deps";

/** 项目域业务错（code 稳定——routes 侧转 bizError 信封，控制端判码提示） */
export class FaceProjectError extends Error {
  readonly code: ProjectErrorCode;
  constructor(code: ProjectErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** repo 抛出的稳定码 → FaceProjectError；非码错误原样抛出（routes 5000 兜底） */
export function toFaceProjectError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if ((PROJECT_ERROR_CODES as readonly string[]).includes(message)) {
    throw new FaceProjectError(message as ProjectErrorCode, message);
  }
  throw error;
}

/** 桥接的仓储方法子集（ProjectRepository 满足） */
type ProjectRepoSubset = Pick<
  ProjectRepository,
  "list" | "getDetail" | "create" | "update" | "remove" | "listMembers"
>;

export function createProjectFace(repo: ProjectRepoSubset): ServerFaceProject {
  return {
    query: (userId) => repo.list(userId).catch(toFaceProjectError),
    getDetail: async (userId, id) => {
      const detail = await repo.getDetail(id, userId).catch(toFaceProjectError);
      return {
        project: detail.project,
        assetWorkspaceId: detail.assetWorkspaceId,
        bindings: detail.bindings,
        sessionId: detail.session.id,
      };
    },
    create: (userId, payload) =>
      repo.create(payload, userId).catch(toFaceProjectError),
    update: (userId, payload) =>
      repo.update(payload, userId).catch(toFaceProjectError),
    remove: (userId, id) => repo.remove(id, userId).catch(toFaceProjectError),
    listMembers: (userId, projectId) =>
      repo.listMembers(projectId, userId).catch(toFaceProjectError),
  };
}

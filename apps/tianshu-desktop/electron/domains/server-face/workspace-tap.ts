// A8 工作空间管理批（spec 2026-10-26 §1.2）：桌面被控面 workspace 写面桥——
// create/update/delete 复用 SessionRepository 单实例（Application 注入，
// 严禁 face 侧二次构造——构造函数注册全部 IPC handler）；delete 沿用桌面
// 既有硬级联语义（消息→会话→工作空间行，不删磁盘，repo 内聚不新造）；
// 不带 directoryPath 写面（绑定/解绑目录留桌面端，spec §1.4）。
// repo 稳定码（Error.message 即码）转 FaceWorkspaceError 透传——
// WORKSPACE_NOT_FOUND（归属校验）/WORKSPACE_INVALID（name 空等，tap 守卫）；
// 未知错误原样抛出（routes 5000 兜底）。
import {
  WORKSPACE_ERROR_CODES,
  type RemoteWorkspaceBrief,
  type WorkspaceErrorCode,
} from "@tianshu/protocol";
import type { SessionRepository } from "../ai/chat/session.repo";
import type { WorkspaceRecord } from "../../../src-react/domains/ai/api/workspace.api";
import type { ServerFaceWorkspaces } from "./deps";

/** 工作空间面业务错（code 稳定——routes 侧转 bizError 信封，控制端判码） */
export class FaceWorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  constructor(code: WorkspaceErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** 桥接的仓储方法子集（SessionRepository 满足；delete 硬级联语义 repo 内聚） */
export type WorkspaceRepoSubset = Pick<
  SessionRepository,
  "createWorkspace" | "updateWorkspace" | "deleteWorkspace"
>;

/** repo 抛出的稳定码 → FaceWorkspaceError；非码错误原样抛出（routes 5000 兜底） */
export function toFaceWorkspaceError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if ((WORKSPACE_ERROR_CODES as readonly string[]).includes(message)) {
    throw new FaceWorkspaceError(message as WorkspaceErrorCode, message);
  }
  throw error;
}

/** 仓储记录 → 概要四字段 DTO（RemoteWorkspaceBrief wire 契约——
 *  directoryPath 原值透出为既有契约行为，本批不动，spec §2） */
function toBrief(record: WorkspaceRecord): RemoteWorkspaceBrief {
  return {
    id: record.id,
    name: record.name,
    directoryPath: record.directoryPath ?? null,
    defaultModelId: record.defaultModelId ?? null,
  };
}

/** name 语义守卫：非空（trim 后）——空串/纯空白 → WORKSPACE_INVALID */
function assertNameValid(name: string | undefined): void {
  if (name !== undefined && name.trim() === "") {
    throw new FaceWorkspaceError("WORKSPACE_INVALID", "工作空间名称不能为空");
  }
}

/** A8 写面桥工厂：返回 create/update/remove 三方法（list 留在 ipc.ts
 *  既有直查——projectId 过滤/默认空间补建语义与 repo.listWorkspaces 不同，
 *  本批不动）；缺 repo（未注入）不装配，routes 侧报未装配 */
export function createWorkspaceFace(
  repo: WorkspaceRepoSubset,
): Pick<ServerFaceWorkspaces, "create" | "update" | "remove"> {
  return {
    create: async (userId, payload) => {
      try {
        if (!payload.name || payload.name.trim() === "") {
          throw new FaceWorkspaceError(
            "WORKSPACE_INVALID",
            "工作空间名称不能为空",
          );
        }
        return toBrief(
          await repo.createWorkspace(
            {
              name: payload.name.trim(),
              ...(payload.icon !== undefined ? { icon: payload.icon } : {}),
              ...(payload.defaultModelId !== undefined
                ? { defaultModelId: payload.defaultModelId }
                : {}),
            },
            userId,
          ),
        );
      } catch (error) {
        if (error instanceof FaceWorkspaceError) throw error;
        throw toFaceWorkspaceError(error);
      }
    },
    update: async (userId, payload) => {
      try {
        assertNameValid(payload.name);
        return toBrief(
          await repo.updateWorkspace(
            {
              id: payload.id,
              ...(payload.name !== undefined
                ? { name: payload.name.trim() }
                : {}),
              ...(payload.icon !== undefined ? { icon: payload.icon } : {}),
              ...(payload.defaultModelId !== undefined
                ? { defaultModelId: payload.defaultModelId }
                : {}),
            },
            userId,
          ),
        );
      } catch (error) {
        if (error instanceof FaceWorkspaceError) throw error;
        throw toFaceWorkspaceError(error);
      }
    },
    remove: async (userId, id) => {
      try {
        await repo.deleteWorkspace(id, userId);
      } catch (error) {
        throw toFaceWorkspaceError(error);
      }
    },
  };
}

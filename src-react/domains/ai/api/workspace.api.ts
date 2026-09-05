/**
 * 工作空间 API
 */

import { invoke } from "@/lib/ipc";

export interface WorkspaceRecord {
  id: number;
  name: string;
  icon?: string;
  directoryPath?: string;
  defaultModelId?: number;
  writeApprovedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceCreateParams {
  name: string;
  icon?: string;
  defaultModelId?: number;
}

export interface WorkspaceUpdateParams {
  id: number;
  name?: string;
  icon?: string;
  defaultModelId?: number;
}

export class WorkspaceApi {
  static async list(): Promise<WorkspaceRecord[]> {
    return invoke<WorkspaceRecord[]>("workspace:list");
  }

  static async create(params: WorkspaceCreateParams): Promise<WorkspaceRecord> {
    return invoke<WorkspaceRecord>("workspace:create", params);
  }

  static async update(params: WorkspaceUpdateParams): Promise<WorkspaceRecord> {
    return invoke<WorkspaceRecord>("workspace:update", params);
  }

  static async delete(id: number): Promise<void> {
    return invoke<void>("workspace:delete", id);
  }

  /** P1：弹系统目录选择框绑定工作空间目录；用户取消返回 null */
  static async bindDirectory(id: number): Promise<WorkspaceRecord | null> {
    return invoke<WorkspaceRecord | null>("workspace:bindDirectory", id);
  }

  /** P1：解绑工作空间目录（历史消息保留，仅收回 AI 的文件访问入口） */
  static async unbindDirectory(id: number): Promise<WorkspaceRecord | null> {
    return invoke<WorkspaceRecord | null>("workspace:unbindDirectory", id);
  }

  /** 打开空间绑定目录（任务上下文菜单「打开文件夹」） */
  static async openDirectory(workspaceId: number): Promise<void> {
    await invoke<void>("workspace:openDirectory", workspaceId);
  }
}

export default WorkspaceApi;

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
}

export default WorkspaceApi;

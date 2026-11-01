/**
 * 应用定义 API（聚合期核心，切片 C 2026-10-29）：类型同时供主进程 repo
 * import type。graphIds 传输面为 number[]（主进程 JSON 编解码存储）。
 */

import { invoke } from "@/lib/ipc";

export interface AppRecord {
  id: number;
  name: string;
  description?: string;
  /** 应用收录的工作流 id 集（JSON 数组存储，传输面已解码） */
  graphIds: number[];
  createdAt: string;
  updatedAt: string;
}

/** graphIds 入参为 JSON 数组字符串（与 repo parseGraphIds 对齐）或省略 */
export interface AppCreateParams {
  name: string;
  description?: string;
  graphIds?: string;
}

export interface AppUpdateParams {
  id: number;
  name?: string;
  description?: string | null;
  graphIds?: string;
}

export class AppApi {
  static async list(): Promise<AppRecord[]> {
    return invoke<AppRecord[]>("app:list");
  }

  static async create(params: AppCreateParams): Promise<AppRecord> {
    return invoke<AppRecord>("app:create", params);
  }

  static async update(params: AppUpdateParams): Promise<AppRecord> {
    return invoke<AppRecord>("app:update", params);
  }

  static async delete(id: number): Promise<void> {
    return invoke<void>("app:delete", id);
  }
}

export default AppApi;

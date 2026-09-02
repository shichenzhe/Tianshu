/**
 * 模型配置 API
 */

import { invoke } from "@/lib/ipc";

export interface ModelConfigRecord {
  id: number;
  name: string;
  modelName: string;
  apiKey: string;
  baseUrl: string;
  maxTokens?: number;
  temperature?: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ModelConfigCreateParams {
  name: string;
  apiKey: string;
  modelName: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
  isActive?: boolean;
}

export interface ModelConfigUpdateParams {
  id: number;
  name?: string;
  apiKey?: string;
  modelName?: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
  isActive?: boolean;
}

export class ModelConfigApi {
  /**
   * 获取模型配置列表
   */
  static async list(): Promise<ModelConfigRecord[]> {
    return invoke<ModelConfigRecord[]>("modelConfig:list");
  }

  /**
   * 根据ID获取模型配置
   */
  static async getById(id: number): Promise<ModelConfigRecord | null> {
    return invoke<ModelConfigRecord | null>("modelConfig:getById", id);
  }

  /**
   * 创建模型配置
   */
  static async create(
    params: ModelConfigCreateParams,
  ): Promise<ModelConfigRecord> {
    return invoke<ModelConfigRecord>("modelConfig:create", params);
  }

  /**
   * 更新模型配置
   */
  static async update(
    params: ModelConfigUpdateParams,
  ): Promise<ModelConfigRecord> {
    return invoke<ModelConfigRecord>("modelConfig:update", params);
  }

  /**
   * 删除模型配置
   */
  static async delete(id: number): Promise<void> {
    return invoke<void>("modelConfig:delete", id);
  }

  /**
   * 设置激活状态
   */
  static async setActive(id: number): Promise<void> {
    return invoke<void>("modelConfig:setActive", id);
  }

  /**
   * 测试模型配置
   */
  static async test(
    id: number,
  ): Promise<{ success: boolean; message: string }> {
    return invoke<{ success: boolean; message: string }>(
      "modelConfig:test",
      id,
    );
  }
}

export default ModelConfigApi;

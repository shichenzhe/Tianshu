/**
 * 模型 API
 */

import { invoke } from "@/lib/ipc";

export interface ModelRecord {
  id: number;
  providerId: number;
  modelId: string;
  name?: string;
  enabled: boolean;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  contextWindow?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ModelCreateParams {
  providerId: number;
  modelId: string;
  name?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  contextWindow?: number;
}

export interface ModelUpdateParams {
  id: number;
  modelId?: string;
  /** 可空字段：null 表示清空（undefined = 不修改） */
  name?: string | null;
  enabled?: boolean;
  temperature?: number | null;
  topP?: number | null;
  maxTokens?: number | null;
  contextWindow?: number | null;
}

export interface TestConnectionResult {
  success: boolean;
  errorCode?: string;
  message: string;
}

export interface OllamaRemoteModel {
  modelId: string;
}

export class ModelApi {
  static async listByProvider(providerId: number): Promise<ModelRecord[]> {
    return invoke<ModelRecord[]>("model:listByProvider", providerId);
  }

  static async listAll(): Promise<ModelRecord[]> {
    return invoke<ModelRecord[]>("model:listAll");
  }

  static async create(params: ModelCreateParams): Promise<ModelRecord> {
    return invoke<ModelRecord>("model:create", params);
  }

  static async update(params: ModelUpdateParams): Promise<ModelRecord> {
    return invoke<ModelRecord>("model:update", params);
  }

  static async delete(id: number): Promise<void> {
    return invoke<void>("model:delete", id);
  }

  static async test(id: number): Promise<TestConnectionResult> {
    return invoke<TestConnectionResult>("model:test", id);
  }

  static async listOllama(providerId: number): Promise<OllamaRemoteModel[]> {
    return invoke<OllamaRemoteModel[]>("model:listOllama", providerId);
  }
}

export default ModelApi;
